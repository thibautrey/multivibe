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
  maximumResponseBytes?: number;
  readCredential: () => Promise<string>;
  fetchViaEgress: typeof fetch;
}): ManagedProviderAccount & { discoverModels(signal: AbortSignal): Promise<readonly string[]> } {
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
    providerId: options.providerId, credentialRef: options.credentialRef, models: new Set(options.models),
    chatCompletions: options.providerId === "anthropic"
      ? createManagedAnthropicAccount({...options,maximumResponseBytes:options.maximumResponseBytes ?? 8*1024*1024}).chatCompletions
      : (body, signal, authorization) => request("/chat/completions", "POST", signal, body, authorization.beforeDispatch),
    async discoverModels(signal) {
      const allIds = new Set<string>();
      const cursors = new Set<string>();
      let path = "/models", size = 0, modelCount = 0;
      for (let page = 0; page < 100; page++) {
      const response = await request(path, "GET", signal);
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          throw Error("provider_discovery_authentication_rejected");
        }
        if (response.status === 404) throw Error("provider_discovery_endpoint_unavailable");
        if (response.status === 429) throw Error("provider_discovery_rate_limited");
        if (response.status >= 500) throw Error("provider_discovery_upstream_unavailable");
        throw Error("provider_discovery_unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error("provider_discovery_invalid");
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 2 * 1024 * 1024) throw Error("provider_discovery_too_large");
          chunks.push(next.value);
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(parsed?.data) || parsed.data.length > 10000) throw Error("provider_discovery_invalid");
      const ids = parsed.data.map((entry: unknown) => {
        const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
        if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(id)) throw Error("provider_discovery_invalid");
        return id;
      });
      modelCount += ids.length;
      if (modelCount > 10000) throw Error("provider_discovery_too_large");
      for (const id of ids) allIds.add(id);
      if (options.providerId !== "anthropic") {
        if (parsed.has_more === true) throw Error("provider_discovery_incomplete");
        return Object.freeze([...allIds].sort());
      }
      if (typeof parsed.has_more !== "boolean") throw Error("provider_discovery_invalid");
      if (!parsed.has_more) return Object.freeze([...allIds].sort());
      const cursor = parsed.last_id;
      if (!ids.length || typeof cursor !== "string" || cursor !== ids.at(-1) || cursors.has(cursor)) {
        throw Error("provider_discovery_invalid_cursor");
      }
      cursors.add(cursor);
      path = `/models?after_id=${encodeURIComponent(cursor)}`;
      }
      throw Error("provider_discovery_incomplete");
    },
  };
}
