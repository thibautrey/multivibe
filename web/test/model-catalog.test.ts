import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateModels, modelLogo } from '../src/lib/modelCatalog.js';
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
  assert.equal(result.find(model => model.id === 'anthropic/claude')?.logo, 'anthropic.svg');
});

test('model logos use canonical authors, known aliases, and provider metadata with a safe fallback', () => {
  assert.equal(modelLogo('hf:deepseek-ai/deepseek-v3'), 'deepseek-ai.svg');
  assert.equal(modelLogo('openrouter:zai-org/glm-5'), 'zai-org.svg');
  assert.equal(modelLogo('openrouter/google/gemini-2.5'), 'google.svg');
  assert.equal(modelLogo('managed-model', 'Anthropic'), 'anthropic.svg');
  assert.equal(modelLogo('openrouter/unknown-author/model'), undefined);
  assert.equal(modelLogo('unknown-author/model'), undefined);
  assert.equal(modelLogo('__proto__/model'), undefined);
});

test('Cloud author metadata supplies the model logo without substituting its execution provider', () => {
  const [model] = aggregateModels([], [], [{ id: 'managed-model', name: 'Managed model', author: 'OpenAI', aliases: [], availability: 'available', network: true }], []);
  assert.equal(model.author, 'OpenAI');
  assert.equal(model.logo, 'openai.svg');
});

test('Cloud author metadata enriches an existing connected Cloud route', () => {
  const [model] = aggregateModels([{ id: 'managed-model', metadata: { account_ids: ['multivibe-cloud'] } }],
    [{ id: 'multivibe-cloud', enabled: true }],
    [{ id: 'managed-model', name: 'Managed model', author: 'Anthropic', aliases: [], availability: 'available', network: true }], []);
  assert.equal(model.routes.length, 1);
  assert.equal(model.author, 'Anthropic');
  assert.equal(model.logo, 'anthropic.svg');
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
