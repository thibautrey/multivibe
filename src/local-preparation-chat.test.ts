import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPreparedLocalChat } from './local-preparation-chat.js';
import type { AccountStore } from './store.js';
import type { Account } from './types.js';
const model = `multivibe-local-${'a'.repeat(32)}:latest`;
function fixture() {
  let accounts: Account[] = [];
  const store = { listAccounts: async () => accounts, addOrUpdate: async (account: Account) => { accounts = [account]; } } as unknown as AccountStore;
  const calls: string[] = [];
  const options = { store, model, runtimeOrigin: 'http://127.0.0.1:11434', edgeOrigin: 'http://127.0.0.1:1455',
    proxyKey: 'test-only-key', signal: new AbortController().signal,
    attest: async () => { calls.push('attest'); },
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      assert.equal(init?.redirect, 'error');
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: model }] });
      assert.equal(url, 'http://127.0.0.1:1455/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only-key');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, model); assert.equal(body.stream, false); assert.equal(body.max_tokens, 32);
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply with the word OK.' }]);
      return Response.json({ model, choices: [{ message: { content: 'OK' } }] });
    }) as typeof fetch,
  };
  return { options, calls, setAccounts: (value: Account[]) => { accounts = value; } };
}
test('registers only the owned endpoint and probes the Rust chat route, not just model listing', async () => {
  const { options, calls } = fixture();
  await verifyPreparedLocalChat(options);
  assert.deepEqual(calls, ['attest', 'http://127.0.0.1:11434/v1/models', 'attest', 'http://127.0.0.1:1455/v1/chat/completions', 'attest']);
});
test('rejects remote origins, runtime-as-edge, non-private aliases and failed attestation before discovery', async () => {
  for (const change of [{ runtimeOrigin: 'https://cloud.example' }, { edgeOrigin: 'http://127.0.0.1:11434' },
    { edgeOrigin: 'http://localhost:1455' }, { runtimeOrigin: 'http://127.0.0.1:11434/path' }, { model: 'remote-model' },
    { attest: async () => { throw Error('not-owned'); } }]) {
    const { options, calls } = fixture();
    await assert.rejects(verifyPreparedLocalChat({ ...options, ...change }));
    assert.deepEqual(calls, []);
  }
});
test('preserves a disabled local account without registering or testing it', async () => {
  const { options, calls, setAccounts } = fixture();
  setAccounts([{ enabled: false, localRuntime: { adapter: 'ollama' } } as Account]);
  await assert.rejects(verifyPreparedLocalChat(options), /chat_route_not_ready/);
  assert.deepEqual(calls, ['attest']);
});
test('model listing alone, an empty answer or another response model never proves chat readiness', async () => {
  for (const result of [Response.json({ error: 'unavailable' }, { status: 503 }),
    Response.json({ model, choices: [{ message: { content: '' } }] }),
    Response.json({ model: 'other', choices: [{ message: { content: 'OK' } }] }),
    new Response('x'.repeat(65537))]) {
    const { options } = fixture(); const original = options.fetchFn;
    options.fetchFn = async (input, init) => String(input).includes('/chat/completions') ? result : original(input, init);
    await assert.rejects(verifyPreparedLocalChat(options), /chat_route_not_ready/);
  }
});
