import type { Account, UsageWindow } from "../types.js";

export const GITHUB_STAR_OUTPUT_TOKEN_THRESHOLD = 5_000_000;

export type HostMenuBarQuotaWindow = {
  remainingPercent: number;
  resetAt?: number;
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
};

export function hostMenuProviderId(account: Pick<Account, "provider" | "sdkProvider">): string {
  return account.provider === "ai-sdk" ? `ai-sdk:${account.sdkProvider || "unknown"}` : account.provider ?? "openai";
}

function providerName(account: Account): string {
  return {
    openai: "OpenAI", opencode: "OpenCode", zai: "z.ai", mistral: "Mistral",
    xai: "xAI", "openai-compatible": "OpenAI-compatible", "ai-sdk": account.sdkProvider || "AI SDK",
  }[account.provider ?? "openai"];
}

// Ephemeral routing activity: no account identifiers or credentials are exposed.
let latestActivity: { providerId: string; usedAt: number } | undefined;
export function recordHostMenuProviderUsage(account: Pick<Account, "provider" | "sdkProvider">, now = Date.now()): void {
  latestActivity = { providerId: hostMenuProviderId(account), usedAt: now };
}
export function getHostMenuProviderActivity() {
  return latestActivity;
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
        ? `${duration >= 86400 ? duration / 86400 : duration >= 3600 ? duration / 3600 : duration / 60}${duration >= 86400 ? "d" : duration >= 3600 ? "h" : "m"}`
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

function quotaWindow(window?: UsageWindow): HostMenuBarQuotaWindow | undefined {
  const usedPercent = finiteNumber(window?.usedPercent);
  if (usedPercent === undefined) return undefined;
  const resetAt = finiteNumber(window?.resetAt);
  return {
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
    const fetchedAt = finiteNumber(account.usage?.fetchedAt);
    const hasQuota = Boolean(fiveHour || weekly || monthly);
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
