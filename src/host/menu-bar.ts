import type { Account, UsageWindow } from "../types.js";

export const GITHUB_STAR_OUTPUT_TOKEN_THRESHOLD = 5_000_000;

export type HostMenuBarQuotaWindow = {
  remainingPercent: number;
  resetAt?: number;
};

export type HostMenuBarAccount = {
  provider: string;
  providerName: string;
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
  accounts: HostMenuBarAccount[];
  quota: HostMenuBarQuotaAggregate;
};

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
  const accounts = source.map((account, index): HostMenuBarAccount => {
    const provider = account.provider ?? "openai";
    const providerName = {
      openai: "OpenAI",
      opencode: "OpenCode",
      zai: "z.ai",
      mistral: "Mistral",
      xai: "xAI",
      "openai-compatible": "OpenAI-compatible",
      "ai-sdk": account.sdkProvider || "AI SDK",
    }[provider];
    const email = account.email?.trim();
    const fiveHour = quotaWindow(account.usage?.primary);
    const weekly = quotaWindow(account.usage?.secondary);
    const monthly = quotaWindow(account.usage?.monthly);
    const fetchedAt = finiteNumber(account.usage?.fetchedAt);
    const hasQuota = Boolean(fiveHour || weekly || monthly);
    return {
      provider,
      providerName,
      displayName: email
        ? provider === "openai" ? email : `${providerName} · ${email}`
        : `${providerName} account ${index + 1}`,
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
  // Preserve the legacy aggregate for older menu clients. Tabs aggregate their own provider.
  const aggregateAccounts = openAIAccounts.length ? accounts.filter((account) => account.provider === "openai") : accounts;
  const fiveHourRemainingPercent = averageRemaining(aggregateAccounts.map((account) => account.fiveHour));
  const weeklyRemainingPercent = averageRemaining(aggregateAccounts.map((account) => account.weekly));

  return {
    accounts,
    quota: {
      ...(fiveHourRemainingPercent === undefined ? {} : { fiveHourRemainingPercent }),
      fiveHourAccountCount: aggregateAccounts.filter((account) => account.fiveHour).length,
      ...(weeklyRemainingPercent === undefined ? {} : { weeklyRemainingPercent }),
      weeklyAccountCount: aggregateAccounts.filter((account) => account.weekly).length,
    },
  };
}
