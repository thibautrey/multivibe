import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityFor, compatibilityDetail, type CompatibilityReport } from '../src/lib/modelCompatibility.js';
import { filterCatalog, type CatalogEntry } from '../src/lib/modelCatalog.js';

const model: CatalogEntry = { id: 'hf:qwen/qwen2.5-0.5b-instruct', name: 'Qwen', routes: [{ source: 'cloud', label: 'Cloud', modelId: 'qwen2.5:0.5b', ready: false }] };
const report: CompatibilityReport = { schema_version: 'provider-model-compatibility-v1', context_tokens: 8192, checked_at: '2026-09-08T00:00:00Z', models: [{ model_id: model.id, aliases: ['qwen2.5:0.5b'], variant: 'qwen2.5:0.5b', state: 'compatible', reason: 'runtime_memory_estimate', runtime: 'llama.cpp', memory: [{ device: 'Host', model_mib: 400, context_mib: 24, compute_mib: 12 }] }] };
test('exact variant estimates do not grant routing availability', () => {
  assert.equal(compatibilityFor(model, report)?.state, 'compatible');
  assert.equal(filterCatalog([model], { query: '', source: 'all', provider: 'all', readyOnly: true, sort: 'ready' }).length, 0);
  assert.match(compatibilityDetail(report.models[0]), /Host: 436 MiB/);
});
test('unmatched and conflicting identities remain unknown', () => {
  assert.equal(compatibilityFor(model), undefined);
  assert.equal(compatibilityFor({ ...model, id: 'another', routes: [] }, report), undefined);
  assert.equal(compatibilityFor(model, { ...report, models: [...report.models, { ...report.models[0], variant: 'another quantization' }] }), undefined);
  assert.equal(compatibilityFor({ ...model, id: 'QWEN/QWEN2.5-0.5B-INSTRUCT', routes: [] }, report), undefined);
});
test('insufficient memory and unavailable metadata remain distinct', () => {
  for (const state of ['insufficient', 'unknown'] as const) {
    assert.equal(compatibilityFor(model, { ...report, models: [{ ...report.models[0], state }] })?.state, state);
  }
  assert.match(compatibilityDetail({ ...report.models[0], reason: 'model_metadata_unavailable' }), /must already be downloaded/);
});
