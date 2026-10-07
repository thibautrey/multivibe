import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCompanion, assertLocalMutation, readInput } from '../src/routes.mjs';

const request = (url = 'http://127.0.0.1:43129/api/multivibe/connect', body = '{}', headers = {}) => new Request(url, { method: 'POST', headers: { host: new URL(url).host, 'content-type': 'application/json', ...headers }, body });
const code = value => error => error.code === value;

test('operator mutations require loopback, same origin and JSON', () => {
  assert.doesNotThrow(() => assertLocalMutation(request()));
  assert.doesNotThrow(() => assertLocalMutation(request('http://localhost:43129/api/multivibe/connect', '{}', { origin: 'http://localhost:43129' })));
  assert.throws(() => assertLocalMutation(request('https://remote.example/api/multivibe/connect')), code('REMOTE_READ_ONLY'));
  assert.throws(() => assertLocalMutation(request(undefined, '{}', { origin: 'https://evil.example' })), code('ORIGIN_REJECTED'));
  assert.throws(() => assertLocalMutation(request(undefined, '{}', { 'content-type': 'text/plain' })), code('INVALID_REQUEST'));
});
test('real DSH bridge URLs use the trusted Host header and never forwarded authority', () => {
  assert.doesNotThrow(() => assertLocalMutation(request('http://dsh.internal/api/multivibe/connect', '{}', { host: '127.0.0.1:43129', origin: 'http://127.0.0.1:43129' })));
  assert.throws(() => assertLocalMutation(request('http://dsh.internal/api/multivibe/connect', '{}', { host: 'remote.example', 'x-forwarded-host': 'localhost' })), code('REMOTE_READ_ONLY'));
  assert.throws(() => assertLocalMutation(new Request('http://dsh.internal/api/multivibe/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })), code('REMOTE_READ_ONLY'));
  assert.throws(() => assertLocalMutation(request(undefined, '{}', { origin: 'null' })), code('ORIGIN_REJECTED'));
});

test('input body is bounded and must be a JSON object', async () => {
  assert.deepEqual(await readInput(request(undefined, '{"revision":0}')), { revision: 0 });
  for (const body of ['[]', 'null', 'invalid']) await assert.rejects(readInput(request(undefined, body)), code('INVALID_REQUEST'));
  await assert.rejects(readInput(request(undefined, 'x'.repeat(131073))), code('REQUEST_TOO_LARGE'));
});
test('all business routes use authenticated Connection registration, not raw webServer', async () => {
  const routes = [];
  const tools = [];
  const companion = { status: async () => ({ connected: false, pending: false, connection: null }), discover: async () => ({ models: [] }) };
  registerCompanion({ connection: { fetch: { register: route => routes.push(route) } }, tools: { register: tool => tools.push(tool) } }, companion, definition => definition);
  assert.equal(routes.length, 6);
  assert.deepEqual(tools.map(tool => tool.name), ['multivibe_status', 'multivibe_models']);
  assert.equal(routes.every(route => route.path.startsWith('/api/multivibe/')), true);
  const status = await routes.find(route => route.path.endsWith('/status')).fetch(new Request('http://localhost/api/multivibe/status'));
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await status.json()).connected, false);
  const rejected = await routes.find(route => route.path.endsWith('/connect')).fetch(request(undefined, '{}', { origin: 'https://evil.example' }));
  assert.equal(rejected.status, 403);
});
test('unknown backend errors are redacted and model-facing status omits endpoint/credential', async () => {
  const routes = []; const tools = [];
  const companion = { status: async () => ({ connected: true, pending: false, connection: { providerId: 'multivibe', protocol: 'openai-completions', modelCount: 1, baseURL: 'https://private.example', credentialRef: 'secret_ref' } }),
    catalog: async () => { throw new Error('mv_fake_key'); } };
  registerCompanion({ connection: { fetch: { register: route => routes.push(route) } }, tools: { register: tool => tools.push(tool) } }, companion, definition => definition);
  const status = await tools[0].execute({}, { signal: new AbortController().signal });
  assert.equal(JSON.stringify(status).includes('private.example'), false);
  assert.equal(JSON.stringify(status).includes('secret_ref'), false);
  const failed = await routes.find(route => route.path.endsWith('/catalog')).fetch(new Request('http://localhost/api/multivibe/catalog'));
  assert.equal(failed.status, 500);
  assert.equal(JSON.stringify(await failed.json()).includes('mv_fake_key'), false);
  await assert.rejects(tools[1].execute({}, { signal: new AbortController().signal }), error => !error.message.includes('mv_fake_key'));
});
test('read-only model tool propagates cancellation and bounds results', async () => {
  const tools = []; let signal;
  registerCompanion({ connection: { fetch: { register: () => {} } }, tools: { register: tool => tools.push(tool) } }, {
    catalog: async received => { signal = received; return { models: [{ id: 'alpha', name: 'A' }, { id: 'beta', name: 'B' }] }; },
  }, definition => definition);
  const controller = new AbortController();
  const result = await tools[1].execute({ limit: 1 }, { signal: controller.signal });
  assert.equal(signal, controller.signal);
  assert.equal(result.models.length, 1);
  assert.equal(result.total, 2);
  assert.equal(result.truncated, true);
});
