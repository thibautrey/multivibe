import { createReplicateModel } from "./expansion-gateways/index.js";
import { createAnthropicCodec } from "./anthropic-model.js";
import { createGoogleModel } from "./transports/google.js";
import { createOpenAICompatibleModel } from "./transports/openai-compatible.js";
import type { SdkModel } from "./model.js";
import type { Account } from "../types.js";
import { sdkProvider, sdkAccountBaseUrl } from "./providers.js";
import { createManusModel } from "./manus-provider.js";

export function createSdkModel(account: Account, model: string, fetchImpl?: typeof fetch): SdkModel {
  const provider = sdkProvider(account.sdkProvider);
  if (!provider || !account.accessToken) throw new Error("Provider account is not configured");
  if (provider.id === "replicate") return createReplicateModel(account.accessToken, model, fetchImpl);
  if (provider.adapter === "manus") return createManusModel(account.accessToken, model, fetchImpl);
  const baseURL = sdkAccountBaseUrl(account);
  if (provider.adapter === "anthropic") return createAnthropicCodec(model, account.accessToken, baseURL, fetchImpl);
  if (provider.adapter === "google") {
    return createGoogleModel({ modelId: model, apiKey: account.accessToken, baseURL, fetch: fetchImpl });
  }
  if (provider.adapter !== "compatible") throw new Error("Provider adapter is not installed");
  return createOpenAICompatibleModel({
    provider: provider.id,
    modelId: model,
    baseURL,
    apiKey: account.accessToken,
    ...(provider.authScheme !== undefined ? { authScheme: provider.authScheme } : {}),
    ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    includeUsage: provider.includeUsage ?? true,
  });
}
