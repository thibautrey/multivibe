import type { Account, UsageSnapshot, UsageWindow } from "./types.js";

const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const COPILOT_USAGE_HEADERS = {
  accept: "application/json",
  "editor-version": "vscode/1.96.2",
  "editor-plugin-version": "copilot-chat/0.26.7",
  "user-agent": "GitHubCopilotChat/0.26.7",
  "x-github-api-version": "2025-04-01",
};

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResetAt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("GitHub Copilot quota reset date is invalid");
  const raw = value.trim();
  if (!raw) return undefined;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const parsed = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    if (new Date(parsed).toISOString().slice(0, 10) !== raw) {
      throw new Error("GitHub Copilot quota reset date is invalid");
    }
    return parsed;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    throw new Error("GitHub Copilot quota reset date is invalid");
  }
  return parsed;
}

function parseQuotaWindow(value: unknown, resetAt: number | undefined): UsageWindow | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("GitHub Copilot quota snapshot is invalid");
  if (value.unlimited === true) return undefined;
  if (value.unlimited !== undefined && typeof value.unlimited !== "boolean") {
    throw new Error("GitHub Copilot quota snapshot is invalid");
  }

  const entitlement = value.entitlement;
  const remaining = value.remaining;
  const percentRemaining = value.percent_remaining;
  for (const number of [entitlement, remaining, percentRemaining]) {
    if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number))) {
      throw new Error("GitHub Copilot quota snapshot is invalid");
    }
  }
  // Business token billing can expose zero-valued placeholders. They are not a
  // measured allowance and must not be presented as unused quota.
  if (entitlement === 0 && remaining === 0 && percentRemaining === 0) return undefined;
  if (typeof percentRemaining !== "number") throw new Error("GitHub Copilot quota snapshot is invalid");
  if (percentRemaining < 0 || percentRemaining > 100 ||
      typeof entitlement === "number" && entitlement < 0 || typeof remaining === "number" && remaining < 0) {
    throw new Error("GitHub Copilot quota snapshot is invalid");
  }
  return { usedPercent: 100 - percentRemaining, resetAt };
}

/** Parse GitHub's Copilot subscription response without deriving undocumented limits. */
export function parseCopilotUsage(data: unknown): UsageSnapshot {
  if (!isRecord(data) || !isRecord(data.quota_snapshots)) {
    throw new Error("GitHub Copilot usage response contains no quota snapshots");
  }
  const resetAt = parseResetAt(data.quota_reset_date);
  const premium = parseQuotaWindow(data.quota_snapshots.premium_interactions, resetAt);
  const chat = parseQuotaWindow(data.quota_snapshots.chat, resetAt);
  const hasKnownSnapshot = data.quota_snapshots.premium_interactions != null || data.quota_snapshots.chat != null;
  if (!hasKnownSnapshot) {
    throw new Error("GitHub Copilot usage response contains no recognized quota snapshots");
  }
  return {
    // Premium interactions are the subscription's metered credits. Chat is a
    // separate monthly allowance; both participate in account routing.
    credits: premium ? { ...premium, label: "Copilot premium requests" } : undefined,
    monthly: chat ? { ...chat, label: "Copilot chat requests" } : undefined,
    quotaStatus: "available",
    fetchedAt: Date.now(),
  };
}

export async function fetchCopilotUsage(
  account: Account,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<UsageSnapshot> {
  if (account.provider !== "github-copilot") throw new Error("Account is not a GitHub Copilot account");
  if (typeof account.refreshToken !== "string" || !account.refreshToken.trim()) {
    throw new Error("GitHub Copilot usage requires the GitHub OAuth token");
  }
  const response = await fetchImpl(COPILOT_USAGE_URL, {
    headers: { ...COPILOT_USAGE_HEADERS, authorization: `token ${account.refreshToken}` },
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub Copilot usage probe failed ${response.status}`);
  const data = await response.json().catch(() => {
    throw new Error("GitHub Copilot usage response is not valid JSON");
  });
  return parseCopilotUsage(data);
}
