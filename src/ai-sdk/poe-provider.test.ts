import assert from "node:assert/strict";
import test from "node:test";
import { POE_CATALOG_SOURCE, POE_MODELS, POE_PROVIDER } from "./poe-provider.js";

test("Poe uses its documented OpenAI-compatible endpoint", () => {
  assert.deepEqual(POE_PROVIDER, {
    id: "poe",
    name: "Poe",
    adapter: "compatible",
    baseURL: "https://api.poe.com/v1",
  });
  assert.equal(POE_CATALOG_SOURCE,
    "https://creator.poe.com/docs/external-applications/openai-compatible-api");
});

test("Poe catalog contains only unique documented model IDs", () => {
  assert.deepEqual(POE_MODELS.map(({ id }) => id), [
    "GPT-5.4",
    "Claude-Sonnet-4.6",
    "Claude-Opus-4.7",
    "Gemini-3.1-Pro",
  ]);
  assert.equal(new Set(POE_MODELS.map(({ id }) => id)).size, POE_MODELS.length);
  assert.ok(POE_MODELS.every((model) => model.input.includes("text")));
});
