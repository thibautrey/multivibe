import {createAnthropicCodec} from "./anthropic-model.js";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Account } from "../types.js";
import { sdkProvider } from "./providers.js";

export function createSdkModel(account: Account, model: string, fetchImpl?: typeof fetch): LanguageModelV4 {
  const provider = sdkProvider(account.sdkProvider);
  if (!provider || !account.accessToken) throw new Error("Provider account is not configured");
  const options = { apiKey: account.accessToken, baseURL: provider.baseURL, fetch: fetchImpl };
  if (provider.adapter === "anthropic") return createAnthropicCodec(model,account.accessToken,provider.baseURL,fetchImpl);
  if (provider.adapter === "google") return createGoogle(options).languageModel(model);
  return createOpenAICompatible({ ...options, name: provider.id, includeUsage: true }).languageModel(model);
}
