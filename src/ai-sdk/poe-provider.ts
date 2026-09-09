import type { SdkCatalogModel } from "./catalog.js";
import type { UsageSnapshot } from "../types.js";

/** Reviewed against Poe's official OpenAI-compatible API documentation. */
export const POE_PROVIDER = {
  id: "poe",
  name: "Poe",
  adapter: "compatible",
  baseURL: "https://api.poe.com/v1",
} as const;

/**
 * Model IDs used in Poe's official API examples as of 2026-09-09.
 * Poe's available bots can change, so accounts may still enable custom IDs.
 */
export const POE_MODELS: SdkCatalogModel[] = [
  { id: "GPT-5.4", name: "GPT-5.4", input: ["text"] },
  { id: "Claude-Sonnet-4.6", name: "Claude Sonnet 4.6", input: ["text"] },
  { id: "Claude-Opus-4.7", name: "Claude Opus 4.7", input: ["text"] },
  { id: "Gemini-3.1-Pro", name: "Gemini 3.1 Pro", input: ["text"] },
];

export const POE_CATALOG_SOURCE =
  "https://creator.poe.com/docs/external-applications/openai-compatible-api";

/** The balance includes plan and add-on points; Poe exposes no total or reset. */
export function parsePoeUsage(data: unknown): UsageSnapshot {
  const remaining = (data as { current_point_balance?: unknown } | null)?.current_point_balance;
  if (typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining < 0 ||
      (data as { error?: unknown }).error) throw new Error("Poe usage response has no valid point balance");
  return { balance: { remaining, unit: "points" }, quotaStatus: "available", fetchedAt: Date.now(),
    quotaMessage: "Available plan and add-on points. Poe does not expose the allowance total or reset date." };
}

export async function fetchPoeUsage(token: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<UsageSnapshot> {
  const response = await fetchImpl("https://api.poe.com/usage/current_balance", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Poe usage probe failed ${response.status}`);
  return parsePoeUsage(await response.json());
}
