import type { AccountStore } from './store.js';
import { discoverAndPersistLocalRuntimes, LOCAL_RUNTIME_ADAPTERS } from './local-runtime-discovery.js';

const privateModel = /^multivibe-local-[a-f0-9]{32}:latest$/;
function loopbackOrigin(value: string, port?: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw Error('chat_route_not_ready'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
      (port && url.port !== port) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw Error('chat_route_not_ready');
  }
  return url.origin;
}
/** Verify the same reserved local-only route the chat UI will use. The Rust edge
 * must include its multivibe-local-* fence; never substitute a runtime-only probe.
 * attest checks the owned runtime through the private supervisor before and after
 * route discovery/inference. No public-worker projection or Cloud route is used.
 */
export async function verifyPreparedLocalChat(options: {
  store: AccountStore;
  model: string;
  runtimeOrigin: string;
  edgeOrigin: string;
  proxyKey?: string;
  signal: AbortSignal;
  attest(signal: AbortSignal): Promise<void>;
  fetchFn?: typeof fetch;
}): Promise<void> {
  if (!privateModel.test(options.model)) throw Error('chat_route_not_ready');
  const runtimeOrigin = loopbackOrigin(options.runtimeOrigin, '11434');
  const edgeOrigin = loopbackOrigin(options.edgeOrigin);
  if (runtimeOrigin === edgeOrigin) throw Error('chat_route_not_ready');
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
  const fetchFn = options.fetchFn ?? fetch;
  signal.throwIfAborted();
  await options.attest(signal);
  const existing = (await options.store.listAccounts()).filter(account => account.localRuntime?.adapter === 'ollama');
  // Do not take over a user-configured or disabled account, nor redirect another
  // discovered Ollama endpoint just to make this preparation appear successful.
  if (existing.some(account => account.enabled === false || account.accessToken ||
      account.localRuntime?.source !== 'multivibe-local-discovery' || account.baseUrl !== runtimeOrigin)) {
    throw Error('chat_route_not_ready');
  }
  const adapter = LOCAL_RUNTIME_ADAPTERS.find(adapter => adapter.id === 'ollama')!;
  signal.throwIfAborted();
  const discovery = await discoverAndPersistLocalRuntimes(options.store, {
    adapters: [{ ...adapter, candidates: [{ endpoint: runtimeOrigin, modelsUrl: `${runtimeOrigin}/v1/models` }] }],
    fetchFn: (input, init) => fetchFn(input, { ...init, redirect: 'error',
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
    // Discovery must not scan local files if this exact running endpoint fails.
    filesystem: { readdir: async () => { throw Error('unavailable'); }, readFile: async () => { throw Error('unavailable'); } },
  });
  signal.throwIfAborted();
  if (!discovery.accounts.some(account => account.enabled !== false && account.provider === 'openai-compatible' &&
      account.location === 'local' && account.baseUrl === runtimeOrigin && !account.accessToken &&
      account.localRuntime?.authentication === 'none' && account.localRuntime.confirmedModelIds?.includes(options.model))) {
    throw Error('chat_route_not_ready');
  }
  await options.attest(signal);
  const response = await fetchFn(`${edgeOrigin}/v1/chat/completions`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', ...(options.proxyKey ? { authorization: `Bearer ${options.proxyKey}` } : {}) },
    body: JSON.stringify({ model: options.model, messages: [{ role: 'user', content: 'Reply with the word OK.' }], max_tokens: 32, stream: false }),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw Error('chat_route_not_ready');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 64 * 1024) throw Error('chat_route_not_ready');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('chat_route_not_ready'); }
  if (result.model !== options.model || typeof result.choices?.[0]?.message?.content !== 'string' ||
      !result.choices[0].message.content.trim()) throw Error('chat_route_not_ready');
  await options.attest(signal);
  signal.throwIfAborted();
}
