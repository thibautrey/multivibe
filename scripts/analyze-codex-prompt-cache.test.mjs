import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function analyze(usages) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-cache-metrics-'));
  try {
    const rows = [{ type: 'session_meta', payload: { id: 'test-session' } },
      { type: 'turn_context', payload: { model: 'fixture-model' } },
      ...usages.map(({ age = 0, timestamp = true, ...usage }) => ({
        ...(timestamp ? { timestamp: new Date(Date.now() - age).toISOString() } : {}),
        type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage } },
      }))];
    await writeFile(join(directory, 'rollout-fixture.jsonl'), rows.map(JSON.stringify).join('\n'));
    return JSON.parse(execFileSync(process.execPath,
      ['scripts/analyze-codex-prompt-cache.mjs', '--sessions-dir', directory, '--days', '1'],
      { encoding: 'utf8' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('filters events, not only recently modified rollout files, and deduplicates usage', async () => {
  const result = await analyze([
    { age: 2 * 86400000, input_tokens: 3000, cached_input_tokens: 2500 },
    { input_tokens: 2000, cached_input_tokens: 1500 },
    { input_tokens: 2000, cached_input_tokens: 1500 },
    { timestamp: false, input_tokens: 4000, cached_input_tokens: 3000 },
  ]);
  assert.equal(result.allModels.calls, 1);
  assert.equal(result.allModels.inputTokens, 2000);
  assert.equal(result.allModels.aggregateCacheRatio, 0.75);
  assert.equal(result.source.eventTimestampFiltered, true);
});

test('missing and invalid cache measurements stay unknown; explicit zero is measured', async () => {
  const result = await analyze([
    { input_tokens: 2000 },
    { input_tokens: 3000, cached_input_tokens: null },
    { input_tokens: 4000, cached_input_tokens: 0 },
    { input_tokens: 6000, cached_input_tokens: 3000, cache_write_input_tokens: 0 },
  ]);
  assert.equal(result.allModels.calls, 4);
  assert.equal(result.allModels.cachedFieldPresentCalls, 2);
  assert.equal(result.allModels.cacheMeasuredInputTokens, 10000);
  assert.equal(result.allModels.aggregateCacheRatio, 0.3);
  assert.equal(result.allModels.eligibleZeroCacheCalls, 1);
  assert.equal(result.allModels.gpt56SavingsVsUncached, undefined);
  const unknown = await analyze([{ input_tokens: 2000 }]);
  assert.equal(unknown.allModels.aggregateCacheRatio, undefined);
  assert.equal(unknown.allModels.cacheRatioMedian, undefined);
});
