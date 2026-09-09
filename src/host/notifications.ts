import { hostMenuProviderId, providerName } from "./menu-bar.js";
import type { Account } from "../types.js";
import { normalizeProvider } from "../quota.js";
import {
  CODEX_QUOTA_RESET_FORECAST_URL,
  type CodexQuotaResetForecast,
} from "../quota-reset-forecast.js";
import type { MultivibeCloudStatus } from "../multivibe-cloud.js";
import type { ResetCreditIncrease } from "../rate-limit-reset.js";

export const WEEKLY_QUOTA_WARNING_REMAINING_PERCENT = 10;
export const FORECAST_WARNING_SCORE = 90;
export const FORECAST_AUTO_RESET_MAX_SCORE = 80;
export const LOW_CLOUD_BALANCE_USD = 2;
export const LOW_CLOUD_BALANCE_PROXIMITY_USD = 0.25;

export type HostNotificationRepeatMode = "once" | "condition" | "edge";

export type HostNotification = {
  id: string;
  kind:
    | "will-codex-reset"
    | "weekly-quota"
    | "reset-credit-increased"
    | "provider-quota-limit"
    | "cloud-balance"
    | "cloud-auto-topup"
    | "worker-earnings"
    | "output-tokens";
  priority: number;
  repeatMode: HostNotificationRepeatMode;
  message: string;
  actionTitle?: string;
  actionUrl?: string;
  actionPath?: string;
  confirmationMessage?: string;
  confirmationTitle?: string;
};

export type HostNotificationInput = {
  accounts: Account[];
  forecast?: CodexQuotaResetForecast;
  previousForecastScore?: number;
  cloud?: MultivibeCloudStatus;
  workerConfigured: boolean;
  generatedOutputTokens: number;
  resetCreditIncreases?: ResetCreditIncrease[];
};

function finiteNonNegative(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function openAiAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) => normalizeProvider(account) === "openai");
}

function weeklyRemainingPercent(account: Account): number | undefined {
  const used = account.usage?.secondary?.usedPercent;
  return typeof used === "number" && Number.isFinite(used)
    ? 100 - Math.max(0, Math.min(100, used))
    : undefined;
}

export function selectWeeklyAutoResetAccount(
  accounts: Account[],
  maximumRemainingPercent = 100,
): Account | undefined {
  const all = openAiAccounts(accounts);
  if (all.some((account) => account.state?.scheduledWeeklyReset)) return undefined;
  const candidates = all.filter((account) =>
    account.enabled && weeklyRemainingPercent(account) !== undefined
      && weeklyRemainingPercent(account)! <= maximumRemainingPercent
  );
  if (!candidates.length) return undefined;
  return candidates.sort(
    (left, right) => weeklyRemainingPercent(left)! - weeklyRemainingPercent(right)!,
  )[0];
}

function weeklyQuotaNotification(
  accounts: Account[],
  forecast?: CodexQuotaResetForecast,
): HostNotification | undefined {
  if (!forecast || forecast.score >= FORECAST_AUTO_RESET_MAX_SCORE) return undefined;
  const account = selectWeeklyAutoResetAccount(accounts, WEEKLY_QUOTA_WARNING_REMAINING_PERCENT);
  if (!account) return undefined;
  const remaining = weeklyRemainingPercent(account!);
  if (remaining === undefined) return undefined;
  const resetAt = account!.usage?.secondary?.resetAt;
  const cycle = typeof resetAt === "number" && Number.isFinite(resetAt)
    ? Math.floor(resetAt)
    : "current";
  return {
    id: `weekly-quota:${cycle}`,
    kind: "weekly-quota",
    priority: 90,
    repeatMode: "once",
    message: `Your Codex weekly quota is down to ${remaining.toFixed(1)}%. Activate a one-time automatic reset when it reaches 0.5%?`,
    actionTitle: "Activate auto reset once",
    actionPath: "/admin/host/weekly-auto-reset",
    confirmationMessage: "Automatic reset scheduled for 0.5% remaining.",
    confirmationTitle: "Scheduled ✓",
  };
}

function cloudNotification(cloud?: MultivibeCloudStatus): HostNotification | undefined {
  if (cloud?.status !== "connected") return undefined;
  const balance = finiteNonNegative(cloud.balanceUsd);
  if (balance === undefined || balance <= 0) return undefined;
  const autoTopup = cloud.autoTopup;
  const threshold = autoTopup?.enabled ? finiteNonNegative(autoTopup.thresholdUsd) : undefined;
  if (threshold !== undefined) {
    const nearThreshold = threshold + Math.max(0.5, threshold * 0.1);
    if (balance <= nearThreshold) {
      return {
        id: "cloud-auto-topup-near-threshold",
        kind: "cloud-auto-topup",
        priority: 80,
        repeatMode: "condition",
        message: `Your MultiVibe Cloud balance is ${usd(balance)}. Auto top-up will run soon near your ${usd(threshold)} threshold.`,
      };
    }
    return undefined;
  }
  if (balance <= LOW_CLOUD_BALANCE_USD + LOW_CLOUD_BALANCE_PROXIMITY_USD) {
    return {
      id: "cloud-balance-low",
      kind: "cloud-balance",
      priority: 80,
      repeatMode: "condition",
      message: `Your MultiVibe Cloud balance is almost empty (${usd(balance)} remaining).`,
      actionTitle: "Top up credits",
      actionUrl: cloud.topupUrl,
    };
  }
  return undefined;
}

export function workerEarningsMilestone(
  lifetimeUsd: unknown,
  averageMonthlyUsd: unknown,
): number | undefined {
  const lifetime = finiteNonNegative(lifetimeUsd);
  const monthly = finiteNonNegative(averageMonthlyUsd);
  if (lifetime === undefined || monthly === undefined || lifetime < 10) return undefined;
  if (lifetime < 100) return 10;
  const interval = monthly < 1_000
    ? 100
    : 10 ** Math.max(3, Math.floor(Math.log10(monthly)));
  return Math.floor(lifetime / interval) * interval;
}

function workerNotification(
  workerConfigured: boolean,
  cloud?: MultivibeCloudStatus,
): HostNotification | undefined {
  if (!workerConfigured || !cloud?.workerEarnings) return undefined;
  const milestone = workerEarningsMilestone(
    cloud.workerEarnings.lifetimeNetUsd,
    cloud.workerEarnings.averageMonthlyNetUsd,
  );
  if (!milestone) return undefined;
  return {
    id: `worker-earnings:${milestone}`,
    kind: "worker-earnings",
    priority: 40,
    repeatMode: "once",
    message: `🎉 Your MultiVibe worker has generated ${usd(milestone)}. Keep it running! 🎉`,
  };
}

const OUTPUT_TOKEN_MILESTONES = [
  100_000,
  1_000_000,
  10_000_000,
  100_000_000,
  1_000_000_000,
] as const;

export function outputTokenMilestone(value: unknown): number | undefined {
  const tokens = finiteNonNegative(value);
  if (tokens === undefined) return undefined;
  return [...OUTPUT_TOKEN_MILESTONES].reverse().find((milestone) => tokens >= milestone);
}

function compactCount(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 }).format(value);
}

// Use normalized usage and routing blocks so providers without a usage API also notify.
function providerQuotaNotifications(accounts: Account[], now = Date.now()): HostNotification[] {
  const limited = new Map<string, Account>();
  for (const account of accounts) {
    if (!account.enabled) continue;
    const exhausted = account.usage?.quotaStatus !== "unsupported" &&
      [account.usage?.primary, account.usage?.secondary, account.usage?.monthly, account.usage?.credits]
        .some((window) => typeof window?.usedPercent === "number" &&
          Number.isFinite(window.usedPercent) && window.usedPercent >= 100 &&
          (window.resetAt === undefined || window.resetAt > now));
    const blocked = Object.values(account.state?.modelBlocks ?? {}).some((block) =>
      block.until > now && /\b429\b|rate[_ -]?limit|usage[_ -]?limit|insufficient[_ -]?quota|quota.{0,30}(?:exhausted|exceeded)|(?:exhausted|exceeded).{0,30}quota|limit[_ -]?exhausted/i.test(block.reason));
    if (exhausted || blocked) limited.set(hostMenuProviderId(account), account);
  }
  return [...limited].map(([id, account]) => ({
    id: `provider-quota-limit:${id}`,
    kind: "provider-quota-limit",
    priority: 100,
    repeatMode: "condition",
    message: `${providerName(account).slice(0, 100)} has reached a quota or rate limit on a connected account. Check its limits in the dashboard.`,
  }));
}

export function buildHostNotifications(input: HostNotificationInput): HostNotification[] {
  const notifications: HostNotification[] = providerQuotaNotifications(input.accounts);
  for (const increase of input.resetCreditIncreases ?? []) {
    const added = increase.availableCount - increase.previousCount;
    if (added <= 0) continue;
    const displayName = increase.displayName.trim().slice(0, 100) || "OpenAI account";
    notifications.push({
      id: `reset-credit-increased:${increase.accountId.slice(0, 80)}:${increase.availableCount}`,
      kind: "reset-credit-increased",
      priority: 70,
      repeatMode: "edge",
      message: added === 1
        ? `A new OpenAI quota reset credit is available for ${displayName} (${increase.availableCount} available).`
        : `${added} new OpenAI quota reset credits are available for ${displayName} (${increase.availableCount} available).`,
    });
  }
  const openAiConfigured = openAiAccounts(input.accounts).length > 0;
  if (
    openAiConfigured &&
    input.forecast &&
    typeof input.previousForecastScore === "number" &&
    input.previousForecastScore < FORECAST_WARNING_SCORE &&
    input.forecast.score > FORECAST_WARNING_SCORE
  ) {
    notifications.push({
      id: "will-codex-reset:crossed-90",
      kind: "will-codex-reset",
      priority: 100,
      repeatMode: "edge",
      message: `WillCodexReset now estimates a ${input.forecast.score.toFixed(0)}% chance of an imminent Codex quota reset. This may be a good time to use your remaining quota.`,
      actionTitle: "Willcodexreset.com",
      actionUrl: CODEX_QUOTA_RESET_FORECAST_URL,
    });
  }

  const weekly = weeklyQuotaNotification(input.accounts, input.forecast);
  if (weekly) notifications.push(weekly);
  const cloud = cloudNotification(input.cloud);
  if (cloud) notifications.push(cloud);
  const worker = workerNotification(input.workerConfigured, input.cloud);
  if (worker) notifications.push(worker);

  const tokenMilestone = outputTokenMilestone(input.generatedOutputTokens);
  if (tokenMilestone) {
    notifications.push({
      id: `output-tokens:${tokenMilestone}`,
      kind: "output-tokens",
      priority: 20,
      repeatMode: "once",
      message: `✨ MultiVibe has generated ${compactCount(tokenMilestone)} output tokens across your providers.`,
    });
  }

  return notifications.sort((left, right) => right.priority - left.priority);
}
