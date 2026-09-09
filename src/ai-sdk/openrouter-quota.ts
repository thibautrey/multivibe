import type { Account, UsageSnapshot } from "../types.js";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
type FetchLike = typeof fetch;

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`OpenRouter key response has invalid ${field}`);
  }
  return value;
}

export function parseOpenRouterKeyUsage(payload: unknown): UsageSnapshot {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
      typeof (payload as any).data !== "object" || (payload as any).data === null || Array.isArray((payload as any).data)) {
    throw new Error("OpenRouter key response is invalid");
  }
  const data = (payload as any).data;
  if (data.limit === null && data.limit_remaining === null) {
    return { quotaStatus: "available", fetchedAt: Date.now(), quotaMessage: "This OpenRouter key has no spending cap. Account credits are not exposed by the key endpoint." };
  }
  const limit = finiteNumber(data.limit, "limit");
  const remaining = finiteNumber(data.limit_remaining, "limit_remaining");
  if (limit < 0 || remaining < 0 || remaining > limit) throw new Error("OpenRouter key response has invalid limit");
  return {
    credits: { label: "OpenRouter key budget", usedPercent: limit === 0 ? 100 : ((limit - remaining) / limit) * 100 },
    quotaStatus: "available",
    fetchedAt: Date.now(),
  };
}

export async function fetchOpenRouterUsage(
  account: Account,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<UsageSnapshot> {
  if (account.provider !== "ai-sdk" || account.sdkProvider !== "openrouter") {
    throw new Error("Account is not an OpenRouter account");
  }
  if (!account.accessToken?.trim()) throw new Error("OpenRouter usage requires an API key");
  const response = await fetchImpl(OPENROUTER_KEY_URL, {
    headers: { accept: "application/json", authorization: `Bearer ${account.accessToken}` },
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OpenRouter key probe failed ${response.status}`);
  const payload = await response.json().catch(() => {
    throw new Error("OpenRouter key response is not valid JSON");
  });
  return parseOpenRouterKeyUsage(payload);
}
