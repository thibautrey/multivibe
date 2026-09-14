/** Storage-free API-key validation owned by Core. Cloud injects its admitted egress
 * transport and retains consent, authorization and persistence. No default fetch,
 * account store, callbacks or billable inference during catalog discovery.
 */
function validateKey(key: string): void {
  if (typeof key !== 'string' || !key || key.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(key))
    throw new ProviderCredentialValidationError('unauthorized');
}
type ProviderDefinition = Readonly<{
  baseUrl: string;
  protocol: "openai" | "anthropic";
  authentication: "bearer" | "x-api-key";
}>;

const DEFINITIONS: Readonly<Record<string, ProviderDefinition>> = Object.freeze({
  mistral: { baseUrl: "https://api.mistral.ai/v1", protocol: "openai", authentication: "bearer" },
  "mistral-zdr": { baseUrl: "https://api.mistral.ai/v1", protocol: "openai", authentication: "bearer" },
  openai: { baseUrl: "https://api.openai.com/v1", protocol: "openai", authentication: "bearer" },
  xai: { baseUrl: "https://api.x.ai/v1", protocol: "openai", authentication: "bearer" },
  "xai-zdr": { baseUrl: "https://api.x.ai/v1", protocol: "openai", authentication: "bearer" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", protocol: "openai", authentication: "bearer" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic", authentication: "x-api-key" },
  "z-ai": { baseUrl: "https://api.z.ai/api/paas/v4", protocol: "openai", authentication: "bearer" },
});

export const PROVIDER_CREDENTIAL_VALIDATION_PROVIDERS = Object.freeze(Object.keys(DEFINITIONS).sort());

/** Server-owned endpoint; never accept an upstream URL from onboarding input. */
export function providerCredentialEndpoint(provider: string): string { return definition(provider).baseUrl; }

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_INFERENCE_BYTES = 1024 * 1024;

export class ProviderCredentialValidationError extends Error {
  constructor(readonly code: "unsupported" | "unauthorized" | "unavailable" | "invalid_response" | "model_unavailable" | "inference_failed") {
    super(`Provider credential validation ${code}`);
    this.name = "ProviderCredentialValidationError";
  }
}

function definition(provider: string): ProviderDefinition {
  const value = Object.hasOwn(DEFINITIONS, provider) ? DEFINITIONS[provider] : undefined;
  if (!value) throw new ProviderCredentialValidationError("unsupported");
  return value;
}

function headers(value: ProviderDefinition, apiKey: string): Headers {
  const result = new Headers({ accept: "application/json" });
  if (value.authentication === "bearer") result.set("authorization", `Bearer ${apiKey}`);
  else {
    result.set("x-api-key", apiKey);
    result.set("anthropic-version", "2023-06-01");
  }
  return result;
}

function statusError(status: number): ProviderCredentialValidationError {
  return new ProviderCredentialValidationError([401, 403].includes(status) ? "unauthorized" : "unavailable");
}

async function boundedJson(response: Response, maximum: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readCoreResponseText(response, maximum, signal)); }
  catch { throw new ProviderCredentialValidationError("invalid_response"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderCredentialValidationError("invalid_response");
  }
  return parsed as Record<string, unknown>;
}

function inferenceHasOutput(protocol: ProviderDefinition["protocol"], body: Record<string, unknown>): boolean {
  if (protocol === "anthropic") {
    return Array.isArray(body.content) && body.content.some((entry) => entry && typeof entry === "object"
      && typeof (entry as { text?: unknown }).text === "string"
      && (entry as { text: string }).text.trim().length > 0);
  }
  return Array.isArray(body.choices) && body.choices.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const message = (entry as { message?: unknown }).message;
    return message && typeof message === "object" && typeof (message as { content?: unknown }).content === "string"
      && (message as { content: string }).content.trim().length > 0;
  });
}

class TeamApiKeyValidator {
  constructor(private readonly fetchImplementation: typeof fetch) {}

  async listModels(input: Readonly<{ provider: string; apiKey: string }>): Promise<readonly string[]> {
    validateKey(input.apiKey);
    const provider = definition(input.provider);
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${provider.baseUrl}/models`, {
        method: "GET", headers: headers(provider, input.apiKey), redirect: "error", signal,
      });
    } catch { throw new ProviderCredentialValidationError("unavailable"); }
    if (!response.ok) throw statusError(response.status);
    const body = await boundedJson(response, MAX_CATALOG_BYTES, signal);
    if (!Array.isArray(body.data)) throw new ProviderCredentialValidationError("invalid_response");
    const models = [...new Set(body.data.map((entry) => entry && typeof entry === "object"
      ? (entry as { id?: unknown }).id : undefined)
      .filter((id): id is string => typeof id === "string" && MODEL.test(id)
        && !id.includes(input.apiKey)))].sort();
    if (models.length === 0 || models.length > 4096) throw new ProviderCredentialValidationError("invalid_response");
    return Object.freeze(models);
  }

  async testInference(input: Readonly<{ provider: string; apiKey: string; model: string }>): Promise<void> {
    validateKey(input.apiKey);
    const provider = definition(input.provider);
    if (!MODEL.test(input.model)) throw new ProviderCredentialValidationError("model_unavailable");
    // Reserve time for the catalog lookup and Vault rotation before ingress
    // closes an idle synchronous request. Slow inference cannot write a key.
    const signal = AbortSignal.timeout(25_000);
    const body = provider.protocol === "anthropic"
      ? { model: input.model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK." }] }
      : { model: input.model, max_tokens: 8, temperature: 0, stream: false,
          messages: [{ role: "user", content: "Reply with exactly OK." }] };
    let response: Response;
    try {
      response = await this.fetchImplementation(`${provider.baseUrl}/${provider.protocol === "anthropic" ? "messages" : "chat/completions"}`, {
        method: "POST",
        headers: new Headers({ ...Object.fromEntries(headers(provider, input.apiKey)), "content-type": "application/json" }),
        body: JSON.stringify(body), redirect: "error", signal,
      });
    } catch { throw new ProviderCredentialValidationError("unavailable"); }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new ProviderCredentialValidationError("unauthorized");
      if (response.status === 404) throw new ProviderCredentialValidationError("model_unavailable");
      throw new ProviderCredentialValidationError("inference_failed");
    }
    const result = await boundedJson(response, MAX_INFERENCE_BYTES, signal);
    if (!inferenceHasOutput(provider.protocol, result)) throw new ProviderCredentialValidationError("inference_failed");
  }
}

async function readCoreResponseBytes(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let rejectAborted!: (reason: unknown) => void;
  let cancellation: Promise<void> | undefined;
  let completed = false;
  let failure: unknown;
  const cancelReader = (reason: unknown): Promise<void> => {
    cancellation ??= reader.cancel(reason).catch(() => undefined);
    return cancellation;
  };
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = (): void => {
    void cancelReader(signal?.reason);
    rejectAborted(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new Error("Managed Core response exceeds the configured limit");
      chunks.push(next.value);
    }
    signal?.throwIfAborted();
    completed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) await cancelReader(failure);
    else await cancellation;
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readCoreResponseText(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<string> {
  return new TextDecoder().decode(await readCoreResponseBytes(response, maximum, signal));
}


export function createTeamApiKeyValidator(transport: typeof fetch) {
  return new TeamApiKeyValidator(transport);
}
