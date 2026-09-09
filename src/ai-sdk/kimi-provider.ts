/** Kimi's documented OpenAI-compatible global API endpoint. */
export const KIMI_PROVIDER = {
  id: "kimi",
  name: "Kimi",
  adapter: "compatible",
  baseURL: "https://api.moonshot.ai/v1",
} as const;

/** Kimi Code is a separate subscription product with separate API keys. */
export const KIMI_CODING_PROVIDER = {
  id: "kimi-coding",
  name: "Kimi Code",
  adapter: "compatible",
  baseURL: "https://api.kimi.com/coding/v1",
} as const;

/** Models listed as active in Kimi's public model catalog on 2026-09-09. */
export const KIMI_MODELS = [
  { id: "kimi-k3", name: "Kimi K3", context: 1_000_000, tools: true, reasoning: true, input: ["text", "image", "video"] },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", context: 262_144, tools: true, reasoning: true, input: ["text", "image", "video"] },
  { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code HighSpeed", context: 262_144, tools: true, reasoning: true, input: ["text", "image", "video"] },
  { id: "kimi-k2.6", name: "Kimi K2.6", context: 262_144, tools: true, reasoning: true, input: ["text", "image", "video"] },
] satisfies SdkCatalogModel[];

/** Model IDs documented for Kimi Code's OpenAI-compatible endpoint. */
export const KIMI_CODING_MODELS = [
  { id: "k3", name: "Kimi K3", context: 1_000_000, tools: true, reasoning: true, input: ["text", "image", "video"] },
  { id: "k3-256k", name: "Kimi K3 256K", context: 262_144, tools: true, reasoning: true, input: ["text", "image"] },
  { id: "kimi-for-coding", name: "Kimi K2.7 Code", context: 262_144, tools: true, reasoning: true, input: ["text", "image", "video"] },
  { id: "kimi-for-coding-highspeed", name: "Kimi K2.7 Code HighSpeed", context: 262_144, tools: true, reasoning: true, input: ["text", "image", "video"] },
] satisfies SdkCatalogModel[];

export const KIMI_BALANCE_URL = `${KIMI_PROVIDER.baseURL}/users/me/balance`;

export type KimiBalance = {
  availableBalance: number;
  voucherBalance: number;
  cashBalance: number;
};

/** Build the API-key-authenticated balance request documented by Kimi. */
export function buildKimiBalanceRequest(accessToken: string): { url: string; init: RequestInit } {
  const token = accessToken.trim().replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Kimi API key required");
  return {
    url: KIMI_BALANCE_URL,
    init: { method: "GET", headers: { Authorization: `Bearer ${token}` } },
  };
}

/** Parse Kimi's balance response without treating a currency balance as a percentage quota. */
export function parseKimiBalance(payload: unknown): KimiBalance {
  const response = payload as { code?: unknown; status?: unknown; data?: Record<string, unknown> };
  const data = response?.data;
  const availableBalance = data?.available_balance;
  const voucherBalance = data?.voucher_balance;
  const cashBalance = data?.cash_balance;
  if (
    response?.code !== 0 ||
    response?.status !== true ||
    typeof availableBalance !== "number" || !Number.isFinite(availableBalance) ||
    typeof voucherBalance !== "number" || !Number.isFinite(voucherBalance) ||
    typeof cashBalance !== "number" || !Number.isFinite(cashBalance)
  ) {
    throw new Error("Kimi balance response is invalid");
  }
  return { availableBalance, voucherBalance, cashBalance };
}

export const KIMI_CODING_USAGE_URL = `${KIMI_CODING_PROVIDER.baseURL}/usages`;

type KimiUsageDetail = { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseUsageWindow(detail: KimiUsageDetail, windowSeconds?: number) {
  const limit = finiteNumber(detail.limit);
  const used = finiteNumber(detail.used);
  if (limit === undefined || limit <= 0 || used === undefined || used < 0) {
    throw new Error("Kimi Code usage response is invalid");
  }
  const resetAt = typeof detail.resetTime === "string" ? Date.parse(detail.resetTime) : NaN;
  return {
    usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)),
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  };
}

/** Fetch Kimi Code's API-key-authenticated subscription usage windows. */
export async function fetchKimiCodingUsage(
  accessToken: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
) {
  const token = accessToken.trim().replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Kimi Code API key required");
  const response = await fetchImpl(KIMI_CODING_USAGE_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Kimi Code usage request failed (${response.status})`);
  const payload = await response.json() as {
    usage?: KimiUsageDetail;
    limits?: Array<{ window?: { duration?: unknown; timeUnit?: unknown }; detail?: KimiUsageDetail }>;
  };
  if (!payload.usage) throw new Error("Kimi Code usage response is invalid");
  const rateLimit = payload.limits?.find((limit) =>
    finiteNumber(limit.window?.duration) === 300 && limit.window?.timeUnit === "TIME_UNIT_MINUTE"
  ) ?? payload.limits?.find((limit) => limit?.detail);
  const duration = finiteNumber(rateLimit?.window?.duration);
  const unit = rateLimit?.window?.timeUnit;
  const multiplier = unit === "TIME_UNIT_MINUTE" ? 60 : unit === "TIME_UNIT_HOUR" ? 3_600 : unit === "TIME_UNIT_DAY" ? 86_400 : undefined;
  const windowSeconds = duration !== undefined && duration > 0 && multiplier !== undefined ? duration * multiplier : undefined;
  return {
    primary: rateLimit?.detail ? parseUsageWindow(rateLimit.detail, windowSeconds) : undefined,
    secondary: parseUsageWindow(payload.usage, 7 * 24 * 60 * 60),
    quotaStatus: "available" as const,
    fetchedAt: Date.now(),
  };
}
import type { SdkCatalogModel } from "./catalog.js";
