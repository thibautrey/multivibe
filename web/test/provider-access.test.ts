import assert from "node:assert/strict";
import test from "node:test";
import { matchesAccessFilter, PROVIDER_ACCESS } from "../src/lib/providerAccess";
import { SDK_PROVIDERS } from "../../src/ai-sdk/providers";

test("free tiers also support paid and freemium filtering", () => {
  for (const id of ["openai", "google", "groq", "openrouter", "opencode", "mistral", "zai"]) {
    for (const filter of ["Paid", "Free", "Freemium"] as const) assert.equal(matchesAccessFilter(id, filter), true, `${id}: ${filter}`);
  }
});
test("trials and consumer free plans do not imply free API access", () => {
  for (const id of ["cerebras", "togetherai", "deepseek", "anthropic", "perplexity", "xai"]) {
    assert.equal(matchesAccessFilter(id, "Free"), false);
    assert.equal(matchesAccessFilter(id, "Freemium"), false);
    assert.equal(matchesAccessFilter(id, "Paid"), true);
  }
});
test("unknown and custom endpoints are not assigned guessed pricing", () => {
  for (const id of ["new-provider", "nvidia-pair", "openai-compatible"]) {
    assert.equal(matchesAccessFilter(id, null), true);
    for (const filter of ["Paid", "Free", "Freemium"] as const) assert.equal(matchesAccessFilter(id, filter), false);
  }
  for (const { id } of SDK_PROVIDERS) assert.ok(PROVIDER_ACCESS[id], `Review pricing for ${id}`);
});
