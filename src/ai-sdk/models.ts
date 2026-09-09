import { createReplicateModel } from "./expansion-gateways/index.js";
import {createAnthropicCodec} from "./anthropic-model.js";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Account } from "../types.js";
import { sdkProvider, sdkAccountBaseUrl } from "./providers.js";
import { createManusModel } from "./manus-provider.js";

export function createSdkModel(account: Account, model: string, fetchImpl?: typeof fetch): LanguageModelV4 {
  const provider = sdkProvider(account.sdkProvider);
  if (!provider || !account.accessToken) throw new Error("Provider account is not configured");
  if (provider.id === "replicate") return createReplicateModel(account.accessToken, model, fetchImpl);
  if (provider.adapter === "manus") return createManusModel(account.accessToken, model, fetchImpl);
  const baseURL = sdkAccountBaseUrl(account);
  const options = { apiKey: account.accessToken, baseURL, fetch: fetchImpl, headers: {
    ...provider.headers,
    ...(provider.authScheme === "Key" ? { Authorization: `Key ${account.accessToken}` } : {}),
  } };
  if (provider.adapter === "anthropic") return createAnthropicCodec(model,account.accessToken,baseURL,fetchImpl);
  if (provider.adapter === "google") return createGoogle(options).languageModel(model);
  if (provider.adapter !== "compatible") throw new Error("Provider adapter is not installed");
  return createOpenAICompatible({ ...options, name: provider.id, includeUsage: provider.includeUsage ?? true }).languageModel(model);
}
