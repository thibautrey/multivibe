import test from "node:test";
import assert from "node:assert/strict";
import * as backend from "../../src/model-pricing.js";
import * as ui from "../../packages/ui/src/model-pricing.js";

test("UI and backend share the same estimator and live pricing registry", () => {
  assert.equal(ui.estimateCostUsd, backend.estimateCostUsd);
  assert.equal(ui.getModelPricing, backend.getModelPricing);
  assert.ok(Math.abs(ui.estimateCostUsd("gpt-6.1-sol", 100000, 10000)! - 0.3) < 1e-12);
});
