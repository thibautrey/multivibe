import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { normalizeGatewayURL, validateApiKey, normalizeModels, buildProvider, requestJSON, discoverGateway, publicError } from '../src/gateway.mjs';

const code = value => error => error.code === value;
const model = { id: 'coding/model', name: 'Coding model', contextWindow: 8192, maxTokens: 2048 };
const provider = (extra = {}) => buildProvider({ baseURL: 'http://127.0.0.1:1455/v1', credentialRef: `MULTIVIBE_DSH_${'A'.repeat(32)}`, protocol: 'openai-completions', models: [model], selectedIds: [model.id], ...extra });

test('normalizes only gateway root/v1, accepts HTTPS and HTTP loopback', () => {
  assert.deepEqual(normalizeGatewayURL('http://127.0.0.1:1455/'), { origin: 'http://127.0.0.1:1455', baseURL: 'http://127.0.0.1:1455/v1' });
  assert.equal(normalizeGatewayURL('http://[::1]:1455/v1/').baseURL, 'http://[::1]:1455/v1');
  assert.equal(normalizeGatewayURL('https://gateway.example').baseURL, 'https://gateway.example/v1');
});
test('rejects insecure remote URLs and credential/query/path injection', () => {
  for (const url of ['http://192.168.1.2:1455', 'http://localhost.evil.test', 'ftp://localhost', 'http://127.0.0.1.evil.test', 'https://user:secret@gateway.example', 'https://gateway.example?key=secret', 'https://gateway.example#secret', 'https://gateway.example/admin']) assert.throws(() => normalizeGatewayURL(url));
});
test('validates proxy keys without preserving whitespace/control characters', () => {
  assert.equal(validateApiKey(' mv_fake_key '), 'mv_fake_key');
  for (const key of ['', 'a\nb', 'a b', 'a\rb', 'x'.repeat(4097)]) assert.throws(() => validateApiKey(key), code('INVALID_KEY'));
});
test('catalog deduplicates, filters malformed IDs and keeps unknown capabilities unknown', () => {
  const models = normalizeModels({ data: [{ id: 'plain' }, { id: 'plain' }, null, { id: 'bad\nmodel' }, { id: 'rich', context_window: 4096, max_output_tokens: 512, input: ['text', 'image', 'video'] }] });
  assert.deepEqual(models[0], { id: 'plain', name: 'plain' });
  assert.deepEqual(models[1], { id: 'rich', name: 'rich', contextWindow: 4096, maxTokens: 512, inputModalities: ['text', 'image'] });
});
test('rich catalog object key is the authoritative routable ID', () => {
  assert.equal(normalizeModels({ models: { alias: { id: 'different', name: 'Alias' } } })[0].id, 'alias');
});
test('empty and excessively large catalogs fail explicitly', () => {
  assert.throws(() => normalizeModels({ data: [] }), code('EMPTY_CATALOG'));
  assert.throws(() => normalizeModels({ data: Array.from({ length: 4097 }, (_, i) => ({ id: String(i) })) }), code('INVALID_CATALOG'));
});
test('provider has only credential reference, explicit capacities and no duplicated retries', () => {
  const result = provider();
  assert.equal(result.apiKeyEnv, `MULTIVIBE_DSH_${'A'.repeat(32)}`);
  assert.equal(result.retryPolicy.maxRetries, 0);
  assert.equal(JSON.stringify(result).includes('mv_fake_key'), false);
  assert.deepEqual(result.models[0], model);
});
test('unknown capacity requires explicit confirmation; no guessed SDK defaults', () => {
  assert.throws(() => provider({ models: [{ id: model.id, name: model.name }] }), code('MISSING_CAPACITY'));
  const result = provider({ models: [{ id: model.id, name: model.name }], capacities: { [model.id]: { contextWindow: 4096, maxTokens: 1024 } } });
  assert.equal(result.models[0].contextWindow, 4096);
});
test('provider validates protocol, model selection and capacity constraints', () => {
  assert.throws(() => provider({ protocol: 'anthropic-messages' }), code('INVALID_PROTOCOL'));
  assert.throws(() => provider({ selectedIds: [] }), code('INVALID_SELECTION'));
  assert.throws(() => provider({ selectedIds: [model.id, model.id] }), code('INVALID_SELECTION'));
  assert.throws(() => provider({ selectedIds: ['missing'] }), code('UNKNOWN_MODEL'));
  assert.throws(() => provider({ models: [{ ...model, maxTokens: 16384 }] }), code('INVALID_CAPACITY'));
});
test('fetch sends bearer only to the explicit model endpoint and rejects redirects', async () => {
  let received;
  await assert.rejects(requestJSON('https://gateway.example/v1/models', { apiKey: 'mv_fake_key', fetchImpl: async (url, options) => { received = { url, options }; return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }); } }), code('REDIRECT_REJECTED'));
  assert.equal(received.options.redirect, 'manual');
  assert.equal(received.options.headers.Authorization, 'Bearer mv_fake_key');
});
test('error body and thrown network messages never leak API keys', async () => {
  await assert.rejects(requestJSON('https://gateway.example/v1/models', { fetchImpl: async () => new Response('secret mv_fake_key', { status: 401 }) }), error => error.code === 'UNAUTHORIZED' && !error.message.includes('mv_fake_key'));
  await assert.rejects(requestJSON('https://gateway.example/v1/models', { fetchImpl: async () => { throw new Error('mv_fake_key'); } }), error => error.code === 'UNREACHABLE' && !error.message.includes('mv_fake_key'));
  assert.equal(JSON.stringify(publicError(new Error('mv_fake_key'))).includes('mv_fake_key'), false);
});
test('bounded streaming JSON rejects malformed and oversized responses', async () => {
  await assert.rejects(requestJSON('https://gateway.example', { fetchImpl: async () => new Response('not JSON') }), code('INVALID_RESPONSE'));
  await assert.rejects(requestJSON('https://gateway.example', { maxBytes: 10, fetchImpl: async () => Response.json({ data: 'too large' }) }), code('RESPONSE_TOO_LARGE'));
});
test('real HTTP discovery authenticates but never calls inference or administration', async t => {
  const calls = [];
  const server = http.createServer((req, res) => { calls.push({ path: req.url, key: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [model] })); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const result = await discoverGateway({ baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: 'mv_fake_key' });
  assert.equal(result.models[0].id, model.id);
  assert.deepEqual(calls, [{ path: '/v1/models', key: 'Bearer mv_fake_key' }]);
});
test('real HTTP timeout and caller cancellation terminate pending requests', async t => {
  const server = http.createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/models`;
  await assert.rejects(requestJSON(url, { timeoutMs: 25 }), code('TIMEOUT'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestJSON(url, { signal: controller.signal }), code('CANCELLED'));
});
test('native MultiVibe metadata supplies capacities without exposing account identifiers', () => {
  const models = normalizeModels({ data: [{ id: 'local/coding', metadata: { context_window: 32768, max_output_tokens: 4096, input_modalities: ['text', 'image'], account_ids: ['private-account'], display_name: 'Local Coding' } },
    { id: 'image-generator', metadata: { output_modalities: ['image'] } }] });
  assert.deepEqual(models, [{ id: 'local/coding', name: 'Local Coding', contextWindow: 32768, maxTokens: 4096, inputModalities: ['text', 'image'] }]);
  assert.equal(JSON.stringify(models).includes('private-account'), false);
});
test('a gateway cannot echo the proxy secret through model metadata', async () => {
  await assert.rejects(discoverGateway({ baseURL: 'https://gateway.example', apiKey: 'mv_test_secret', fetchImpl: async () => Response.json({ data: [{ id: 'model', name: 'mv_test_secret' }] }) }), code('INVALID_CATALOG'));
});
