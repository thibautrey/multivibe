import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OpenCodeLocalClient, OpenCodeLocalError, catalogEntry, isFreeChatModel} from './client.mjs';

const PASSWORD = 'fixture-server-password-123';
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
const MODELS = [
  {id: 'big-pickle', name: 'Big Pickle', type: 'chat', capabilities: {output: ['text']}, limit: {context: 200000, output: 32000}, cost: [{input: 0, output: 0}]},
  {id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', type: 'chat', capabilities: {output: ['text']}, limit: {context: 200000, output: 65536}, cost: [{input: 0, output: 0}]},
  {id: 'paid-model', name: 'Paid', type: 'chat', capabilities: {output: ['text']}, limit: {context: 200000, output: 32000}, cost: [{input: 3, output: 4}]},
  {id: 'image-free', name: 'Image', type: 'image', capabilities: {output: ['image']}, limit: {context: 1, output: 1}, cost: [{input: 0, output: 0}]},
];

async function fakeServer(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const record = {method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization: req.headers.authorization};
    requests.push(record);
    const send = (status, value) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    if (req.headers.authorization !== AUTHORIZATION) return send(401, {_tag: 'UnauthorizedError', message: 'Authentication required'});
    return handler(record, send, requests);
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

async function clientFor(handler, options = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'opencode-client-'));
  const server = await fakeServer(handler);
  const client = new OpenCodeLocalClient({serverUrl: server.url, password: PASSWORD, workspace, ...options});
  await client.start();
  return {
    client,
    server,
    close: async () => { await client.close(); await server.close(); await rm(workspace, {recursive: true, force: true}); },
  };
}

test('free catalog filters paid and media models and keeps the transport contract', async () => {
  const harness = await clientFor((_record, send) => send(200, {data: MODELS}));
  try {
    const models = await harness.client.listFreeModels();
    assert.deepEqual(models.map(model => model.id), ['big-pickle-opencode-local', 'deepseek-v4.1-flash-free-opencode-local']);
    assert.deepEqual(models[0], {
      id: 'big-pickle-opencode-local',
      upstream: 'big-pickle',
      name: 'Big Pickle · OpenCode local',
      contextWindow: 200000,
      maxOutputTokens: 32000,
      vision: false,
    });
    assert.equal(models[1].maxOutputTokens, 32000);
  } finally { await harness.close(); }
});

test('isFreeChatModel and catalogEntry reject models without a zero-cost text contract', () => {
  assert.equal(isFreeChatModel(MODELS[0]), true);
  assert.equal(isFreeChatModel(MODELS[2]), false);
  assert.equal(isFreeChatModel(MODELS[3]), false);
  assert.equal(isFreeChatModel(null), false);
  assert.equal(catalogEntry({id: 'x', type: 'chat', cost: [{input: 0, output: 0}]}).contextWindow, 200000);
});

test('OPENCODE_BRIDGE_MODELS only narrows the free catalog', async () => {
  const harness = await clientFor((_record, send) => send(200, {data: MODELS}), {models: ['deepseek-v4.1-flash-free', 'paid-model']});
  try {
    assert.deepEqual((await harness.client.listFreeModels()).map(model => model.id), ['deepseek-v4.1-flash-free-opencode-local']);
  } finally { await harness.close(); }
});

test('run drives a real session and maps text, usage and finish reason', async () => {
  let prompt;
  let deleted = false;
  const harness = await clientFor((record, send) => {
    if (record.path === '/api/session' && record.method === 'POST') return send(200, {data: {id: 'ses_test'}});
    if (record.path === '/api/session/ses_test/prompt') { prompt = record.body.text; return send(200, {data: {id: 'msg_user'}}); }
    if (record.path === '/api/session/ses_test/permission') return send(200, {data: []});
    if (record.path === '/api/session/ses_test/message') return send(200, {data: [
      {id: 'msg_user', type: 'user'},
      {id: 'msg_ai', type: 'assistant', time: {created: 1, completed: 2}, content: [{type: 'reasoning', text: 'thinking'}, {type: 'text', text: 'Bonjour ✓'}], finish: 'length', tokens: {input: 10, output: 3, reasoning: 2, cache: {read: 5, write: 1}}},
      {id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: {created: 3}},
    ]});
    if (record.path === '/api/session/ses_test' && record.method === 'DELETE') { deleted = true; return send(204); }
    return send(404, {message: 'not found'});
  });
  try {
    const result = await harness.client.run({
      model: {id: 'big-pickle-opencode-local', upstream: 'big-pickle'},
      messages: [{role: 'user', content: 'Bonjour'}],
      maxTokens: 32,
    });
    assert.equal(result.text, 'Bonjour ✓');
    assert.equal(result.finishReason, 'length');
    assert.equal(result.model, 'big-pickle-opencode-local');
    assert.deepEqual(result.usage, {prompt_tokens: 16, completion_tokens: 5, total_tokens: 21});
    assert.match(prompt, /Bonjour/);
    const created = harness.server.requests.find(record => record.path === '/api/session' && record.method === 'POST');
    assert.equal(created.body.location.directory, harness.client.workspace);
    assert.equal(created.body.model.id, 'big-pickle');
    assert.deepEqual(created.body.permissions, [{action: '*', resource: '*', effect: 'ask'}]);
    assert.equal(deleted, true);
  } finally { await harness.close(); }
});

test('free-tier rejections surface as 429 and never as a generic failure', async () => {
  const harness = await clientFor((record, send) => {
    if (record.path === '/api/session') return send(200, {data: {id: 'ses_test'}});
    if (record.path.endsWith('/prompt')) return send(200, {data: {}});
    if (record.path.endsWith('/permission')) return send(200, {data: []});
    if (record.path.endsWith('/message')) return send(200, {data: [{id: 'msg_ai', type: 'assistant', time: {created: 1, completed: 2}, content: [], finish: 'error', error: {type: 'provider.free-limit', status: 429, message: 'Free usage limit reached', retryAfterMs: 3600000}}]});
    if (record.method === 'DELETE') return send(204);
    return send(404, {});
  });
  try {
    await assert.rejects(harness.client.run({model: {id: 'big-pickle-opencode-local', upstream: 'big-pickle'}, messages: [{role: 'user', content: 'x'}]}), error => {
      assert.equal(error instanceof OpenCodeLocalError, true);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 3600000);
      assert.match(error.message, /free tier/i);
      return true;
    });
  } finally { await harness.close(); }
});

test('a pending tool permission interrupts the session and fails as 422', async () => {
  let interrupted = false;
  const harness = await clientFor((record, send) => {
    if (record.path === '/api/session') return send(200, {data: {id: 'ses_test'}});
    if (record.path.endsWith('/prompt')) return send(200, {data: {}});
    if (record.path.endsWith('/permission')) return send(200, {data: [{id: 'per_1'}]});
    if (record.path.endsWith('/interrupt')) { interrupted = true; return send(200, {data: {}}); }
    if (record.method === 'DELETE') return send(204);
    return send(404, {});
  });
  try {
    await assert.rejects(harness.client.run({model: {id: 'big-pickle-opencode-local', upstream: 'big-pickle'}, messages: [{role: 'user', content: 'x'}]}), /requested a tool/);
    assert.equal(interrupted, true);
  } finally { await harness.close(); }
});

test('cancellation interrupts the running session and reports 499', async () => {
  let prompted;
  const promptSeen = new Promise(resolve => { prompted = resolve; });
  let interrupted = false;
  const harness = await clientFor(async (record, send) => {
    if (record.path === '/api/session') return send(200, {data: {id: 'ses_test'}});
    if (record.path.endsWith('/prompt')) { prompted(); return send(200, {data: {}}); }
    if (record.path.endsWith('/permission')) return send(200, {data: []});
    if (record.path.endsWith('/message')) return send(200, {data: [{id: 'msg_user', type: 'user'}]});
    if (record.path.endsWith('/interrupt')) { interrupted = true; return send(200, {data: {}}); }
    if (record.method === 'DELETE') return send(204);
    return send(404, {});
  });
  try {
    const controller = new AbortController();
    const pending = harness.client.run({model: {id: 'big-pickle-opencode-local', upstream: 'big-pickle'}, messages: [{role: 'user', content: 'x'}], signal: controller.signal});
    await promptSeen;
    controller.abort();
    await assert.rejects(pending, error => error.status === 499);
    assert.equal(interrupted, true);
  } finally { await harness.close(); }
});

test('the request timeout interrupts the session and reports 504', async () => {
  let interrupted = false;
  const harness = await clientFor((record, send) => {
    if (record.path === '/api/session') return send(200, {data: {id: 'ses_test'}});
    if (record.path.endsWith('/prompt')) return send(200, {data: {}});
    if (record.path.endsWith('/permission')) return send(200, {data: []});
    if (record.path.endsWith('/message')) return send(200, {data: [{id: 'msg_user', type: 'user'}]});
    if (record.path.endsWith('/interrupt')) { interrupted = true; return send(200, {data: {}}); }
    if (record.method === 'DELETE') return send(204);
    return send(404, {});
  });
  try {
    await assert.rejects(harness.client.run({model: {id: 'big-pickle-opencode-local', upstream: 'big-pickle'}, messages: [{role: 'user', content: 'x'}]}, {timeoutMs: 80}), error => error.status === 504);
    assert.equal(interrupted, true);
  } finally { await harness.close(); }
});

test('the client parses the genuine serve banner and stops the child on close', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-spawn-'));
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.exitCode = null;
    }
    kill(signal) {
      this.exitCode = 0;
      this.emit('exit', 0, signal);
      return true;
    }
  }
  const child = new FakeChild();
  let spawnArgs;
  const client = new OpenCodeLocalClient({
    tempRoot: root,
    spawnImpl: (binary, args) => { spawnArgs = [binary, ...args]; return child; },
    fetchImpl: async () => new Response(JSON.stringify({data: []}), {status: 200}),
  });
  try {
    const started = client.start();
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('server listening on http://127.0.0.1:41234\n'));
      child.stdout.emit('data', Buffer.from('server password fixture-password\n'));
    }, 5);
    await started;
    assert.deepEqual(spawnArgs.slice(1), ['serve', '--hostname', '127.0.0.1', '--port', '0']);
    assert.equal(client.baseUrl, 'http://127.0.0.1:41234');
    assert.equal(client.password, 'fixture-password');
    assert.deepEqual(await client.listFreeModels(), []);
    await client.close();
    assert.equal(child.exitCode, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});
