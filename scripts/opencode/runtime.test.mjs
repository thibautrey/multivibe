import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime, MODEL, DEFAULT_MODELS} from './runtime.mjs';
const apiKey = 'fixture-local-runtime-key-123456';
const MODELS = [
  ...DEFAULT_MODELS,
  {id: 'flint-40b-free-opencode-local', upstream: 'flint-40b-free', name: 'Flint 40B Free · OpenCode local', contextWindow: 262144, maxOutputTokens: 32000, vision: false},
];
const body = {model: MODEL, messages: [{role: 'user', content: 'Bonjour'}], max_tokens: 32};
async function server(run, fn, {models = MODELS, maxConcurrent = 2} = {}) {
  const s = createRuntime({apiKey, run, models, maxConcurrent});
  s.listen(0, '127.0.0.1');
  await new Promise(resolve => s.once('listening', resolve));
  const call = (value = body, headers = {}) => fetch(`http://127.0.0.1:${s.address().port}/v1/chat/completions`, {method: 'POST', headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...headers}, body: JSON.stringify(value)});
  try { await fn(call, s); } finally { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
}
test('runtime rejects unauthenticated requests, media, tools and unknown models before running the server', async () => {
  let calls = 0;
  await server(async () => { calls++; return {text: 'no'}; }, async call => {
    assert.equal((await call(body, {authorization: 'Bearer wrong'})).status, 401);
    for (const change of [{model: 'paid-model'}, {tools: [{type: 'function'}]}, {messages: [{role: 'user', content: [{type: 'image_url', image_url: {url: 'https://example.test'}}]}]}, {max_tokens: 0}]) assert.equal((await call({...body, ...change})).status, 400);
  });
  assert.equal(calls, 0);
});
test('model catalog lists every configured free model with its transport', async () => {
  await server(async () => ({text: 'ok'}), async (_call, s) => {
    const response = await fetch(`http://127.0.0.1:${s.address().port}/v1/models`, {headers: {authorization: `Bearer ${apiKey}`}});
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.deepEqual(catalog.data.map(model => model.id), MODELS.map(model => model.id));
    assert.equal(catalog.data[1].metadata.transport, 'official-opencode-server');
    assert.equal(catalog.data[1].context_window, 262144);
    assert.equal(catalog.data[1].capabilities.tools, false);
  });
});
test('the requested catalog model reaches the runner and is echoed in the reply', async () => {
  let received;
  await server(async input => { received = input; return {text: 'Réponse ✓', usage: {prompt_tokens: 10, completion_tokens: 3, total_tokens: 13}}; }, async call => {
    const reply = await (await call({...body, model: MODELS[1].id})).json();
    assert.equal(received.model.upstream, 'flint-40b-free');
    assert.equal(received.messages[0].content, 'Bonjour');
    assert.equal(received.maxTokens, 32);
    assert.equal(reply.model, MODELS[1].id);
    assert.equal(reply.usage.total_tokens, 13);
  });
});
test('text replies and buffered SSE preserve content and provider usage', async () => {
  await server(async () => ({text: 'Réponse ✓', usage: {prompt_tokens: 10, completion_tokens: 3, total_tokens: 13}}), async call => {
    const reply = await (await call()).json();
    assert.equal(reply.choices[0].message.content, 'Réponse ✓');
    assert.equal(reply.usage.total_tokens, 13);
    const response = await call({...body, stream: true, stream_options: {include_usage: true}});
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const text = await response.text();
    assert.match(text, /Réponse ✓/);
    assert.match(text, /"total_tokens":13/);
    assert.match(text, /data: \[DONE\]/);
  });
});
test('an asynchronous model source is resolved once and falls back to the served list', async () => {
  let loads = 0;
  const models = async () => { loads++; return MODELS; };
  await server(async () => ({text: 'ok'}), async call => {
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
  }, {models});
  assert.equal(loads, 1);
});
test('concurrent work is bounded and disconnected requests abort the OpenCode operation', async () => {
  let started;
  const start = new Promise(resolve => { started = resolve; });
  let aborted;
  const abort = new Promise(resolve => { aborted = resolve; });
  await server(input => new Promise((_resolve, reject) => {
    started();
    input.signal.addEventListener('abort', () => { aborted(); reject(Error('cancelled')); }, {once: true});
  }), async (_call, s) => {
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${s.address().port}/v1/chat/completions`, {method: 'POST', signal: controller.signal, headers: {authorization: `Bearer ${apiKey}`}, body: JSON.stringify(body)}).catch(() => {});
    await start;
    assert.equal((await _call()).status, 429);
    controller.abort();
    await request;
    await abort;
  }, {maxConcurrent: 1});
});
