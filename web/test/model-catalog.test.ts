import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateModels } from '../src/lib/modelCatalog.js';
import type { Account } from '../src/types.js';

const accounts: Account[] = [{ id: 'disabled', provider: 'mistral', enabled: false }, { id: 'working', provider: 'mistral', enabled: true }];
test('any healthy compatible account grants access, not just the first candidate', () => {
  const [model] = aggregateModels([{ id: 'm', metadata: { provider: 'mistral', account_ids: ['disabled', 'working'] } }], accounts, [], []);
  assert.equal(model.routes.some(route => route.ready), true);
});
test('Cloud aliases aggregate with configured models without granting catalog-only access', () => {
  const result = aggregateModels([{ id: 'm', metadata: { account_ids: ['working'] } }], accounts,
    [{ id: 'hf:m', name: 'M', aliases: ['m'], availability: 'available', network: true }], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].routes.find(route => route.source === 'cloud')?.ready, false);
  assert.equal(result[0].routes.find(route => route.ready)?.modelId, 'm');
});
test('unrelated custom endpoints do not unlock models and expired authentication is not ready', () => {
  const result = aggregateModels([{ id: 'm', metadata: { provider: 'openai-compatible' } }],
    [{ id: 'remote', provider: 'openai-compatible', enabled: true }], [], []);
  assert.equal(result[0].routes.some(route => route.ready), false);
  const blocked = aggregateModels([{ id: 'm', metadata: { account_ids: ['a'] } }],
    [{ id: 'a', enabled: true, state: { needsTokenRefresh: true } }], [], []);
  assert.equal(blocked[0].routes[0].ready, false);
});
test('local discovery requires no cloud provider and SDK candidates retain namespaced IDs', () => {
  const result = aggregateModels([], [{ id: 'local', enabled: true, localRuntime: { source: 'multivibe-local-discovery', adapter: 'ollama', endpoint: 'http://localhost:11434', authentication: 'none', confirmedModelIds: ['qwen:latest'] } }], [],
    [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude', name: 'Claude' }] }]);
  assert.equal(result.find(model => model.id === 'qwen:latest')?.routes[0].ready, true);
  assert.equal(result.find(model => model.id === 'anthropic/claude')?.routes[0].sdkProvider, 'anthropic');
});

test('OpenRouter routing namespace resolves explicit Cloud aliases and preserves usable request ID', () => {
  const models = aggregateModels([{ id: 'openrouter/author/model', metadata: { account_ids: ['router'] } }],
    [{ id: 'router', provider: 'ai-sdk', sdkProvider: 'openrouter', enabled: true }],
    [{ id: 'openrouter:author/model', name: 'Model', aliases: ['author/model'], availability: 'available', network: false }],
    [{ id: 'openrouter', name: 'OpenRouter', models: [{ id: 'author/model', name: 'Model' }] }]);
  assert.equal(models.length, 1);
  assert.equal(models[0].routes.find(route => route.ready)?.modelId, 'openrouter/author/model');
});

test('catalog filters constrain availability and actions to the same matching route', async () => {
  const { filterCatalog } = await import('../src/lib/modelCatalog.js');
  const catalog = aggregateModels([{ id: 'm', metadata: { account_ids: ['working'] } }], accounts,
    [{ id: 'hf:m', name: 'M', aliases: ['m'], availability: 'available', network: true }], []);
  const filters = { query: '', source: 'cloud', provider: 'all', readyOnly: true, sort: 'ready' };
  assert.equal(filterCatalog(catalog, filters).length, 0);
  const cloud = filterCatalog(catalog, { ...filters, readyOnly: false });
  assert.equal(cloud[0].routes.length, 1);
  assert.equal(cloud[0].routes[0].source, 'cloud');
  assert.equal(cloud[0].routes[0].ready, false);
  assert.equal(filterCatalog(catalog, { ...filters, source: 'all', provider: 'mistral' })[0].routes[0].modelId, 'm');
  assert.equal(catalog[0].routes.length, 2);
});

test('catalog search combines terms, sorts deterministically, and handles no matches', async () => {
  const { filterCatalog } = await import('../src/lib/modelCatalog.js');
  const catalog = aggregateModels([], [], [], [{ id: 'test', name: 'Test Provider', models: [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }] }]);
  const filters = { query: '  ALPHA provider ', source: 'all', provider: 'all', readyOnly: false, sort: 'name' };
  assert.deepEqual(filterCatalog(catalog, filters).map(model => model.name), ['Alpha']);
  assert.deepEqual(filterCatalog(catalog, { ...filters, query: '', sort: 'name-desc' }).map(model => model.name), ['Beta', 'Alpha']);
  assert.deepEqual(filterCatalog(catalog, { ...filters, query: 'missing' }), []);
});
