import { createAnthropicModel } from "./transports/anthropic.js";
import type { SdkModel } from "./model.js";
/** Shared native codec factory; no account storage, routing or retries. */
export function createAnthropicCodec(model: string, apiKey: string, baseURL: string, fetchImpl?: typeof fetch): SdkModel {
  return createAnthropicModel({ modelId: model, apiKey, baseURL, ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}) });
}
