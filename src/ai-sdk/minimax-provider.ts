import type { UsageSnapshot, UsageWindow } from "../types.js";
import type { SdkCatalogModel } from "./catalog.js";

export const MINIMAX_PROVIDER = {
  id: "minimax",
  name: "MiniMax",
  adapter: "compatible",
  baseURL: "https://api.minimax.io/v1",
} as const;

export const MINIMAX_CODING_PROVIDER = {
  ...MINIMAX_PROVIDER, id: "minimax-coding", name: "MiniMax Token Plan",
} as const;

export const MINIMAX_MODELS = [
  { id: "MiniMax-M3", name: "MiniMax M3", context: 1_000_000, tools: true, reasoning: true, input: ["text", "image"] },
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", context: 204_800, tools: true, reasoning: true, input: ["text"] },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", context: 204_800, tools: true, reasoning: true, input: ["text"] },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", context: 204_800, tools: true, reasoning: true, input: ["text"] },
  { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 Highspeed", context: 204_800, tools: true, reasoning: true, input: ["text"] },
  { id: "MiniMax-M2.1", name: "MiniMax M2.1", context: 204_800, tools: true, reasoning: true, input: ["text"] },
  { id: "MiniMax-M2.1-highspeed", name: "MiniMax M2.1 Highspeed", context: 204_800, tools: true, reasoning: true, input: ["text"] },
  { id: "MiniMax-M2", name: "MiniMax M2", context: 204_800, tools: true, reasoning: true, input: ["text"] },
] as const satisfies readonly SdkCatalogModel[];

export const MINIMAX_TOKEN_PLAN_USAGE_URL = "https://www.minimax.io/v1/token_plan/remains";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function percentUsed(remainingPercent: unknown, total: unknown, remaining: unknown): number | undefined {
  const percent = finiteNumber(remainingPercent);
  if (percent !== undefined) return Math.max(0, Math.min(100, 100 - percent));
  const limit = finiteNumber(total);
  const left = finiteNumber(remaining);
  if (limit === undefined || limit <= 0 || left === undefined) return undefined;
  return Math.max(0, Math.min(100, ((limit - left) / limit) * 100));
}

function resetAt(end: unknown, remains: unknown, now: number): number | undefined {
  const absolute = finiteNumber(end);
  if (absolute !== undefined && absolute > 0) return absolute < 10_000_000_000 ? absolute * 1000 : absolute;
  const duration = finiteNumber(remains);
  return duration !== undefined && duration >= 0 ? now + duration : undefined;
}

function quotaWindow(item: any, weekly: boolean, now: number): UsageWindow | undefined {
  const prefix = weekly ? "current_weekly" : "current_interval";
  const usedPercent = percentUsed(item?.[`${prefix}_remaining_percent`], item?.[`${prefix}_total_count`], item?.[`${prefix}_usage_count`]);
  const reset = resetAt(weekly ? item?.weekly_end_time : item?.end_time, weekly ? item?.weekly_remains_time : item?.remains_time, now);
  if (usedPercent === undefined && reset === undefined) return undefined;
  return { usedPercent, resetAt: reset, windowSeconds: weekly ? 7 * 24 * 60 * 60 : 5 * 60 * 60 };
}

export function parseMinimaxUsage(data: unknown, now = Date.now()): UsageSnapshot {
  const root: any = data && typeof data === "object" ? data : undefined;
  const status = finiteNumber(root?.base_resp?.status_code ?? root?.data?.base_resp?.status_code);
  if (status !== undefined && status !== 0) {
    throw new Error(`MiniMax usage response failed: ${root?.base_resp?.status_msg ?? root?.data?.base_resp?.status_msg ?? `status ${status}`}`);
  }
  const remains = root?.data?.model_remains ?? root?.model_remains;
  if (!Array.isArray(remains)) throw new Error("MiniMax usage response contains no model quota windows");
  const general = remains.find((item) => item?.model_name === "general") ?? remains[0];
  const primary = quotaWindow(general, false, now);
  const secondary = quotaWindow(general, true, now);
  if (!primary && !secondary) throw new Error("MiniMax usage response contains no recognized quota windows");
  return { primary, secondary, quotaStatus: "available", fetchedAt: now };
}

export async function fetchMinimaxUsage(
  token: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<UsageSnapshot> {
  const apiKey = token.trim();
  if (!apiKey) throw new Error("MiniMax API key required");
  const response = await fetchImpl(MINIMAX_TOKEN_PLAN_USAGE_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json" },
    signal: signal ?? AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`MiniMax usage probe failed ${response.status}`);
  return parseMinimaxUsage(await response.json());
}
