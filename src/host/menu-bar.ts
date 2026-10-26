import type { TraceEntry } from "../traces.js";
import type { Account, UsageWindow } from "../types.js";

export const GITHUB_STAR_OUTPUT_TOKEN_THRESHOLD = 5_000_000;

export type HostMenuBarQuotaWindow = {
  label?: string;
  remainingPercent: number;
  resetAt?: number;
};

/**
 * Absolute spendable credit reported by a pay-as-you-go provider. It is never
 * converted to a percentage because the provider exposes no reliable total.
 */
export type HostMenuBarBalance = {
  remaining: number;
  unit: string;
};

export type HostMenuBarProviderBalance = HostMenuBarBalance & {
  accountCount: number;
};

export type HostMenuBarAccount = {
  displayName: string;
  enabled: boolean;
  status: "ready" | "paused" | "attention" | "limited";
  usageStatus: "available" | "unsupported" | "pending";
  fetchedAt?: number;
  fiveHour?: HostMenuBarQuotaWindow;
  weekly?: HostMenuBarQuotaWindow;
  monthly?: HostMenuBarQuotaWindow;
  balance?: HostMenuBarBalance;
};

export type HostMenuBarQuotaAggregate = {
  fiveHourRemainingPercent?: number;
  fiveHourAccountCount: number;
  weeklyRemainingPercent?: number;
  weeklyAccountCount: number;
};

export type HostMenuBarAccountsSummary = {
  providers: HostMenuBarProvider[];
  accounts: HostMenuBarAccount[];
  quota: HostMenuBarQuotaAggregate;
};

export type HostMenuBarProvider = {
  id: string;
  displayName: string;
  accounts: HostMenuBarAccount[];
  windows: Array<{ label: string; remainingPercent: number; accountCount: number }>;
  balance?: HostMenuBarProviderBalance;
};

/**
 * Data-only extension contribution for the native menu. The Host renders this
 * descriptor with its own AppKit components; extensions cannot inject views,
 * HTML, arbitrary actions, or unbounded content into the popover.
 */
export type HostMenuBarExtensionWidget = {
  id: string;
  extensionId: string;
  title: string;
  subtitle?: string;
  systemImage?: string;
  presentation: "status" | "progress";
  label?: string;
  value?: string;
  detail?: string;
  badge?: string;
  progressPercent?: number;
};

const HOST_MENU_BAR_WIDGET_LIMIT = 4;

function boundedWidgetText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maximumLength) : undefined;
}

/**
 * Normalizes future extension contributions at the service boundary. The
 * empty default is intentional until the extension registry exposes widgets.
 */
export function buildHostMenuBarExtensionWidgets(
  source: readonly unknown[] = [],
): HostMenuBarExtensionWidget[] {
  const widgets: HostMenuBarExtensionWidget[] = [];
  const identifiers = new Set<string>();
  for (const candidate of source) {
    if (widgets.length >= HOST_MENU_BAR_WIDGET_LIMIT) break;
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const id = boundedWidgetText(record.id, 64);
    const extensionId = boundedWidgetText(record.extensionId, 64);
    const title = boundedWidgetText(record.title, 80);
    const presentation = record.presentation === "status" || record.presentation === "progress"
      ? record.presentation
      : undefined;
    if (!id || !extensionId || !title || !presentation) continue;
    const uniqueId = `${extensionId}:${id}`;
    if (identifiers.has(uniqueId)) continue;
    const rawProgress = typeof record.progressPercent === "number" && Number.isFinite(record.progressPercent)
      ? record.progressPercent
      : undefined;
    if (presentation === "progress" && rawProgress === undefined) continue;
    const subtitle = boundedWidgetText(record.subtitle, 100);
    const systemImage = boundedWidgetText(record.systemImage, 64);
    const label = boundedWidgetText(record.label, 80);
    const value = boundedWidgetText(record.value, 80);
    const detail = boundedWidgetText(record.detail, 160);
    const badge = boundedWidgetText(record.badge, 24);
    identifiers.add(uniqueId);
    widgets.push({
      id,
      extensionId,
      title,
      presentation,
      ...(subtitle ? { subtitle } : {}),
      ...(systemImage ? { systemImage } : {}),
      ...(label ? { label } : {}),
      ...(value ? { value } : {}),
      ...(detail ? { detail } : {}),
      ...(badge ? { badge } : {}),
      ...(rawProgress === undefined ? {} : { progressPercent: Math.max(0, Math.min(100, rawProgress)) }),
    });
  }
  return widgets;
}

export function hostMenuProviderId(account: Pick<Account, "provider" | "sdkProvider">): string {
  return account.provider === "ai-sdk" ? `ai-sdk:${account.sdkProvider || "unknown"}` : account.provider ?? "openai";
}

export function providerName(account: Account): string {
  return {
    openai: "OpenAI", opencode: "OpenCode", zai: "z.ai", mistral: "Mistral",
    "github-copilot": "GitHub Copilot", xai: "xAI", "openai-compatible": "OpenAI-compatible", "ai-sdk": account.sdkProvider || "AI SDK",
  }[account.provider ?? "openai"];
}

// Request counts use bounded per-second buckets rather than retaining traces or credentials.
const RECENT_USAGE_MS = 15 * 60 * 1000;
export function createHostMenuProviderActivityTracker() {
  const buckets = new Map<string, Map<number, { count: number; latest: number }>>();
  function prune(now: number) {
    for (const [id, seconds] of buckets) {
      for (const [second] of seconds) {
        if ((second + 1) * 1000 <= now - RECENT_USAGE_MS) seconds.delete(second);
      }
      if (!seconds.size) buckets.delete(id);
    }
  }
  function record(account: Pick<Account, "provider" | "sdkProvider">, now = Date.now()) {
    if (!Number.isFinite(now)) return;
    prune(now);
    const id = hostMenuProviderId(account);
    const seconds = buckets.get(id) ?? new Map<number, { count: number; latest: number }>();
    const second = Math.floor(now / 1000);
    const previous = seconds.get(second);
    seconds.set(second, { count: (previous?.count ?? 0) + 1, latest: Math.max(previous?.latest ?? now, now) });
    buckets.set(id, seconds);
  }
  function recordTrace(trace: TraceEntry, accounts: Account[], now = Date.now()) {
    if ((trace.traceKind !== undefined && trace.traceKind !== "upstream-attempt")
      || trace.isError || trace.status < 200 || trace.status >= 300
      || trace.lifecycleState === "started" || trace.lifecycleState === "interrupted") return;
    const account = accounts.find((account) => account.id === trace.accountId);
    if (account) record(account, now);
  }
  function get(now = Date.now(), eligibleIds?: string[]) {
    prune(now);
    let winner: { providerId: string; count: number; latest: number } | undefined;
    let usedAt = 0;
    for (const [providerId, seconds] of buckets) {
      if (eligibleIds && !eligibleIds.includes(providerId)) continue;
      let count = 0, latest = 0;
      for (const bucket of seconds.values()) {
        count += bucket.count;
        latest = Math.max(latest, bucket.latest);
      }
      usedAt = Math.max(usedAt, latest);
      if (!winner || count > winner.count || (count === winner.count && latest > winner.latest)) {
        winner = { providerId, count, latest };
      }
    }
    // The recommendation can change as buckets expire, without a new request.
    return winner ? { providerId: winner.providerId, usedAt } : undefined;
  }
  return { record, recordTrace, get };
}
const providerActivityTracker = createHostMenuProviderActivityTracker();
export const recordHostMenuProviderUsage = providerActivityTracker.record;
export const recordHostMenuTraceUsage = providerActivityTracker.recordTrace;
export const getHostMenuProviderActivity = providerActivityTracker.get;

function durationLabel(seconds: number): string {
  if (seconds === 604800) return "Weekly";
  if (seconds === 2592000) return "Monthly";
  const divisor = seconds >= 86400 ? 86400 : seconds >= 3600 ? 3600 : 60;
  return `${Number((seconds / divisor).toFixed(2))}${divisor === 86400 ? "d" : divisor === 3600 ? "h" : "m"}`;
}

function providerWindows(accounts: Account[]): HostMenuBarProvider["windows"] {
  const groups = new Map<string, { label: string; values: number[] }>();
  for (const account of accounts) {
    if (account.usage?.quotaStatus === "unsupported") continue;
    for (const [key, fallback, seconds] of [
      ["primary", "5h", 18000], ["secondary", "Weekly", 604800],
      ["monthly", "Monthly", 2592000], ["credits", "Credits", 0],
    ] as const) {
      const window = account.usage?.[key];
      const quota = quotaWindow(window);
      if (!quota) continue;
      const duration = finiteNumber(window?.windowSeconds);
      const label = duration && duration > 0 && duration !== seconds
        ? durationLabel(duration)
        : fallback;
      const groupKey = `${key}:${label}`;
      const group = groups.get(groupKey) ?? { label: key === "credits" && label !== fallback ? `Credits ${label}` : label, values: [] };
      group.values.push(quota.remainingPercent);
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()].map(({ label, values }) => ({
    label, remainingPercent: values.reduce((sum, value) => sum + value, 0) / values.length,
    accountCount: values.length,
  }));
}

export type HostMenuBarGitHubStarPrompt = {
  generatedOutputTokens: number;
  threshold: number;
  eligible: boolean;
};

export function buildHostMenuBarGitHubStarPrompt(
  generatedOutputTokens: unknown,
  threshold = GITHUB_STAR_OUTPUT_TOKEN_THRESHOLD,
): HostMenuBarGitHubStarPrompt {
  const normalizedOutputTokens = finiteNonNegativeInteger(generatedOutputTokens) ?? 0;
  const normalizedThreshold = finiteNonNegativeInteger(threshold) ??
    GITHUB_STAR_OUTPUT_TOKEN_THRESHOLD;
  return {
    generatedOutputTokens: normalizedOutputTokens,
    threshold: normalizedThreshold,
    eligible: normalizedOutputTokens >= normalizedThreshold,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : undefined;
}

function balanceSnapshot(balance?: { remaining?: number; unit?: string }): HostMenuBarBalance | undefined {
  const remaining = finiteNumber(balance?.remaining);
  const unit = typeof balance?.unit === "string" ? balance.unit.trim() : "";
  if (remaining === undefined || !unit) return undefined;
  return { remaining, unit };
}

/**
 * Credit-only providers report an absolute balance instead of quota windows.
 * Amounts are summed only when every account shares one unit; mixing currencies
 * would produce a number no provider ever reported.
 */
function providerBalance(accounts: Account[]): HostMenuBarProviderBalance | undefined {
  const entries = accounts.flatMap((account) => {
    const balance = balanceSnapshot(account.usage?.balance);
    return balance ? [balance] : [];
  });
  if (!entries.length) return undefined;
  const unit = entries[0].unit;
  if (!entries.every((entry) => entry.unit === unit)) return undefined;
  return {
    remaining: entries.reduce((sum, entry) => sum + entry.remaining, 0),
    unit,
    accountCount: entries.length,
  };
}

function quotaWindow(window?: UsageWindow): HostMenuBarQuotaWindow | undefined {
  const usedPercent = finiteNumber(window?.usedPercent);
  if (usedPercent === undefined) return undefined;
  const resetAt = finiteNumber(window?.resetAt);
  return {
    ...(window?.windowSeconds && Number.isFinite(window.windowSeconds) && window.windowSeconds > 0
      ? { label: durationLabel(window.windowSeconds) } : {}),
    remainingPercent: 100 - Math.max(0, Math.min(100, usedPercent)),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

function averageRemaining(windows: Array<HostMenuBarQuotaWindow | undefined>) {
  const available = windows.filter(
    (window): window is HostMenuBarQuotaWindow => window !== undefined,
  );
  if (!available.length) return undefined;
  return available.reduce((sum, window) => sum + window.remainingPercent, 0) /
    available.length;
}

function accountStatus(account: Account, now: number): HostMenuBarAccount["status"] {
  if (!account.enabled) return "paused";
  if (account.state?.needsTokenRefresh) return "attention";
  if (
    typeof account.state?.authBlockedUntil === "number" &&
    account.state.authBlockedUntil > now
  ) {
    return "attention";
  }
  if (
    Object.values(account.state?.modelBlocks ?? {}).some(
      (block) => Number.isFinite(block.until) && block.until > now,
    )
  ) {
    return "limited";
  }
  return "ready";
}

export function buildHostMenuBarAccountsSummary(
  source: Account[],
  now = Date.now(),
): HostMenuBarAccountsSummary {
  const openAIAccounts = source.filter(
    (account) => (account.provider ?? "openai") === "openai",
  );
  // Retain the legacy fields for older native clients, without mixing providers.
  const selectedAccounts = openAIAccounts.length ? openAIAccounts : source.filter(
    (account) => hostMenuProviderId(account) === (source[0] && hostMenuProviderId(source[0])),
  );
  const mapAccounts = (selectedAccounts: Account[]) => selectedAccounts.map((account, index): HostMenuBarAccount => {
    const provider = account.provider ?? "openai";
    const name = providerName(account);
    const email = account.email?.trim();
    const fiveHour = quotaWindow(account.usage?.primary);
    const weekly = quotaWindow(account.usage?.secondary);
    const monthly = quotaWindow(account.usage?.monthly);
    const balance = balanceSnapshot(account.usage?.balance);
    const fetchedAt = finiteNumber(account.usage?.fetchedAt);
    const hasQuota = Boolean(fiveHour || weekly || monthly || balance);
    return {
      displayName: email
        ? provider === "openai" ? email : `${name} · ${email}`
        : `${name} account ${index + 1}`,
      enabled: account.enabled,
      status: accountStatus(account, now),
      usageStatus: account.usage?.quotaStatus === "unsupported"
        ? "unsupported"
        : hasQuota
          ? "available"
          : "pending",
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      ...(fiveHour ? { fiveHour } : {}),
      ...(weekly ? { weekly } : {}),
      ...(monthly ? { monthly } : {}),
      ...(balance ? { balance } : {}),
    };
  });
  const accounts = mapAccounts(selectedAccounts);
  const providerGroups = new Map<string, Account[]>();
  for (const account of source) {
    const id = hostMenuProviderId(account);
    providerGroups.set(id, [...(providerGroups.get(id) ?? []), account]);
  }
  const providers = [...providerGroups].map(([id, group]) => ({
    id, displayName: providerName(group[0]), accounts: mapAccounts(group), windows: providerWindows(group),
    balance: providerBalance(group),
  }));
  const fiveHourRemainingPercent = averageRemaining(accounts.map((account) => account.fiveHour));
  const weeklyRemainingPercent = averageRemaining(accounts.map((account) => account.weekly));

  return {
    providers,
    accounts,
    quota: {
      ...(fiveHourRemainingPercent === undefined ? {} : { fiveHourRemainingPercent }),
      fiveHourAccountCount: accounts.filter((account) => account.fiveHour).length,
      ...(weeklyRemainingPercent === undefined ? {} : { weeklyRemainingPercent }),
      weeklyAccountCount: accounts.filter((account) => account.weekly).length,
    },
  };
}
