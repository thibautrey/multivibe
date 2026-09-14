import {discoverProviderModelCatalog} from "../provider-model-catalog.js";
import {parseManagedModelPolicy, type ManagedModelPolicy} from "./model-policy.js";
import type { ManagedProviderAccount } from "./executor.js";

import {createManagedAnthropicAccount} from "./native-anthropic.js";

const compatibleProviders = {
  anthropic: "https://api.anthropic.com/v1",
  mistral: "https://api.mistral.ai/v1",
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
} as const;
export type ManagedCompatibleProvider = keyof typeof compatibleProviders;
/** Credentials and network transport are deployment-owned capabilities. No default
 * fetch is provided: production must inject its restricted provider egress path. */
export function createManagedProviderAccount(options: {
  providerId: ManagedCompatibleProvider;
  credentialRef: string;
  models: ReadonlySet<string>;
  modelPolicy?: ManagedModelPolicy;
  maximumResponseBytes?: number;
  readCredential: () => Promise<string>;
  fetchViaEgress: typeof fetch;
}): ManagedProviderAccount & { discoverModels(signal: AbortSignal): Promise<readonly string[]> } {
  const modelPolicy = parseManagedModelPolicy(options.modelPolicy);
  const base = compatibleProviders[options.providerId];
  if (!base || !options.credentialRef || options.models.size > 10000) throw Error("invalid_managed_account");
  async function request(path: string, method: "GET" | "POST", signal: AbortSignal, body?: Uint8Array, beforeDispatch?: () => Promise<void>) {
    signal.throwIfAborted();
    const credential = await options.readCredential();
    if (!credential || credential.length > 16384 || /[\r\n]/.test(credential)) throw Error("managed_credential_unavailable");
    signal.throwIfAborted();
    await beforeDispatch?.();
    return options.fetchViaEgress(`${base}${path}`, { method, signal, redirect: "error",
      headers: options.providerId === "anthropic"
        ? {"x-api-key":credential,"anthropic-version":"2023-06-01","content-type":"application/json"}
        : { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      ...(body ? { body: new TextDecoder("utf-8", { fatal: true }).decode(body) } : {}),
    });
  }
  return {
    providerId: options.providerId, credentialRef: options.credentialRef, modelPolicy, models: new Set(options.models),
    chatCompletions: options.providerId === "anthropic"
      ? createManagedAnthropicAccount({...options,maximumResponseBytes:options.maximumResponseBytes ?? 8*1024*1024}).chatCompletions
      : (body, signal, authorization) => request("/chat/completions", "POST", signal, body, authorization.beforeDispatch),
    async discoverModels(signal) {
      return discoverProviderModelCatalog({
        signal, anthropic: options.providerId === "anthropic",
        request: path => request(path, "GET", signal),
      });
    },
  };
}
