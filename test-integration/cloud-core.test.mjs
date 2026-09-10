import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import http from 'node:http';
import { AccountStore, OAuthStateStore } from '../src/store.ts';
import { MultivibeCloudService } from '../src/multivibe-cloud.ts';

const edgeApiKey = 'integration-edge-key';

async function availablePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startNativeEdge(t, root, storePath, jobsPath) {
  const port = await availablePort();
  const controlPlane = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  controlPlane.listen(0, '127.0.0.1');
  await once(controlPlane, 'listening');
  const controlPlaneAddress = controlPlane.address();
  assert.ok(controlPlaneAddress && typeof controlPlaneAddress !== 'string');
  t.after(() => new Promise((resolve, reject) =>
    controlPlane.close(error => error ? reject(error) : resolve())));
  const edge = spawn(path.join(root, 'target', 'debug', 'multivibe-v1-edge'), [], {
    cwd: root,
    env: {
      ...process.env,
      V1_EDGE_HOST: '127.0.0.1',
      V1_EDGE_PORT: String(port),
      V1_EDGE_STORE_PATH: storePath,
      V1_EDGE_JOBS_PATH: jobsPath,
      V1_EDGE_INTERNAL_JOB_TOKEN: 'integration-internal-token',
      NODE_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlaneAddress.port}`,
      PROXY_API_KEY: edgeApiKey,
      MODELS_CACHE_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  edge.stdout.on('data', chunk => { output += chunk; });
  edge.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (edge.exitCode === null) edge.kill('SIGTERM');
    if (edge.exitCode === null) await once(edge, 'exit');
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (edge.exitCode !== null) throw new Error(`native edge exited during startup (${edge.exitCode}): ${output}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return baseUrl;
    } catch {}
    await delay(25);
  }
  throw new Error(`native edge did not become healthy: ${output}`);
}

// Import the sibling's real HTTP implementation, never a copied Cloud API fixture.
const cloudRoot = path.resolve(process.env.MULTIVIBE_CLOUD_DIR ?? '../multivibe-cloud');
const cloudImport = (file) => import(pathToFileURL(path.join(cloudRoot, file)).href);
const { testDependencies, testConfig, startTestServer, testToken, testDashboardToken, testContext } =
  await cloudImport('test/helpers.ts');
const { MemoryCommerceRepository } = await cloudImport('src/commerce.ts');
const { serviceKeyDigest } = await cloudImport('src/crypto.ts');
const { isOidcRedirectUriAllowed } = await cloudImport('src/core-oidc-redirect.ts');

test('Core connects to Cloud, discovers its catalog and invokes its models over HTTP', { timeout: 30000 }, async (t) => {
  const coreRoot = path.resolve('.');
  const dir = await mkdtemp(path.join(tmpdir(), 'cloud-core-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AccountStore(path.join(dir, 'accounts.json'));
  const oauthStore = new OAuthStateStore(path.join(dir, 'oauth.json'));
  await store.init();
  await oauthStore.init();
  const pepper = 'integration-dashboard-pepper-at-least-32-characters';
  const scopes = ['projects:read', 'projects:write', 'billing:read', 'core:credential:create', 'provider:read'];
  const commerce = new MemoryCommerceRepository({
    sessionDigest: serviceKeyDigest(testDashboardToken, pepper),
    context: { accountId: testContext.organizationId, organizationId: testContext.organizationId,
      clientId: 'multivibe-core',
      scopes, authTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() },
  });
  let authorize;
  let rejectGrant = false;
  let exchanges = 0;
  let projectCreates = 0;
  let keyCreates = 0;
  const dependencies = testDependencies({
    config: testConfig({ dashboardSessionHashPepper: pepper, oidcTokenHttpEnabled: true }), commerce,
    oidcSigning: { jwks: () => ({ keys: [] }) },
    authorizationTokens: { async exchange(input) {
      exchanges++;
      if (rejectGrant) return { status: 'invalid_grant' };
      assert.equal(input.clientId, 'multivibe-core');
      assert.equal(input.authorizationCode, 'integration-authorization-code');
      assert.equal(input.redirectUri, authorize.searchParams.get('redirect_uri'));
      assert.equal(isOidcRedirectUriAllowed(input.clientId, input.redirectUri), true);
      assert.equal(createHash('sha256').update(input.codeVerifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
      return { status: 'issued', accessToken: testDashboardToken, refreshToken: 'integration-refresh-token',
        tokenType: 'Bearer', expiresIn: 3600, refreshTokenExpiresIn: 86400, scopes };
    } },
    authorizationRefreshTokens: { async rotate() { return { status: 'invalid_grant', familyRevoked: false }; } },
    clientProjectService: {
      async list() { return []; },
      async create(input) {
        assert.equal(input.slug, 'multivibe-core');
        assert.equal(input.organizationId, testContext.organizationId);
        assert.ok(input.idempotencyKey);
        projectCreates++;
        return { id: testContext.projectId, replay: false };
      },
    },
    projectApiKeyService: { async create(input) {
      assert.equal(input.projectId, testContext.projectId);
      assert.deepEqual(input.scopes, ['models:read', 'responses:write']);
      assert.ok(input.idempotencyKey);
      keyCreates++;
      return { secret: testToken, apiKey: { expiresAt: input.expiresAt.toISOString() }, replay: false };
    } },
  });
  dependencies.core.handler = async () => Response.json({ id: 'resp_test', object: 'response', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Bonjour du Cloud' }] }],
    usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6 } });
  const remote = await startTestServer(dependencies);
  t.after(remote.close);
  const cloud = new MultivibeCloudService(store, oauthStore, {
    authBaseUrl: remote.baseUrl, apiBaseUrl: remote.baseUrl, inferenceBaseUrl: remote.baseUrl,
    redirectUri: 'http://127.0.0.1:1455/admin/cloud/oauth/callback', topupUrl: `${remote.baseUrl}/billing`,
    // Cloud routes identity by Host, as its production reverse proxy does.
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init?.headers));
      if (new URL(url).pathname === '/oauth/token') headers.host = 'auth.multivibe.cloud';
      const req = http.request(url, { method: init?.method, headers, signal: AbortSignal.timeout(5000) }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode,
          headers: { 'content-type': res.headers['content-type'] ?? 'application/json' } })));
      });
      req.on('error', reject);
      req.end(init?.body?.toString());
    }),
  });
  await t.test('failed token exchange leaves Core disconnected', async () => {
    const flow = await cloud.startConnection();
    authorize = new URL(flow.authorizeUrl);
    rejectGrant = true;
    await assert.rejects(cloud.completeConnection(flow.flowId, 'integration-authorization-code'));
    assert.deepEqual(await store.listAccounts(), []);
    assert.equal((await store.getSettings()).multivibeCloud, undefined);
    assert.equal(projectCreates, 0);
    assert.equal(exchanges, 1);
    rejectGrant = false;
  });
  await t.test('PKCE exchange provisions and persists the Cloud project and inference key', async () => {
    const flow = await cloud.startConnection();
    authorize = new URL(flow.authorizeUrl);
    assert.match(authorize.searchParams.get('scope') ?? '', /(?:^| )core:credential:create(?: |$)/);
    await cloud.completeConnection(flow.flowId, 'integration-authorization-code');
    assert.equal((await oauthStore.get(flow.flowId)).status, 'success');
    const reopened = new AccountStore(path.join(dir, 'accounts.json'));
    await reopened.init();
    const [account] = await reopened.listAccounts();
    assert.equal(account.accessToken, testToken);
    assert.equal(account.baseUrl, remote.baseUrl);
    assert.equal(account.multivibeCloud, true);
    assert.equal(account.location, 'cloud');
    assert.equal(projectCreates, 1);
    assert.equal(keyCreates, 1);
    await assert.rejects(cloud.completeConnection(flow.flowId, 'integration-authorization-code'));
    assert.equal(keyCreates, 1);
  });
  const base = await startNativeEdge(
    t,
    coreRoot,
    path.join(dir, 'accounts.json'),
    path.join(dir, 'v1-edge-jobs.json'),
  );
  const request = (route, init = {}) => fetch(`${base}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${edgeApiKey}`, ...init.headers },
    signal: AbortSignal.timeout(8000),
  });
  await t.test('Core exposes only models available through the Cloud catalog', async () => {
    const response = await request('/v1/models');
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.ok(catalog.data.some(model => model.id === 'public-model'), JSON.stringify(catalog));
    assert.ok(!catalog.data.some(model => ['catalog-only', 'core-only'].includes(model.id)));
    assert.ok(!JSON.stringify(catalog).includes(testToken));
  });
  await t.test('Responses inference reaches the Cloud managed route and returns its result', async () => {
    const response = await request('/v1/responses', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-cloud-integration-json' },
      body: JSON.stringify({ model: 'public-model', input: 'Bonjour', stream: false }) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.id, 'resp_test');
    assert.equal(body.status, 'completed');
    assert.equal(dependencies.core.invocations.length, 1);
    assert.equal(dependencies.core.invocations[0].endpoint, '/v1/responses');
    const sent = JSON.parse(dependencies.core.invocations[0].body);
    assert.equal(sent.model, 'core-model');
    assert.equal(sent.input, 'Bonjour');
  });
  await t.test('streamed Responses preserve text and completion across both HTTP servers', async () => {
    const frames = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"café"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
    ].join('');
    dependencies.core.handler = async () => new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    const response = await request('/v1/responses', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-cloud-integration-stream' },
      body: JSON.stringify({ model: 'public-model', input: 'Bonjour', stream: true }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const body = await response.text();
    assert.ok(body.includes('"delta":"café"'), body);
    assert.ok(body.includes('"type":"response.completed"'), body);
    assert.equal(JSON.parse(dependencies.core.invocations.at(-1).body).stream, true);
  });
  await t.test('unsupported Cloud fields return an error without reaching the model', async () => {
    const before = dependencies.core.invocations.length;
    const response = await request('/v1/responses', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'public-model', input: 'Bonjour', store: true, stream: false }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'unsupported_inference_field');
    assert.equal(dependencies.core.invocations.length, before);
  });

});
