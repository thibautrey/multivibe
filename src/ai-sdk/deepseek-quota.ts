import type { Account, UsageSnapshot } from "../types.js";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
type FetchLike = typeof fetch;

function balanceAmount(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`DeepSeek balance response has invalid ${field}`);
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error(`DeepSeek balance response has invalid ${field}`);
  return amount;
}

export function parseDeepSeekBalance(payload: unknown): UsageSnapshot {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("DeepSeek balance response is invalid");
  }
  const root = payload as Record<string, unknown>;
  if (typeof root.is_available !== "boolean" || !Array.isArray(root.balance_infos) || root.balance_infos.length !== 1) {
    throw new Error("DeepSeek balance response has no unambiguous balance");
  }
  const entry = root.balance_infos[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("DeepSeek balance response is invalid");
  }
  const info = entry as Record<string, unknown>;
  if (info.currency !== "CNY" && info.currency !== "USD") {
    throw new Error("DeepSeek balance response has invalid currency");
  }
  const total = balanceAmount(info.total_balance, "total_balance");
  const granted = balanceAmount(info.granted_balance, "granted_balance");
  const toppedUp = balanceAmount(info.topped_up_balance, "topped_up_balance");
  const availability = root.is_available
    ? ""
    : " DeepSeek currently reports that this balance is insufficient for API calls.";
  return {
    balance: { remaining: total, unit: info.currency },
    quotaStatus: "available",
    quotaMessage: `DeepSeek API balance: ${granted.toLocaleString()} ${info.currency} granted and ${toppedUp.toLocaleString()} ${info.currency} topped up. This is spendable API credit, not a subscription quota window.${availability}`,
    fetchedAt: Date.now(),
  };
}

export async function fetchDeepSeekUsage(
  account: Account,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<UsageSnapshot> {
  if (account.provider !== "ai-sdk" || account.sdkProvider !== "deepseek") {
    throw new Error("Account is not a DeepSeek account");
  }
  if (!account.accessToken?.trim()) throw new Error("DeepSeek balance requires an API key");
  const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
    headers: { accept: "application/json", authorization: `Bearer ${account.accessToken}` },
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`DeepSeek balance probe failed ${response.status}`);
  const payload = await response.json().catch(() => {
    throw new Error("DeepSeek balance response is not valid JSON");
  });
  return parseDeepSeekBalance(payload);
}
