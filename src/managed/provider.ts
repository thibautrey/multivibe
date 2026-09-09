import type { ManagedProviderAccount } from "./executor.js";

const compatibleProviders = {
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
  readCredential: () => Promise<string>;
  fetchViaEgress: typeof fetch;
}): ManagedProviderAccount & { discoverModels(signal: AbortSignal): Promise<readonly string[]> } {
  const base = compatibleProviders[options.providerId];
  if (!base || !options.credentialRef || options.models.size > 10000) throw Error("invalid_managed_account");
  async function request(path: string, method: "GET" | "POST", signal: AbortSignal, body?: Uint8Array) {
    const credential = await options.readCredential();
    if (!credential || credential.length > 16384 || /[\r\n]/.test(credential)) throw Error("managed_credential_unavailable");
    signal.throwIfAborted();
    return options.fetchViaEgress(`${base}${path}`, { method, signal, redirect: "error",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      ...(body ? { body: new TextDecoder("utf-8", { fatal: true }).decode(body) } : {}),
    });
  }
  return {
    providerId: options.providerId, credentialRef: options.credentialRef, models: new Set(options.models),
    chatCompletions: (body, signal) => request("/chat/completions", "POST", signal, body),
    async discoverModels(signal) {
      const response = await request("/models", "GET", signal);
      if (!response.ok) { await response.body?.cancel(); throw Error("provider_discovery_unavailable"); }
      const reader = response.body?.getReader();
      if (!reader) throw Error("provider_discovery_invalid");
      const chunks: Uint8Array[] = [];
      let size = 0;
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
      return Object.freeze([...new Set<string>(ids)].sort());
    },
  };
}
