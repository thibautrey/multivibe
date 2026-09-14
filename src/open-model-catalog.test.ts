import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenModelCatalog, parseOpenModels } from './open-model-catalog.js';
const model = { id: 'publisher/model', private: false, gated: false, pipeline_tag: 'text-generation', tags: ['conversational', 'license:apache-2.0'], createdAt: '2026-09-01T00:00:00Z' };
test('discovery excludes private, gated, unlicensed, adapters and unsafe identifiers', () => {
  assert.equal(parseOpenModels([model]).length, 1);
  for (const change of [{private:true}, {gated:'auto'}, {id:'../unsafe/path'}, {tags:['conversational','license:custom']}, {tags:['license:mit']}, {tags:[...model.tags,'base_model:adapter:test']}]) assert.equal(parseOpenModels([{...model,...change}]).length, 0);
  assert.throws(() => parseOpenModels({}));
});
test('refresh is deduplicated, cached hourly and retains explicitly stale results on failure', async () => {
  let clock = Date.parse('2026-09-14T00:00:00Z'); let calls = 0; let fail = false;
  const load = createOpenModelCatalog((async () => { calls++; if (fail) throw new Error('offline'); return new Response(JSON.stringify([model])); }) as typeof fetch, () => clock);
  const [a,b] = await Promise.all([load(),load()]); assert.deepEqual(a,b); assert.equal(calls,2); assert.equal(a.models.length,1);
  await load(); assert.equal(calls,2);
  clock += 3600001; fail = true; const stale = await load(); assert.equal(stale.stale,true); assert.equal(stale.checkedAt,a.checkedAt);
});
test('initial upstream failure remains an error, never invented models', async () => {
  const load = createOpenModelCatalog((async () => new Response('', {status:503})) as typeof fetch);
  await assert.rejects(load(), /unavailable/);
});
