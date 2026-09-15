import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCachedModelBenchmarkClient } from "./model-benchmark-cache.js";
import type { ModelBenchmarkClient } from "./model-benchmarks.js";

function upstream(calls: string[]): ModelBenchmarkClient {
  return {
    sources: () => ({ sources: [] }),
    model: async modelId => { calls.push(`model:${modelId}`); return { modelId, observations: [], source: "hugging-face", fetchedAt: "upstream" }; },
    leaderboard: async (datasetId, limit) => { calls.push(`leaderboard:${datasetId}:${limit}`); return { datasetId, entries: [], source: "hugging-face", fetchedAt: "upstream" }; },
    artificialAnalysisModels: async (page, access) => { calls.push(`aa-page:${access}:${page}`); return { models: [], page }; },
    artificialAnalysisModel: async slug => { calls.push(`aa-model:${slug}`); return { model: { slug } }; },
  } as ModelBenchmarkClient;
}

test("durable cache survives restart and avoids repeated upstream requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-cache-")); const file = path.join(directory, "cache.json");
  try {
    const calls: string[] = []; const first = createCachedModelBenchmarkClient(upstream(calls), { path: file });
    assert.equal((await first.model("owner/model")).cache.hit, false);
    assert.equal((await first.model("owner/model")).cache.hit, true);
    const restarted = createCachedModelBenchmarkClient(upstream(calls), { path: file });
    const cached = await restarted.model("owner/model");
    assert.equal(cached.cache.hit, true); assert.equal(cached.cache.stale, false); assert.deepEqual(calls, ["model:owner/model"]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("expired data is served immediately while one background refresh updates it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-stale-")); const file = path.join(directory, "cache.json");
  try {
    let now = 1_000_000; const calls: string[] = []; const client = createCachedModelBenchmarkClient(upstream(calls), { path: file, ttlMs: 100, now: () => now });
    await client.model("owner/model"); now += 101;
    const [left, right] = await Promise.all([client.model("owner/model"), client.model("owner/model")]);
    assert.equal(left.cache.stale, true); assert.equal(right.cache.stale, true);
    for (let attempt = 0; attempt < 20 && calls.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(calls, ["model:owner/model", "model:owner/model"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cached model inventory provides a broad local-only view", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-inventory-")); const file = path.join(directory, "cache.json");
  try {
    const client = createCachedModelBenchmarkClient(upstream([]), { path: file });
    await client.model("one/model"); await client.model("two/model"); await client.artificialAnalysisModel("third-model");
    const inventory = await client.cacheInventory(); assert.equal(inventory.entries, 3); assert.equal(inventory.groups.models, 2);
    assert.equal((await client.cachedModels()).count, 3); assert.equal((await client.cachedModels("hugging-face")).count, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
