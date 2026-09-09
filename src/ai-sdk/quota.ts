import { QUOTA_FETCHERS } from "./expansion-subscriptions/index.js";
import type { Account, UsageSnapshot } from "../types.js";
import { fetchPoeUsage } from "./poe-provider.js";
import { fetchMinimaxUsage } from "./minimax-provider.js";
import { fetchKimiCodingUsage } from "./kimi-provider.js";
import { fetchOpenRouterUsage } from "./openrouter-quota.js";
import { fetchManusUsage } from "./manus-provider.js";
import { fetchMammouthUsage } from "./mammouth-quota.js";
import { fetchQwenUsage } from "./qwen-quota.js";

const UNSUPPORTED_MESSAGES: Record<string, string> = {
  abacus: "Abacus subscription credit checks require a separate browser session. This RouteLLM API key cannot retrieve them.",
  huggingface: "Hugging Face does not document a remaining compute-credit endpoint for this inference token. Check billing settings; request token usage is tracked here.",
};

/** Fixed, reviewed endpoints only. Never send cloud keys to the caller's base URL. */
export async function fetchSdkUsage(account: Account, signal: AbortSignal): Promise<UsageSnapshot> {
  const fetcher = QUOTA_FETCHERS[account.sdkProvider ?? ""];
  if (fetcher) return fetcher(account, signal);
  switch (account.sdkProvider) {
    case "poe": return fetchPoeUsage(account.accessToken, signal);
    case "minimax-coding": return fetchMinimaxUsage(account.accessToken, signal);
    case "kimi-coding": return fetchKimiCodingUsage(account.accessToken, signal);
    case "openrouter": return fetchOpenRouterUsage(account, signal);
    case "manus": return fetchManusUsage(account.accessToken, signal);
    case "mammouth": return fetchMammouthUsage(account.accessToken, signal);
    case "qwen-coding": return fetchQwenUsage(account.accessToken, signal);
    default: return { fetchedAt: Date.now(), quotaStatus: "unsupported",
      quotaMessage: UNSUPPORTED_MESSAGES[account.sdkProvider ?? ""] ??
        "This API connection does not expose subscription quota windows. Request token usage is tracked separately." };
  }
}
