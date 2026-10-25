import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelsDevCatalog } from "./models-dev-catalog.js";
import { installModelsDevPricing, getModelPricing } from "../model-pricing.js";

const payload = {
  deepseek: {
    models: {
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        tool_call: true,
        reasoning: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 1_000_000, output: 384_000 },
        cost: { input: 0.4, output: 0.8, invalid: -1 },
      },
      "deepseek-retired": {
        id: "deepseek-retired",
        name: "Retired",
        status: "deprecated",
        modalities: { input: ["text"], output: ["text"] },
      },
      "deepseek-vision-only": {
        id: "deepseek-vision-only",
        name: "Vision only",
        modalities: { input: ["image"], output: ["image"] },
      },
    },
  },
  "fireworks-ai": {
    models: {
      "accounts/fireworks/models/llama-v3p1-8b": {
        id: "accounts/fireworks/models/llama-v3p1-8b",
        name: "Llama 3.1 8B",
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
};

function runtimeCatalog(fetchImpl: typeof fetch, cachePath?: string, now = () => 1_700_000_000_000) {
  return new ModelsDevCatalog({ fetch: fetchImpl, cachePath, now, timeoutMs: 1_000, ttlMs: 60 * 60_000 });
}

test("filters deprecated and non-text models and maps provider ids", async () => {
  let calls = 0;
  const catalog = runtimeCatalog((async () => { calls++; return Response.json(payload); }) as typeof fetch);
  assert.equal(await catalog.refresh(), true);
  assert.equal(calls, 1);
  const deepseek = catalog.catalogFor("deepseek");
  assert.deepEqual(deepseek?.models.map((model) => model.id), ["deepseek-v4-pro"]);
  assert.equal(deepseek?.models[0]?.name, "DeepSeek V4 Pro");
  assert.equal(deepseek?.models[0]?.context, 1_000_000);
  assert.equal(deepseek?.models[0]?.output, 384_000);
  assert.equal(deepseek?.models[0]?.tools, true);
  assert.equal(deepseek?.models[0]?.reasoning, true);
  assert.deepEqual(deepseek?.models[0]?.cost, { input: 0.4, output: 0.8 });
  assert.equal(deepseek?.source, "https://models.dev/api.json");
  // firework's reviewed provider id differs from its models.dev id.
  assert.deepEqual(catalog.catalogFor("fireworks")?.models.map((model) => model.id), ["accounts/fireworks/models/llama-v3p1-8b"]);
  assert.equal(catalog.catalogFor("mammouth"), undefined);
  assert.equal(catalog.state().providerCount, 2);
});

test("publishes pricing and retains context tiers through disk cache and network failure", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multivibe-pricing-cache-"));
  t.after(async () => { installModelsDevPricing({}, 1792900000000); await rm(root, { recursive: true, force: true }); });
  const cachePath = path.join(root, "catalog.json");
  const cost = { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5,
    tiers: [{ input: 4, output: 15, cache_read: 0.2, cache_write: 5, tier: { type: "context", size: 272000 } }] };
  const first = new ModelsDevCatalog({ cachePath, onUpdate: installModelsDevPricing,
    fetch: (async () => Response.json({ openai: { models: { "gpt-6.1-sol": { id: "gpt-6.1-sol", modalities: { output: ["text"] }, cost } } } })) as typeof fetch });
  assert.equal(await first.refresh(), true);
  assert.deepEqual(first.catalogFor("openai")?.models[0].cost, cost);
  assert.equal(getModelPricing("gpt-6.1-sol")?.contextTiers?.[0].thresholdTokens, 272000);
  installModelsDevPricing({}, 1792900000000);
  const second = new ModelsDevCatalog({ cachePath, onUpdate: installModelsDevPricing,
    fetch: (async () => new Response("unavailable", { status: 503 })) as typeof fetch });
  await second.ensure();
  assert.deepEqual(second.catalogFor("openai")?.models[0].cost, cost);
  assert.equal(await second.refresh(), false);
  assert.equal(getModelPricing("gpt-6.1-sol")?.cachedInputPer1M, 0.1);
});

test("persists the snapshot on disk and reloads it without fetching", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multivibe-models-dev-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const cachePath = path.join(root, "models-dev.json");
  const first = runtimeCatalog((async () => Response.json(payload)) as typeof fetch, cachePath);
  assert.equal(await first.refresh(), true);
  const stored = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(stored.version, 2);
  assert.ok(stored.providers.deepseek);
  assert.equal(stored.providerAliases.fireworks, "fireworks-ai");

  let calls = 0;
  const second = runtimeCatalog((async () => { calls++; return Response.json(payload); }) as typeof fetch, cachePath);
  await second.ensure();
  assert.deepEqual(second.catalogFor("deepseek")?.models.map((model) => model.id), ["deepseek-v4-pro"]);
  assert.equal(second.state().stale, true, "the persisted snapshot is revalidated in the background");
  const startedAt = Date.now();
  while (calls === 0 && Date.now() - startedAt < 1_000) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1, "the persisted snapshot is revalidated in the background");
});

test("keeps the last good snapshot when a refresh fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multivibe-models-dev-failure-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  let mode: "ok" | "fail" = "ok";
  const catalog = runtimeCatalog((async () => mode === "ok" ? Response.json(payload) : new Response("nope", { status: 503 })) as typeof fetch, path.join(root, "cache.json"));
  assert.equal(await catalog.refresh(), true);
  mode = "fail";
  assert.equal(await catalog.refresh(), false);
  assert.deepEqual(catalog.catalogFor("deepseek")?.models.map((model) => model.id), ["deepseek-v4-pro"]);
  assert.match(catalog.state().lastError ?? "", /HTTP 503/);
});

test("ignores an invalid persisted cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multivibe-models-dev-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  const cachePath = path.join(root, "cache.json");
  await writeFile(cachePath, "{ not json");
  const catalog = runtimeCatalog((async () => Response.json(payload)) as typeof fetch, cachePath);
  await catalog.ensure();
  assert.equal(catalog.catalogFor("deepseek"), undefined);
});
