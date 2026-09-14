import test from 'node:test';
import assert from 'node:assert/strict';
import { modelView, modelNeeds, relevantChoices, recommendedChoices } from '../src/lib/modelGuidance.js';
import type { CatalogEntry, ModelRoute } from '../src/lib/modelCatalog.js';
const route = (source: ModelRoute['source'], ready = true): ModelRoute => ({ source, ready, label: source, accountId: source, modelId: 'gpt-5' });
const entry = (routes: ModelRoute[], id = 'gpt-5'): CatalogEntry => ({ id, name: id, routes });
test('new users and invalid persisted values use guided mode', () => {
  for (const value of [null, undefined, '', 'beginner', '{}']) assert.equal(modelView(value), 'guided');
  assert.equal(modelView('expert'), 'expert'); assert.equal(modelView('compare'), 'compare');
});
test('each need has a curated usable choice without fabricated cost or speed', () => {
  for (const need of modelNeeds) {
    const [choice] = relevantChoices([entry([route('provider')])], need.id);
    assert.equal(choice.access, 'usable'); assert.equal(choice.cost.amount, null);
    assert.equal(choice.cost.unit, null); assert.equal(choice.speed.kind, 'unknown');
    assert.ok(choice.evidence.source); assert.ok(choice.reason);
  }
});
test('disconnected, unverified and unknown models never enter recommendations', () => {
  for (const need of modelNeeds) {
    assert.deepEqual(relevantChoices([], need.id), []);
    assert.deepEqual(relevantChoices([entry([route('cloud', false)])], need.id), []);
    assert.deepEqual(relevantChoices([entry([{ ...route('cloud'), accountId: undefined }])], need.id), []);
    assert.deepEqual(relevantChoices([entry([{ ...route('local'), modelId: 'qwen-unknown' }], 'qwen-unknown')], need.id), []);
  }
});
test('do not promise a destination when chat may select another account', () => {
  assert.deepEqual(relevantChoices([entry([route('cloud'), route('local')])], 'writing'), []);
});
test('guided selection is capped at three and includes other execution mode', () => {
  const candidates = relevantChoices([
    entry([route('provider')]),
    entry([{ ...route('local'), modelId: 'qwen2.5:0.5b' }], 'qwen2.5:0.5b'),
    entry([{ ...route('cloud'), modelId: 'openai/gpt-5' }], 'openai/gpt-5'),
    entry([{ ...route('provider'), modelId: 'openrouter/openai/gpt-5' }], 'openrouter/openai/gpt-5'),
  ], 'writing');
  const choices = recommendedChoices(candidates);
  assert.equal(choices.length, 3); assert.ok(choices.some(choice => choice.route.source === 'local'));
  assert.ok(choices.some(choice => choice.route.source !== 'local'));
  assert.notEqual(choices.find(choice => choice.route.source === 'local')!.cost.label, 'Gratuit');
});
test('a writing-only model is not recommended for coding or documents', () => {
  const models = [entry([{ ...route('local'), modelId: 'qwen2.5:0.5b' }], 'qwen2.5:0.5b')];
  assert.equal(relevantChoices(models, 'writing').length, 1);
  assert.deepEqual(relevantChoices(models, 'coding'), []);
  assert.deepEqual(relevantChoices(models, 'documents'), []);
});

test('Cloud verification never fabricates a chat route and fails closed', async () => {
  const { verifiedCloudCatalog } = await import('../src/lib/modelGuidance.js');
  const catalog = [entry([route('cloud')])];
  for (const status of ['disconnected', 'access_denied', 'unavailable'] as const) {
    assert.equal(verifiedCloudCatalog(catalog, { status, modelIds: ['gpt-5'], checkedAt: '' }, true)[0].routes[0].ready, false);
  }
  assert.equal(verifiedCloudCatalog(catalog, undefined, true)[0].routes[0].ready, false);
  assert.equal(verifiedCloudCatalog(catalog, { status: 'available', modelIds: [], checkedAt: '' }, true)[0].routes[0].ready, false);
  assert.equal(verifiedCloudCatalog(catalog, { status: 'available', modelIds: ['gpt-5'], checkedAt: '' }, false)[0].routes[0].ready, false);
  assert.equal(verifiedCloudCatalog(catalog, { status: 'available', modelIds: ['gpt-5'], checkedAt: '' }, true)[0].routes[0].ready, true);
  assert.deepEqual(verifiedCloudCatalog([], { status: 'available', modelIds: ['gpt-5'], checkedAt: '' }, true), []);
  assert.equal(verifiedCloudCatalog([entry([route('local')])], undefined, false)[0].routes[0].ready, true);
  assert.equal(catalog[0].routes[0].ready, true, 'must not mutate input');
});
