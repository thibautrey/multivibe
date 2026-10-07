import { isIP } from 'node:net';

export class CompanionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CompanionError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeGatewayURL(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new CompanionError('INVALID_URL', 'Enter a valid MultiVibe gateway URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new CompanionError('INVALID_URL', 'Enter a valid MultiVibe gateway URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new CompanionError('INVALID_URL', 'Credentials, query strings and fragments are not allowed in the gateway URL.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new CompanionError('INSECURE_URL', 'Use HTTPS for remote gateways. HTTP is allowed only on loopback.');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '' && pathname !== '/v1') throw new CompanionError('INVALID_URL', 'Use the public MultiVibe gateway root or its /v1 endpoint.');
  return { origin: url.origin, baseURL: `${url.origin}/v1` };
}

export function validateApiKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[^\x21-\x7e]/.test(value.trim())) throw new CompanionError('INVALID_KEY', 'Enter a nonempty proxy API key without whitespace or control characters.');
  return value.trim();
}

export function validateProviderId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(value)) throw new CompanionError('INVALID_PROVIDER', 'Provider ID must contain 3–64 lowercase letters, digits or hyphens.');
  return value;
}

const capacity = value => Number.isSafeInteger(value) && value > 0 && value <= 2_000_000_000 ? value : undefined;
const label = (value, fallback) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || fallback : fallback;

export function normalizeModels(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : payload?.models;
  const entries = Array.isArray(raw) ? raw.map(value => [undefined, value]) : raw && typeof raw === 'object' ? Object.entries(raw) : [];
  if (entries.length > 4096) throw new CompanionError('INVALID_CATALOG', 'The gateway returned too many models.', 502);
  const models = new Map();
  for (const [key, item] of entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = key ?? item.id;
    if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u0020\u007f]/.test(id) || models.has(id)) continue;
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const output = item.output_modalities ?? metadata.output_modalities;
    if (Array.isArray(output) && output.length && !output.includes('text')) continue;
    const model = { id, name: label(item.name ?? item.display_name ?? item.displayName ?? metadata.display_name, id) };
    const contextWindow = capacity(item.contextWindow ?? item.context_window ?? item.context_length ?? item.max_input_tokens ?? item.limit?.context ?? metadata.context_window);
    const maxTokens = capacity(item.maxTokens ?? item.maxOutputTokens ?? item.max_output_tokens ?? item.max_tokens ?? item.limit?.output ?? metadata.max_output_tokens);
    if (contextWindow) model.contextWindow = contextWindow;
    if (maxTokens) model.maxTokens = maxTokens;
    const input = item.inputModalities ?? item.input_modalities ?? item.input ?? metadata.input_modalities;
    if (Array.isArray(input)) model.inputModalities = [...new Set(input.filter(x => x === 'text' || x === 'image'))];
    models.set(id, model);
  }
  if (!models.size) throw new CompanionError('EMPTY_CATALOG', 'No routable models were returned for this API key.', 502);
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildProvider({ baseURL, credentialRef, protocol, models, selectedIds, capacities = {} }) {
  normalizeGatewayURL(baseURL);
  if (!/^MULTIVIBE_DSH_[A-F0-9]{32}$/.test(credentialRef)) throw new CompanionError('INVALID_CREDENTIAL', 'Invalid managed credential reference.');
  if (!['openai-completions', 'openai-responses'].includes(protocol)) throw new CompanionError('INVALID_PROTOCOL', 'Select Chat Completions or Responses.');
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 256 || new Set(selectedIds).size !== selectedIds.length) throw new CompanionError('INVALID_SELECTION', 'Select between 1 and 256 distinct models.');
  const catalog = new Map(models.map(model => [model.id, model]));
  const configured = selectedIds.map(id => {
    const model = catalog.get(id);
    if (!model) throw new CompanionError('UNKNOWN_MODEL', 'A selected model is no longer in the gateway catalog.');
    const contextWindow = model.contextWindow ?? capacity(capacities[id]?.contextWindow);
    const maxTokens = model.maxTokens ?? capacity(capacities[id]?.maxTokens);
    if (!contextWindow || !maxTokens) throw new CompanionError('MISSING_CAPACITY', `Confirm the context and output limits for ${id} before connecting.`);
    if (maxTokens > contextWindow) throw new CompanionError('INVALID_CAPACITY', 'Output limit cannot exceed the context window.');
    return { id: model.id, name: model.name, contextWindow, maxTokens, ...(model.inputModalities?.length ? { input: model.inputModalities } : {}) };
  });
  return { displayName: 'MultiVibe', api: protocol, baseURL, apiKeyEnv: credentialRef, models: configured, retryPolicy: { mode: 'normal', maxRetries: 0 } };
}

export async function requestJSON(url, { apiKey, fetchImpl = globalThis.fetch, signal, timeoutMs = 10_000, maxBytes = 2_000_000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${validateApiKey(apiKey)}` } : {}) };
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: combined, headers });
  } catch {
    if (signal?.aborted) throw new CompanionError('CANCELLED', 'The request was cancelled.', 499);
    if (timeout.aborted) throw new CompanionError('TIMEOUT', 'The gateway did not respond in time.', 504);
    throw new CompanionError('UNREACHABLE', 'Cannot reach the MultiVibe gateway. Check its URL and TLS configuration.', 502);
  }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new CompanionError('REDIRECT_REJECTED', 'Gateway redirects are not followed. Enter its final trusted URL.', 502); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new CompanionError('UNAUTHORIZED', 'The proxy API key was rejected.', 401);
    throw new CompanionError('GATEWAY_ERROR', `The gateway returned HTTP ${response.status}.`, 502);
  }
  let bytes = 0;
  const chunks = [];
  const reader = response.body?.getReader();
  if (!reader) throw new CompanionError('INVALID_RESPONSE', 'The gateway returned an empty response.', 502);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new CompanionError('RESPONSE_TOO_LARGE', 'The gateway response exceeded the safety limit.', 502); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    if (signal?.aborted) throw new CompanionError('CANCELLED', 'The request was cancelled.', 499);
    if (timeout.aborted) throw new CompanionError('TIMEOUT', 'The gateway did not respond in time.', 504);
    throw new CompanionError('INVALID_RESPONSE', 'The gateway did not return valid JSON.', 502);
  } finally { reader.releaseLock(); }
}

export async function discoverGateway({ baseURL, apiKey, fetchImpl, signal }) {
  const gateway = normalizeGatewayURL(baseURL);
  const key = validateApiKey(apiKey);
  const models = normalizeModels(await requestJSON(`${gateway.baseURL}/models`, { apiKey: key, fetchImpl, signal }));
  if (JSON.stringify(models).includes(key)) throw new CompanionError('INVALID_CATALOG', 'The gateway returned unsafe model metadata.', 502);
  return { baseURL: gateway.baseURL, models };
}

export function publicError(error) {
  return error instanceof CompanionError ? { error: { code: error.code, message: error.message }, status: error.status }
    : { error: { code: 'INTERNAL_ERROR', message: 'MultiVibe Companion could not complete this operation.' }, status: 500 };
}
