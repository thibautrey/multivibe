import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelsDevCost } from "./models-dev-pricing.js";
import { estimateCostUsd, getModelPricing, installModelsDevPricing } from "./model-pricing.js";

test("models.dev prices support providers, context tiers, free models and missing prices", () => {
  const cost = normalizeModelsDevCost({ input: 2, output: 10, cache_read: 0.1, cache_write: 2.5,
    context_over_200k: { input: 999, output: 999 },
    tiers: [
      { input: 8, output: 30, tier: { type: "context", size: 500000 } },
      { input: 4, output: 15, cache_read: 0.2, cache_write: 5, tier: { type: "context", size: 272000 } },
      { input: -1, output: 0, tier: { type: "context", size: 1 } },
    ] })!;
  assert.deepEqual(cost.tiers?.map(t => t.tier.size), [272000, 500000]);
  assert.equal(normalizeModelsDevCost({ input: 2 }), undefined);
  installModelsDevPricing({ openai: [{ id: "gpt-6.1-sol", cost }],
    anthropic: [{ id: "claude-future", cost: { input: 3, output: 15 } }],
    openrouter: [{ id: "gpt-6.1-sol", cost: { input: 99, output: 99 } }, { id: "free", cost: { input: 0, output: 0 } }] }, 1792900000000);
  try {
    assert.equal(getModelPricing("gpt-6.1-sol")?.inputPer1M, 2);
    assert.equal(estimateCostUsd("gpt-6.1-sol", 100000, 10000, 20000, 30000), 0.277);
    assert.equal(estimateCostUsd("openai/gpt-6.1-sol", 272000, 0), 0.544);
    assert.equal(estimateCostUsd("openai/gpt-6.1-sol", 272001, 0), 1.088004);
    assert.equal(estimateCostUsd("openai/gpt-6.1-sol", 500001, 0), 4.000008);
    assert.equal(estimateCostUsd("anthropic/claude-future", 1000000, 1000000), 18);
    assert.equal(getModelPricing("openrouter/gpt-6.1-sol")?.inputPer1M, 99);
    assert.equal(getModelPricing("unreviewed/gpt-6.1-sol"), undefined);
    assert.equal(getModelPricing("gpt-6.1-sol-invented"), undefined);
    assert.equal(getModelPricing("gpt-5.3-codex-spark"), undefined);
    assert.equal(estimateCostUsd("unknown-model", 100, 10), undefined);
    assert.equal(estimateCostUsd("openrouter/free", 100, 10), 0);
  } finally { installModelsDevPricing({}, 1792900000000); }
});
