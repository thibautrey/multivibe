import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopBridge, desktopConfig } from './codex-desktop-bridge.mjs';

async function fixture(t, handler) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mv-codex-voice-'));
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.fixture`;
  const auth = { auth_mode: 'chatgpt', tokens: { access_token: token, account_id: 'account-fixture' } };
  const config = 'model_provider = "multivibe"\nmodel = "gpt-example"\n[model_providers.multivibe]\nexperimental_bearer_token = "mv_fixture"\n[profiles.normal]\nmodel_provider = "openai"\n';
  await writeFile(path.join(home, 'auth.json'), JSON.stringify(auth));
  await writeFile(path.join(home, 'config.toml'), config);
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const bridge = createDesktopBridge({ codexHome: home, upstream: `http://127.0.0.1:${upstream.address().port}/v1`, now: () => 1_900_000_000_000 });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  t.after(async () => {
    bridge.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => bridge.close(r)), new Promise(r => upstream.close(r))]);
    await rm(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${bridge.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'chatgpt-account-id': 'account-fixture' };
  return { home, auth, token, config, upstream, bridge, base, headers };
}

test('streams Responses with only the managed MultiVibe credential upstream', async t => {
  let observed;
  let release;
  const done = new Promise(r => { release = r; });
  const f = await fixture(t, (req, res) => {
    observed = req.headers;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'private=upstream' });
    res.write('data: first\n\n');
    void done.then(() => res.end('data: last\n\n'));
  });
  const response = await fetch(`${f.base}/v1/responses`, { method: 'POST', body: '{}', headers: { ...f.headers, 'x-api-key': 'do-not-forward', cookie: 'do-not-forward', 'openai-organization': 'do-not-forward', 'x-multivibe-internal-token': 'do-not-forward' } });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  assert.equal(observed.authorization, 'Bearer mv_fixture');
  for (const key of ['x-api-key', 'cookie', 'chatgpt-account-id', 'openai-organization', 'x-multivibe-internal-token']) assert.equal(observed[key], undefined);
  assert.equal(observed['x-multivibe-client'], 'openai-codex');
  assert.equal(response.headers.get('set-cookie'), null);
  release();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n');
  await reader.cancel();
});

test('rejects unrelated, expired, wrong-account and browser requests without contacting MultiVibe', async t => {
  let requests = 0;
  const f = await fixture(t, (_, res) => { requests++; res.end('{}'); });
  const cases = [
    ['/v1/models', {}],
    ['/v1/models', { authorization: 'Bearer unrelated' }],
    ['/v1/models', { ...f.headers, 'chatgpt-account-id': 'another-account' }],
    ['/admin/accounts', f.headers],
    ['/v1/models?api_key=anything', f.headers],
    ['/v1/models', { ...f.headers, origin: 'http://malicious.invalid' }],
  ];
  for (const [url, headers] of cases) assert.equal((await fetch(f.base + url, { headers })).status, 401);
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.fixture`;
  f.auth.tokens.access_token = expired;
  await writeFile(path.join(f.home, 'auth.json'), JSON.stringify(f.auth));
  assert.equal((await fetch(f.base + '/v1/models', { headers: { authorization: `Bearer ${expired}` } })).status, 401);
  assert.equal(requests, 0);
});

test('re-reads rotated ChatGPT and MultiVibe credentials for each request', async t => {
  let bearer;
  const f = await fixture(t, (req, res) => { bearer = req.headers.authorization; res.end('{}'); });
  assert.equal((await fetch(f.base + '/v1/models', { headers: f.headers })).status, 200);
  const rotated = f.token + 'rotated';
  f.auth.tokens.access_token = rotated;
  await writeFile(path.join(f.home, 'auth.json'), JSON.stringify(f.auth));
  await writeFile(path.join(f.home, 'config.toml'), f.config.replace('mv_fixture', 'mv_rotated'));
  assert.equal((await fetch(f.base + '/v1/models', { headers: f.headers })).status, 401);
  assert.equal((await fetch(f.base + '/v1/models', { headers: { authorization: `Bearer ${rotated}` } })).status, 200);
  assert.equal(bearer, 'Bearer mv_rotated');
});

test('an upstream key rejection does not cause Codex to refresh its ChatGPT login', async t => {
  const f = await fixture(t, (_, res) => { res.writeHead(401); res.end('upstream-secret-body'); });
  const response = await fetch(f.base + '/v1/models', { headers: f.headers });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /upstream-secret-body/);
});

test('proxies Responses WebSocket upgrades and closes both sockets', async t => {
  const f = await fixture(t, (_, res) => res.end());
  let upstreamAuth;
  f.upstream.on('upgrade', (req, socket) => {
    upstreamAuth = req.headers.authorization;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', data => socket.write(data));
    socket.on('end', () => socket.end());
  });
  const req = http.request(f.base + '/v1/responses?model=gpt-example', { headers: { ...f.headers, connection: 'Upgrade', upgrade: 'websocket' } });
  req.end();
  const [, socket] = await once(req, 'upgrade');
  socket.write('opaque-websocket-frame');
  const [echo] = await once(socket, 'data');
  assert.equal(echo.toString(), 'opaque-websocket-frame');
  assert.equal(upstreamAuth, 'Bearer mv_fixture');
  socket.destroy();
  await once(socket, 'close');
});

test('keeps inference endpoints on loopback and preserves unrelated Codex settings', async t => {
  assert.throws(() => createDesktopBridge({ codexHome: '/unused', upstream: 'https://external.invalid/v1' }), /loopback/);
  const f = await fixture(t, (_, res) => res.end());
  const configured = desktopConfig(f.config, 1459);
  assert.match(configured, /^# MultiVibe Desktop voice bridge\nmodel_provider = "openai"\nopenai_base_url = "http:\/\/127.0.0.1:1459\/v1"/);
  assert.match(configured, /cli_auth_credentials_store = "file"/);
  assert.match(configured, /model = "gpt-example"/);
  assert.match(configured, /experimental_bearer_token = "mv_fixture"/);
  assert.match(configured, /\[profiles.normal\]\nmodel_provider = "openai"/);
  assert.equal(desktopConfig(configured, 1459), configured);
  assert.equal(await readFile(path.join(f.home, 'config.toml'), 'utf8'), f.config);
});
