import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { registerCompanion } from '../src/routes.mjs';
import { createCompanion } from '../src/companion.mjs';

const sdkRoot = process.env.DSH_SDK_ROOT;
const load = async name => {
  const resolve = createRequire(path.join(path.resolve(sdkRoot), 'package.json'));
  return import(pathToFileURL(resolve.resolve(name)).href);
};

test('installed SDK compiles both real tool definitions', { skip: !sdkRoot && 'Set DSH_SDK_ROOT to an isolated installed SDK root.' }, async () => {
  const { defineTool } = await load('@deepseek-ai/dsh-tools');
  const definitions = [];
  registerCompanion({ connection: { fetch: { register() {} } }, tools: { register: tool => definitions.push(tool) } }, {}, defineTool);
  assert.deepEqual(definitions.map(tool => tool.name), ['multivibe_status', 'multivibe_models']);
});

test('real SettingsForms round trip preserves authored override despite SDK defaults', { skip: !sdkRoot && 'Set DSH_SDK_ROOT to an isolated installed SDK root.' }, async () => {
  const { default: Schema } = await load('@deepseek-ai/schemastery');
  const { SettingsForms } = await load('@deepseek-ai/dsh-settings');
  // Same volatile provider shape as pi-ai; this test runs the actual SDK settings methods.
  const Config = Schema.object({ providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string(), displayName: Schema.string(), api: Schema.union(['openai-completions', 'openai-responses']), baseURL: Schema.string(),
    models: Schema.array(Schema.object({ id: Schema.string().required(), name: Schema.string(), contextWindow: Schema.number(), maxTokens: Schema.number() })),
    retryPolicy: Schema.object({ mode: Schema.string(), maxRetries: Schema.number() }),
    defaultContextWindow: Schema.number().default(262144),
  })).default({}).volatile() });
  let raw = {};
  const entry = { id: 'real-sdk-entry', options: { id: 'real-sdk-entry', config: raw }, fiber: { uid: 1, state: 2, runtime: { Config }, ctx: {}, config: Config(raw) } };
  const settings = Object.create(SettingsForms.prototype);
  settings.revisions = new Map(); settings.presentations = new Map();
  settings.ownerContext = {
    emit() {},
    configEditor: {
      configuration: () => [{ entry, inherited: {}, override: raw }], entries: () => [entry],
      async edit(_entry, update) { raw = update(structuredClone(raw), {}); entry.options.config = raw; entry.fiber.config = Config(raw); },
    },
  };
  let state;
  const secrets = new Map();
  const companion = createCompanion({ settings,
    llm: { listConfigurableProviders: () => [{ provider: 'openai', settingsNs: entry.options.id, settingsPath: ['providers', 'openai'] }], listProviders: () => [] },
    credentials: {
      readRecord: async () => structuredClone(state), modifyRecord: async (_key, update) => { state = structuredClone(update(state)); },
      describe: async ref => ({ configured: secrets.has(ref), writable: true }), set: async (ref, key) => secrets.set(ref, key),
      resolve: async ref => ({ value: secrets.get(ref) }), unset: async ref => secrets.delete(ref),
    },
  }, { fetchImpl: async () => Response.json({ data: [{ id: 'model', contextWindow: 4096, maxTokens: 1024 }] }) });
  const initial = await companion.status();
  assert.ok(initial.providers.length, JSON.stringify(settings.describe().map(view => view.schema)));
  assert.equal(initial.providers[0].settingsNs, 'real-sdk-entry');
  const connected = await companion.connect({ revision: 0, providerId: 'multivibe', settingsNs: 'real-sdk-entry', baseURL: 'http://localhost:1455', apiKey: 'mv_test_only', protocol: 'openai-completions', selectedIds: ['model'] });
  assert.equal(connected.connected, true);
  const view = settings.describe()[0];
  assert.equal(view.value.providers.multivibe.defaultContextWindow, 262144);
  assert.equal(view.user.providers.multivibe.defaultContextWindow, undefined);
  assert.equal((await companion.disconnect({ removeCredential: true, revision: connected.revision })).connection, null);
  assert.equal(secrets.size, 0);
});

test('real authenticated Connection HTTP bridge admits local plugin mutations', { skip: !sdkRoot && 'Set DSH_SDK_ROOT to an isolated installed SDK root.' }, async t => {
  const { Context } = await load('@deepseek-ai/cordis');
  const connectionModule = await load('@deepseek-ai/dsh-client-connection');
  const { defineTool } = await load('@deepseek-ai/dsh-tools');
  const ctx = new Context();
  const records = new Map(); let carrier;
  ctx.provide('credentials', { async modifyRecord(key, update) { records.set(key, update(records.get(key))); return records.get(key); } });
  ctx.provide('tools', { register() {} });
  ctx.provide('webServer', { register: route => { carrier = route; return () => { carrier = null; }; } });
  const connectionFiber = ctx.plugin(connectionModule, connectionModule.Config({}));
  await connectionFiber;
  assert.equal(connectionFiber.state, 2);
  const companionFiber = ctx.plugin({ name: 'multivibe-http-smoke', inject: ['connection', 'tools'], apply(child) {
    registerCompanion(child, { discover: async input => ({ baseURL: input.baseURL, models: [{ id: 'model', name: 'Model' }] }) }, defineTool);
  } });
  await companionFiber;
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/')) void carrier.handler(req, res).catch(() => { res.writeHead(500); res.end(); });
    else if (ctx.connection.authorizeIndex(req, res)) res.end('test index');
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await companionFiber.dispose(); await connectionFiber.dispose(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/api/multivibe/discover`;
  const init = { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ baseURL: 'https://gateway.example/v1', apiKey: 'mv_test_only' }) };
  assert.equal((await fetch(endpoint, init)).status, 401);
  const session = await fetch(ctx.connection.authenticatedUrl(`${origin}/`), { redirect: 'manual' });
  assert.equal(session.status, 303);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const admitted = await fetch(endpoint, { ...init, headers: { ...init.headers, cookie } });
  assert.equal(admitted.status, 200);
  assert.equal((await admitted.json()).models[0].id, 'model');
  assert.equal((await fetch(endpoint, { ...init, headers: { ...init.headers, cookie, origin: 'http://malicious.example' } })).status, 403);
  assert.equal(ctx.connection.fetchRoutes.get('/api/multivibe/discover').requestBody, 'streaming');
});

test('built browser module renders with the installed React renderer', { skip: !sdkRoot && 'Set DSH_SDK_ROOT to an isolated installed SDK root.' }, async () => {
  const react = await load('react');
  const { renderToStaticMarkup } = await load('react-dom/server');
  let module, Component, props;
  const document = { documentElement: { lang: 'en' }, createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } };
  const context = vm.createContext({ window: { location: { hostname: '127.0.0.1' }, __ModuleLoader__: { load: value => { module = value; } } }, document,
    navigator: { language: 'en' }, URL, AbortController, setTimeout, clearTimeout, fetch: globalThis.fetch });
  vm.runInContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
  const plugin = module.factory(name => { assert.equal(name, 'react'); return react; });
  plugin.apply({ layout: { selectPanel() {} }, effect: callback => callback(), slots: { inject: (_name, callback) => callback(), register: (spec, component) => { if (spec.name === 'main') { Component = component; props = spec.inject(); } } } });
  const html = renderToStaticMarkup(react.createElement(Component, props));
  assert.match(html, /MultiVibe/);
  assert.match(html, /data-testid="multivibe-panel"/);
  assert.doesNotMatch(html, /mv_test_only/);
});
