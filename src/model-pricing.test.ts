import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd, estimateCostUsdWithoutCache, getModelPricing, setModelBillingOverrides } from "./model-pricing.js";
import { setOffPeakSchedule } from "./off-peak.js";

const expected: Record<string, [number, number, number, number?]> = {
  "gpt-5.6-sol": [5, 0.5, 30, 6.25],
  "gpt-5.6-terra": [2, 0.2, 12, 2.5],
  "gpt-5.6-luna": [0.2, 0.02, 1.2, 0.25],
  "daybreak-blue-latest": [4, 0.4, 20, 5],
  "gpt-daybreak-blue-latest": [4, 0.4, 20, 5],
  "gpt-5.5": [5, 0.5, 30],
  "gpt-6-astra": [10, 1, 50, 12.5],
  "gpt-5.6-cyber": [12.5, 1.25, 75, 15.625],
  "gpt-daybreak-red-latest": [12.5, 1.25, 75, 15.625],
  "gpt-5.4": [2.5, 0.25, 15],
  "gpt-5.4-mini": [0.75, 0.075, 4.5],
  "gpt-5.3-codex": [1.75, 0.175, 14],
  "gpt-5.2": [1.75, 0.175, 14],
};

test("uses current standard API prices for the requested metered models", () => {
  for (const [model, [inputPer1M, cachedInputPer1M, outputPer1M, cacheWriteInputPer1M]] of Object.entries(expected)) {
    assert.deepEqual(getModelPricing(model), {
      inputPer1M,
      cachedInputPer1M,
      ...(cacheWriteInputPer1M
        ? { cacheWriteInputPer1M }
        : {}),
      outputPer1M,
      ...(model === "gpt-5.4"
        ? { longContext: { thresholdTokens: 272_000, inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 22.5 } }
        : model === "gpt-5.5"
          ? { longContext: { thresholdTokens: 272_000, inputPer1M: 10, cachedInputPer1M: 1, outputPer1M: 45 } }
          : model === "gpt-6-astra"
            ? { longContext: { thresholdTokens: 272_000, inputPer1M: 20, cachedInputPer1M: 2, cacheWriteInputPer1M: 25, outputPer1M: 75 } }
          : {}),
    });
  }
});

test("keeps plan-only and unpublished service models unpriced", () => {
  assert.equal(getModelPricing("gpt-5.3-codex-spark"), undefined);
  assert.equal(getModelPricing("codex-auto-review"), undefined);
});

test("applies long-context prices after 272K input tokens", () => {
  assert.ok(Math.abs((estimateCostUsd("gpt-5.4", 272_001, 1_000) ?? 0) - 1.382505) < 1e-12);
  assert.ok(Math.abs((estimateCostUsd("gpt-5.5", 272_001, 1_000) ?? 0) - 2.76501) < 1e-12);
});

test("charges GPT-5.6 cache writes at 1.25x without double-counting input", () => {
  const cost = estimateCostUsd(
    "gpt-5.6-sol",
    1_000_000,
    0,
    200_000,
    300_000,
  );
  assert.equal(cost, 4.475);
});

test("operator-set billed rates override upstream pricing, including cached input", () => {
  setModelBillingOverrides({
    "gpt-5.4": { inputPer1M: 3, outputPer1M: 18, cachedInputPer1M: 0.3 },
  });
  try {
    assert.deepEqual(getModelPricing("gpt-5.4"), {
      inputPer1M: 3,
      outputPer1M: 18,
      cachedInputPer1M: 0.3,
    });
    // Qualified and dated ids resolve to the same operator price.
    assert.equal(getModelPricing("openai/gpt-5.4")?.outputPer1M, 18);
    assert.equal(getModelPricing("gpt-5.4-2026-01-01")?.inputPer1M, 3);
    // A sibling model keeps its own upstream rate.
    assert.equal(getModelPricing("gpt-5.4-mini")?.inputPer1M, 0.75);
    // Input 1M (200k cached) + output 1M.
    assert.equal(estimateCostUsd("gpt-5.4", 1_000_000, 1_000_000, 200_000), 0.8 * 3 + 0.2 * 0.3 + 18);
    // Clearing the override restores the catalog rate.
    setModelBillingOverrides(undefined);
    assert.equal(getModelPricing("gpt-5.4")?.inputPer1M, 2.5);
  } finally {
    setModelBillingOverrides(undefined);
  }
});

test("off-peak rates replace standard rates only inside the schedule", () => {
  setModelBillingOverrides({
    "gpt-5.4": {
      inputPer1M: 3,
      outputPer1M: 18,
      offPeak: { inputPer1M: 1, outputPer1M: 6, cachedInputPer1M: 0.1 },
    },
  });
  setOffPeakSchedule({
    enabled: true,
    timezone: "UTC",
    days: { mon: [{ start: "09:00", end: "10:00" }] },
  });
  try {
    const inside = Date.parse("2026-11-30T09:30:00Z");
    const outside = Date.parse("2026-11-30T10:30:00Z");
    assert.deepEqual(getModelPricing("gpt-5.4", inside), {
      inputPer1M: 1,
      outputPer1M: 6,
      cachedInputPer1M: 0.1,
    });
    assert.deepEqual(getModelPricing("gpt-5.4", outside), {
      inputPer1M: 3,
      outputPer1M: 18,
    });
    // Input 1M (200k cached) + output 1M.
    assert.equal(
      estimateCostUsd("gpt-5.4", 1_000_000, 1_000_000, 200_000, 0, inside),
      0.8 * 1 + 0.2 * 0.1 + 6,
    );
    assert.equal(
      estimateCostUsd("gpt-5.4", 1_000_000, 1_000_000, 200_000, 0, outside),
      0.8 * 3 + 0.2 * 3 + 18,
    );
    setOffPeakSchedule({
      enabled: false,
      timezone: "UTC",
      days: { mon: [{ start: "09:00", end: "10:00" }] },
    });
    assert.deepEqual(getModelPricing("gpt-5.4", inside), {
      inputPer1M: 3,
      outputPer1M: 18,
    });
    // A model without off-peak rates keeps its standard (catalog) rate.
    setOffPeakSchedule({
      enabled: true,
      timezone: "UTC",
      days: { mon: [{ start: "09:00", end: "10:00" }] },
    });
    assert.equal(getModelPricing("gpt-5.4-mini", inside)?.inputPer1M, 0.75);
  } finally {
    setOffPeakSchedule(undefined);
    setModelBillingOverrides(undefined);
  }
});

test("charges GPT-6 Astra long-context cache writes at 1.25x without double-counting input", () => {
  assert.equal(
    estimateCostUsd("gpt-6-astra", 1_000_000, 1_000_000, 200_000, 300_000),
    92.9,
  );
  assert.deepEqual(getModelPricing("gpt-6-astra-2026-08-01"), {
    inputPer1M: 10,
    cachedInputPer1M: 1,
    cacheWriteInputPer1M: 12.5,
    outputPer1M: 50,
    longContext: { thresholdTokens: 272_000, inputPer1M: 20, cachedInputPer1M: 2, cacheWriteInputPer1M: 25, outputPer1M: 75 },
  });
});

test("prices cached input at the standard rate for the no-cache equivalent", () => {
  assert.equal(
    estimateCostUsdWithoutCache(
      "gpt-5.6-sol",
      1_000_000,
      0,
      300_000,
    ),
    5.375,
  );
});

test("prices image generation and edits with separate text and image input rates", async () => {
  const { estimateImageCostUsd, estimateTraceCostUsd } = await import("./model-pricing.js");
  for (const model of ["gpt-image-2", "openai/gpt-image-2", "openai/gpt-image-2.5-flare", "gpt-image-2.5-flare-2026-09-08"]) {
    assert.equal(getModelPricing(model)?.outputPer1M, 30);
    const usage = {input_tokens: 1000, output_tokens: 2000, input_tokens_details: {text_tokens: 200, image_tokens: 800, cached_tokens: 500}};
    assert.equal(estimateImageCostUsd(model, usage), 0.0674);
    assert.equal(estimateTraceCostUsd({model, route: "/v1/images/edits", usage}), 0.0674);
    assert.equal(estimateTraceCostUsd({model, route: "/v1/images/edits", usage, costUsd: 0.12}), 0.12);
    assert.equal(estimateImageCostUsd(model, {input_tokens: 100, output_tokens: 1000}), 0.0305);
    assert.equal(estimateImageCostUsd(model, {}), undefined);
    assert.equal(estimateImageCostUsd(model, {input_tokens: 1, output_tokens: 1, input_tokens_details: {image_tokens: 2}}), undefined);
  }
  assert.equal(getModelPricing("gpt-image-2.5-unknown"), undefined);
  assert.equal(estimateImageCostUsd("other/gpt-image-2", {input_tokens: 1, output_tokens: 1}), undefined);
});
