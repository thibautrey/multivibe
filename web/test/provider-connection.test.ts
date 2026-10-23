import assert from "node:assert/strict";
import test from "node:test";
import { providerAccountTarget } from "../../packages/ui/src/lib/providerConnection";

test("OpenAI API key connections use the standard API adapter", () => {
  assert.deepEqual(providerAccountTarget("openai", "anthropic", "api-key"), {
    provider: "ai-sdk",
    sdkProvider: "openai",
  });
});

test("OpenAI subscription connections keep the ChatGPT transport", () => {
  assert.deepEqual(providerAccountTarget("openai", "anthropic", "subscription"), {
    provider: "openai",
    sdkProvider: undefined,
  });
});
