// src/index.mjs
import Schema from "@deepseek-ai/schemastery";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/companion.mjs
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// src/gateway.mjs
import { isIP } from "node:net";
var CompanionError = class extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "CompanionError";
    this.code = code;
    this.status = status;
  }
};
function normalizeGatewayURL(value) {
  if (typeof value !== "string" || value.length > 2048) throw new CompanionError("INVALID_URL", "Enter a valid MultiVibe gateway URL.");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CompanionError("INVALID_URL", "Enter a valid MultiVibe gateway URL.");
  }
  if (url.username || url.password || url.search || url.hash) throw new CompanionError("INVALID_URL", "Credentials, query strings and fragments are not allowed in the gateway URL.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback2 = host === "localhost" || host === "::1" || isIP(host) === 4 && host.startsWith("127.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback2)) throw new CompanionError("INSECURE_URL", "Use HTTPS for remote gateways. HTTP is allowed only on loopback.");
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname !== "" && pathname !== "/v1") throw new CompanionError("INVALID_URL", "Use the public MultiVibe gateway root or its /v1 endpoint.");
  return { origin: url.origin, baseURL: `${url.origin}/v1` };
}
function validateApiKey(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[^\x21-\x7e]/.test(value.trim())) throw new CompanionError("INVALID_KEY", "Enter a nonempty proxy API key without whitespace or control characters.");
  return value.trim();
}
function validateProviderId(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(value)) throw new CompanionError("INVALID_PROVIDER", "Provider ID must contain 3\u201364 lowercase letters, digits or hyphens.");
  return value;
}
var capacity = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2e9 ? value : void 0;
var label = (value, fallback) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) || fallback : fallback;
function normalizeModels(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : payload?.models;
  const entries = Array.isArray(raw) ? raw.map((value) => [void 0, value]) : raw && typeof raw === "object" ? Object.entries(raw) : [];
  if (entries.length > 4096) throw new CompanionError("INVALID_CATALOG", "The gateway returned too many models.", 502);
  const models = /* @__PURE__ */ new Map();
  for (const [key, item] of entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = key ?? item.id;
    if (typeof id !== "string" || !id || id.length > 256 || /[\u0000-\u0020\u007f]/.test(id) || models.has(id)) continue;
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const output = item.output_modalities ?? metadata.output_modalities;
    if (Array.isArray(output) && output.length && !output.includes("text")) continue;
    const model = { id, name: label(item.name ?? item.display_name ?? item.displayName ?? metadata.display_name, id) };
    const contextWindow = capacity(item.contextWindow ?? item.context_window ?? item.context_length ?? item.max_input_tokens ?? item.limit?.context ?? metadata.context_window);
    const maxTokens = capacity(item.maxTokens ?? item.maxOutputTokens ?? item.max_output_tokens ?? item.max_tokens ?? item.limit?.output ?? metadata.max_output_tokens);
    if (contextWindow) model.contextWindow = contextWindow;
    if (maxTokens) model.maxTokens = maxTokens;
    const input = item.inputModalities ?? item.input_modalities ?? item.input ?? metadata.input_modalities;
    if (Array.isArray(input)) model.inputModalities = [...new Set(input.filter((x) => x === "text" || x === "image"))];
    models.set(id, model);
  }
  if (!models.size) throw new CompanionError("EMPTY_CATALOG", "No routable models were returned for this API key.", 502);
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function buildProvider({ baseURL, credentialRef, protocol, models, selectedIds, capacities = {} }) {
  normalizeGatewayURL(baseURL);
  if (!/^MULTIVIBE_DSH_[A-F0-9]{32}$/.test(credentialRef)) throw new CompanionError("INVALID_CREDENTIAL", "Invalid managed credential reference.");
  if (!["openai-completions", "openai-responses"].includes(protocol)) throw new CompanionError("INVALID_PROTOCOL", "Select Chat Completions or Responses.");
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 256 || new Set(selectedIds).size !== selectedIds.length) throw new CompanionError("INVALID_SELECTION", "Select between 1 and 256 distinct models.");
  const catalog = new Map(models.map((model) => [model.id, model]));
  const configured = selectedIds.map((id) => {
    const model = catalog.get(id);
    if (!model) throw new CompanionError("UNKNOWN_MODEL", "A selected model is no longer in the gateway catalog.");
    const contextWindow = model.contextWindow ?? capacity(capacities[id]?.contextWindow);
    const maxTokens = model.maxTokens ?? capacity(capacities[id]?.maxTokens);
    if (!contextWindow || !maxTokens) throw new CompanionError("MISSING_CAPACITY", `Confirm the context and output limits for ${id} before connecting.`);
    if (maxTokens > contextWindow) throw new CompanionError("INVALID_CAPACITY", "Output limit cannot exceed the context window.");
    return { id: model.id, name: model.name, contextWindow, maxTokens, ...model.inputModalities?.length ? { input: model.inputModalities } : {} };
  });
  return { displayName: "MultiVibe", api: protocol, baseURL, apiKeyEnv: credentialRef, models: configured, retryPolicy: { mode: "normal", maxRetries: 0 } };
}
async function requestJSON(url, { apiKey, fetchImpl = globalThis.fetch, signal, timeoutMs = 1e4, maxBytes = 2e6 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = { Accept: "application/json", ...apiKey ? { Authorization: `Bearer ${validateApiKey(apiKey)}` } : {} };
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: combined, headers });
  } catch {
    if (signal?.aborted) throw new CompanionError("CANCELLED", "The request was cancelled.", 499);
    if (timeout.aborted) throw new CompanionError("TIMEOUT", "The gateway did not respond in time.", 504);
    throw new CompanionError("UNREACHABLE", "Cannot reach the MultiVibe gateway. Check its URL and TLS configuration.", 502);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new CompanionError("REDIRECT_REJECTED", "Gateway redirects are not followed. Enter its final trusted URL.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new CompanionError("UNAUTHORIZED", "The proxy API key was rejected.", 401);
    throw new CompanionError("GATEWAY_ERROR", `The gateway returned HTTP ${response.status}.`, 502);
  }
  let bytes = 0;
  const chunks = [];
  const reader = response.body?.getReader();
  if (!reader) throw new CompanionError("INVALID_RESPONSE", "The gateway returned an empty response.", 502);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new CompanionError("RESPONSE_TOO_LARGE", "The gateway response exceeded the safety limit.", 502);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    if (signal?.aborted) throw new CompanionError("CANCELLED", "The request was cancelled.", 499);
    if (timeout.aborted) throw new CompanionError("TIMEOUT", "The gateway did not respond in time.", 504);
    throw new CompanionError("INVALID_RESPONSE", "The gateway did not return valid JSON.", 502);
  } finally {
    reader.releaseLock();
  }
}
async function discoverGateway({ baseURL, apiKey, fetchImpl, signal }) {
  const gateway = normalizeGatewayURL(baseURL);
  const key = validateApiKey(apiKey);
  const models = normalizeModels(await requestJSON(`${gateway.baseURL}/models`, { apiKey: key, fetchImpl, signal }));
  if (JSON.stringify(models).includes(key)) throw new CompanionError("INVALID_CATALOG", "The gateway returned unsafe model metadata.", 502);
  return { baseURL: gateway.baseURL, models };
}
function publicError(error) {
  return error instanceof CompanionError ? { error: { code: error.code, message: error.message }, status: error.status } : { error: { code: "INTERNAL_ERROR", message: "MultiVibe Companion could not complete this operation." }, status: 500 };
}

// src/companion.mjs
var emptyState = () => ({ revision: 0, connection: null, pending: null });
var conflict = () => new CompanionError("CONFLICT", "The configuration changed. Refresh the status before trying again.", 409);
function createCompanion(ctx, { stateKey = "dsh-multivibe/connection", fetchImpl = globalThis.fetch, clock = Date.now, random = randomBytes } = {}) {
  let queue = Promise.resolve();
  const serialize = (action) => {
    const result = queue.then(action);
    queue = result.catch(() => {
    });
    return result;
  };
  async function read() {
    const record = await ctx.credentials.readRecord(stateKey);
    if (!record) return emptyState();
    const state = record.payload;
    if (record.kind !== "grant" || !state || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Object.hasOwn(state, "connection") || !Object.hasOwn(state, "pending")) {
      throw new CompanionError("INVALID_STATE", "The saved companion state could not be read safely.", 503);
    }
    return state;
  }
  async function update(change) {
    await ctx.credentials.modifyRecord(stateKey, (record) => {
      const state = record?.kind === "grant" ? record.payload : emptyState();
      if (!state || !Number.isSafeInteger(state.revision)) throw new CompanionError("INVALID_STATE", "The saved companion state could not be read safely.", 503);
      return { kind: "grant", payload: change(state) };
    });
  }
  function forms() {
    return ctx.settings.describe();
  }
  function formFor(ns) {
    const form = forms().find((item) => item.ns === ns);
    if (!form) throw new CompanionError("PROVIDER_UNAVAILABLE", "The model provider configuration is no longer available.", 503);
    return form;
  }
  async function namespaces() {
    const directory = await ctx.llm.listConfigurableProviders();
    const available = forms();
    const result = /* @__PURE__ */ new Map();
    for (const item of directory) {
      if (!Array.isArray(item.settingsPath) || item.settingsPath[0] !== "providers" || !available.some((form2) => form2.ns === item.settingsNs)) continue;
      const form = available.find((form2) => form2.ns === item.settingsNs);
      const schema = form.schema;
      const resolve = (node) => typeof node === "number" || typeof node === "string" ? schema?.refs?.[node] : node;
      const root = schema?.refs ? resolve(schema.uid) : schema;
      const dictionary = resolve(root?.dict?.providers);
      const profile = resolve(dictionary?.inner ?? dictionary?.value);
      if (!profile?.dict || !["apiKeyEnv", "baseURL", "models"].every((field) => Object.hasOwn(profile.dict, field))) continue;
      result.set(item.settingsNs, { settingsNs: item.settingsNs, displayName: item.settingsNs });
    }
    return [...result.values()];
  }
  function currentProvider(connection) {
    return formFor(connection.settingsNs).user?.providers?.[connection.providerId];
  }
  async function configuredProviders(connection) {
    const allowed = new Set((await namespaces()).map((item) => item.settingsNs));
    const result = [];
    for (const form of forms()) {
      if (!allowed.has(form.ns)) continue;
      for (const [providerId, config] of Object.entries(form.value?.providers ?? {})) {
        if (!config || typeof config !== "object" || typeof config.baseURL !== "string") continue;
        let baseURL;
        try {
          baseURL = normalizeGatewayURL(config.baseURL).baseURL;
        } catch {
          continue;
        }
        const endpoint = new URL(baseURL);
        const known = baseURL === connection?.baseURL || /multivibe/i.test(`${providerId} ${config.displayName ?? ""}`) || ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) && endpoint.port === "1455";
        if (!known || connection?.settingsNs === form.ns && connection?.providerId === providerId) continue;
        const models = (Array.isArray(config.models) ? config.models : []).slice(0, 256).filter((model) => model && typeof model.id === "string").map((model) => ({
          id: model.id.slice(0, 512),
          name: typeof model.name === "string" ? model.name.slice(0, 512) : model.id.slice(0, 512),
          ...Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
          ...Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}
        }));
        const credentialConfigured = typeof config.apiKeyEnv === "string" && (await ctx.credentials.describe(config.apiKeyEnv)).configured === true;
        result.push({
          providerId,
          settingsNs: form.ns,
          displayName: typeof config.displayName === "string" ? config.displayName.slice(0, 160) : providerId,
          baseURL,
          protocol: ["openai-completions", "openai-responses"].includes(config.api) ? config.api : null,
          credentialConfigured,
          models
        });
      }
    }
    return result;
  }
  async function status() {
    const state = await read();
    let matches = false;
    if (state.connection) {
      try {
        matches = isDeepStrictEqual(currentProvider(state.connection), state.connection.providerConfig);
      } catch {
      }
    }
    const configured = state.connection ? (await ctx.credentials.describe(state.connection.credentialRef)).configured : false;
    return {
      revision: state.revision,
      connected: Boolean(state.connection && matches && configured && !state.pending),
      pending: Boolean(state.pending),
      connection: state.connection ? {
        providerId: state.connection.providerId,
        baseURL: state.connection.baseURL,
        protocol: state.connection.providerConfig.api,
        modelCount: state.connection.providerConfig.models.length,
        connectedAt: state.connection.connectedAt,
        modified: !matches,
        credentialConfigured: configured
      } : null,
      providers: await namespaces(),
      existingProviders: await configuredProviders(state.connection),
      retainedCredentialRefs: state.retainedCredentialRefs ?? []
    };
  }
  function checkRevision(input, state) {
    if (!input || !Number.isSafeInteger(input.revision) || input.revision !== state.revision) throw conflict();
  }
  async function discover(input, signal) {
    return discoverGateway({ baseURL: input?.baseURL, apiKey: input?.apiKey, fetchImpl, signal });
  }
  async function active() {
    const state = await read();
    if (!state.connection || state.pending) throw new CompanionError("NOT_CONNECTED", "Connect MultiVibe in Settings > Plugins > MultiVibe first.");
    if (!isDeepStrictEqual(currentProvider(state.connection), state.connection.providerConfig)) throw new CompanionError("PROVIDER_MODIFIED", "The managed provider was edited outside the companion. Restore it or disconnect manually.", 409);
    const secret = await ctx.credentials.resolve(state.connection.credentialRef);
    if (!secret?.value) throw new CompanionError("MISSING_CREDENTIAL", "The managed proxy API key is not configured.", 401);
    return { ...state.connection, apiKey: secret.value };
  }
  async function catalog(signal) {
    const connection = await active();
    return discoverGateway({ baseURL: connection.baseURL, apiKey: connection.apiKey, fetchImpl, signal });
  }
  async function health(signal) {
    const connection = await active();
    const { origin } = normalizeGatewayURL(connection.baseURL);
    const result = await requestJSON(`${origin}/health`, { fetchImpl, signal });
    return { ok: result?.ok === true };
  }
  async function acquire(input, pending, requiredConnection) {
    await update((state) => {
      checkRevision(input, state);
      if (state.pending) throw new CompanionError("RECOVERY_REQUIRED", "An incomplete operation needs recovery before another change.", 409);
      if (requiredConnection === false && state.connection) throw new CompanionError("ALREADY_CONNECTED", "Disconnect the existing managed provider before connecting another gateway.", 409);
      if (requiredConnection === true && !state.connection) throw new CompanionError("NOT_CONNECTED", "No managed provider is connected.");
      return { ...state, revision: state.revision + 1, pending };
    });
  }
  async function finish(pending, connection) {
    await update((state) => {
      if (state.pending?.id !== pending.id) throw conflict();
      const retainedCredentialRefs = new Set(state.retainedCredentialRefs ?? []);
      if (pending.kind === "disconnect" && pending.removeCredential !== true) retainedCredentialRefs.add(pending.connection.credentialRef);
      return { revision: state.revision + 1, connection, pending: null, retainedCredentialRefs: [...retainedCredentialRefs] };
    });
  }
  async function removeOwnedProvider(connection) {
    const form = formFor(connection.settingsNs);
    const value = form.user?.providers?.[connection.providerId];
    if (value === void 0 && form.value?.providers?.[connection.providerId] === void 0) return;
    if (!isDeepStrictEqual(value, connection.providerConfig)) throw new CompanionError("PROVIDER_MODIFIED", "The provider changed outside the companion. No configuration or credential was removed.", 409);
    if (form.base?.providers?.[connection.providerId] !== void 0) throw new CompanionError("PROVIDER_MODIFIED", "An inherited provider now uses this ID. Remove the managed provider manually.", 409);
    await ctx.settings.mutate(connection.settingsNs, [{ op: "unset", path: ["providers", connection.providerId] }], form.revision);
    if (formFor(connection.settingsNs).value?.providers?.[connection.providerId] !== void 0) throw new CompanionError("RECOVERY_REQUIRED", "The provider removal did not complete.", 409);
  }
  async function removeUnusedCredential(ref) {
    const marker = JSON.stringify(ref);
    if (forms().some((form) => JSON.stringify(form.value).includes(marker))) throw new CompanionError("CREDENTIAL_IN_USE", "Another configuration references the managed credential. It was not removed.", 409);
    await ctx.credentials.unset(ref);
  }
  async function compensate(pending) {
    await removeOwnedProvider(pending.connection);
    if (pending.kind === "connect" || pending.removeCredential === true) await removeUnusedCredential(pending.connection.credentialRef);
    await finish(pending, null);
  }
  async function connect(input, signal) {
    return serialize(async () => {
      const state = await read();
      checkRevision(input, state);
      if (state.connection) throw new CompanionError("ALREADY_CONNECTED", "Disconnect the existing managed provider before connecting another gateway.", 409);
      if (state.pending) throw new CompanionError("RECOVERY_REQUIRED", "Recover the incomplete operation first.", 409);
      const providerId = validateProviderId(input.providerId);
      if (!(await namespaces()).some((item) => item.settingsNs === input.settingsNs)) throw new CompanionError("PROVIDER_UNAVAILABLE", "Select an available configurable model adapter.");
      const discovered = await discover(input, signal);
      const form = formFor(input.settingsNs);
      if (form.value?.providers?.[providerId] !== void 0 || form.base?.providers?.[providerId] !== void 0 || (await ctx.llm.listProviders()).some((item) => item.id === providerId)) {
        throw new CompanionError("PROVIDER_EXISTS", "That provider ID already exists. Choose a new ID; existing providers are never overwritten.", 409);
      }
      const credentialRef = `MULTIVIBE_DSH_${random(16).toString("hex").toUpperCase()}`;
      const description = await ctx.credentials.describe(credentialRef);
      if (description.configured || !description.writable) throw new CompanionError("CREDENTIAL_READ_ONLY", "A new writable credential reference could not be allocated.", 403);
      const providerConfig = buildProvider({ ...input, models: discovered.models, baseURL: discovered.baseURL, credentialRef });
      const connection = { providerId, settingsNs: input.settingsNs, credentialRef, baseURL: discovered.baseURL, providerConfig, connectedAt: clock() };
      const pending = { id: random(16).toString("hex"), kind: "connect", connection };
      signal?.throwIfAborted();
      await acquire(input, pending, false);
      try {
        await ctx.credentials.set(credentialRef, input.apiKey.trim());
        await ctx.settings.mutate(input.settingsNs, [{ op: "set", path: ["providers", providerId], value: providerConfig }], form.revision);
        if (!isDeepStrictEqual(currentProvider(connection), providerConfig)) throw new CompanionError("PROVIDER_MODIFIED", "The provider did not accept the exact managed configuration.", 409);
        await finish(pending, connection);
      } catch (error) {
        const latest = await read();
        if (!latest.pending && latest.connection?.credentialRef === credentialRef) return status();
        try {
          await compensate(pending);
        } catch {
          throw new CompanionError("RECOVERY_REQUIRED", "The operation could not be safely restored. Use Recover in the companion; no unrelated provider is overwritten.", 409);
        }
        if (error instanceof CompanionError) throw error;
        if (error?.name === "SettingsConflictError" || error?.code === "SETTINGS_CONFLICT") throw conflict();
        throw new CompanionError("CONNECT_FAILED", "DSH rejected the provider configuration. The managed changes were restored.", 503);
      }
      return status();
    });
  }
  async function disconnect(input) {
    return serialize(async () => {
      const state = await read();
      checkRevision(input, state);
      if (!state.connection) throw new CompanionError("NOT_CONNECTED", "No managed provider is connected.");
      const form = formFor(state.connection.settingsNs);
      const absent = form.user?.providers?.[state.connection.providerId] === void 0 && form.value?.providers?.[state.connection.providerId] === void 0;
      if (!absent && !isDeepStrictEqual(currentProvider(state.connection), state.connection.providerConfig)) throw new CompanionError("PROVIDER_MODIFIED", "The provider was edited outside the companion. No configuration or credential was removed.", 409);
      const pending = { id: random(16).toString("hex"), kind: "disconnect", connection: state.connection, removeCredential: input.removeCredential === true };
      await acquire(input, pending, true);
      try {
        await compensate(pending);
      } catch {
        throw new CompanionError("RECOVERY_REQUIRED", "Disconnect is incomplete. Use Recover to finish removing only the managed provider and unused credential.", 409);
      }
      return status();
    });
  }
  async function recover(input) {
    return serialize(async () => {
      const state = await read();
      checkRevision(input, state);
      if (!state.pending) return status();
      await compensate(state.pending);
      return status();
    });
  }
  return { status, discover, catalog, health, connect, disconnect, recover };
}

// src/routes.mjs
var loopback = (hostname) => hostname === "localhost" || hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
function assertLocalMutation(request) {
  const host = request.headers.get("host");
  let authority;
  try {
    if (!host) throw new Error("missing authority");
    authority = new URL(`http://${host}`);
    if (authority.username || authority.password || authority.pathname !== "/" || authority.search || authority.hash) throw new Error("invalid authority");
  } catch {
    throw new CompanionError("REMOTE_READ_ONLY", "Connection changes require a valid loopback HTTP authority.", 403);
  }
  if (!loopback(authority.hostname)) throw new CompanionError("REMOTE_READ_ONLY", "Connection changes are available only in Desktop or a loopback DSH interface.", 403);
  const origin = request.headers.get("origin");
  if (origin) {
    let sameOrigin = false;
    try {
      const parsed = new URL(origin);
      sameOrigin = ["http:", "https:"].includes(parsed.protocol) && parsed.host === authority.host;
    } catch {
    }
    if (!sameOrigin) throw new CompanionError("ORIGIN_REJECTED", "Cross-origin configuration changes are not allowed.", 403);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new CompanionError("INVALID_REQUEST", "Send a JSON request.", 415);
}
async function readInput(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new CompanionError("INVALID_REQUEST", "Send a JSON request.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) {
        await reader.cancel();
        throw new CompanionError("REQUEST_TOO_LARGE", "The configuration request is too large.", 413);
      }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("object required");
    return input;
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw new CompanionError("INVALID_REQUEST", "Send a valid JSON object.");
  } finally {
    reader.releaseLock();
  }
}
function registerCompanion(ctx, companion, makeTool) {
  const json = async (action) => {
    try {
      return Response.json(await action(), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const safe = publicError(error);
      return Response.json({ error: safe.error }, { status: safe.status, headers: { "Cache-Control": "no-store" } });
    }
  };
  for (const endpoint of ["status", "catalog"]) {
    ctx.connection.fetch.register({
      path: `/api/multivibe/${endpoint}`,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request) => json(() => endpoint === "status" ? companion.status() : companion.catalog(request.signal))
    });
  }
  for (const endpoint of ["discover", "connect", "disconnect", "recover"]) {
    ctx.connection.fetch.register({
      path: `/api/multivibe/${endpoint}`,
      methods: ["POST"],
      requestBody: "streaming",
      fetch: (request) => json(async () => {
        assertLocalMutation(request);
        return companion[endpoint](await readInput(request), request.signal);
      })
    });
  }
  const output = { schema: { type: "object", properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] };
  const safeExecute = (action) => async (args, exec) => {
    try {
      return await action(args, exec);
    } catch (error) {
      const safe = publicError(error);
      const failure = new Error(safe.error.message);
      failure.code = safe.error.code;
      throw failure;
    }
  };
  ctx.tools.register(makeTool({
    name: "multivibe_status",
    description: "Read whether the operator-configured MultiVibe model provider is connected. Does not configure providers, reveal credentials, run inference, or access administration.",
    parameters: {},
    output,
    timeoutMs: 12e3,
    isConcurrencySafe: () => true,
    execute: safeExecute(async (_args, exec) => {
      exec.signal.throwIfAborted();
      const state = await companion.status();
      return {
        connected: state.connected,
        recoveryRequired: state.pending,
        provider: state.connection?.providerId ?? null,
        protocol: state.connection?.protocol ?? null,
        configuredModels: state.connection?.modelCount ?? 0
      };
    })
  }));
  ctx.tools.register(makeTool({
    name: "multivibe_models",
    description: "List routable models from the operator-configured MultiVibe gateway using its dedicated proxy key. Capabilities not returned by the gateway remain unknown. Read-only; no inference or admin access.",
    parameters: { search: { type: "string", description: "Optional case-insensitive model ID/name filter." }, limit: { type: "integer", description: "Maximum number of returned models, clamped to 1\u2013100; default 50." } },
    output,
    timeoutMs: 12e3,
    isConcurrencySafe: () => true,
    execute: safeExecute(async (args, exec) => {
      const catalog = await companion.catalog(exec.signal);
      const search = typeof args.search === "string" ? args.search.slice(0, 256).toLowerCase() : "";
      const matches = catalog.models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(search));
      const limit = Math.max(1, Math.min(100, Number.isSafeInteger(args.limit) ? args.limit : 50));
      return { models: matches.slice(0, limit), total: matches.length, truncated: matches.length > limit };
    })
  }));
}

// src/index.mjs
var name = "dsh-multivibe";
var inject = ["credentials", "connection", "tools", "llm", "settings"];
var Config = Schema.object({});
function apply(ctx) {
  registerCompanion(ctx, createCompanion(ctx, { stateKey: credentialKey(name, "connection") }), defineTool);
}
export {
  Config,
  apply,
  inject,
  name
};
