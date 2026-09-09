import type { UsageSnapshot } from "../types.js";

/** Mammouth documents LiteLLM /key/info for API-key spend tracking. */
export function parseMammouthUsage(payload: unknown): UsageSnapshot {
  const root = payload as any;
  const info = root?.info;
  if (root?.error || !info || typeof info.spend !== "number" || !Number.isFinite(info.spend) || info.spend < 0) {
    throw new Error("Mammouth usage response has no valid key spend");
  }
  const hasBudget = typeof info.max_budget === "number" && Number.isFinite(info.max_budget) && info.max_budget > 0;
  const reset = typeof info.budget_reset_at === "string" ? Date.parse(info.budget_reset_at) : NaN;
  return { spend: { amount: info.spend, unit: "USD" },
    credits: hasBudget ? { label: "API key budget", usedPercent: Math.min(100, info.spend / info.max_budget * 100),
      ...(Number.isFinite(reset) ? { resetAt: reset } : {}) } : undefined,
    quotaStatus: "available", fetchedAt: Date.now(),
    quotaMessage: "Spend and any explicit budget apply to this API key. They do not describe the full Mammouth chat subscription." };
}

export async function fetchMammouthUsage(token: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<UsageSnapshot> {
  const response = await fetchImpl("https://api.mammouth.ai/key/info", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error", signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Mammouth usage probe failed ${response.status}`);
  return parseMammouthUsage(await response.json());
}
