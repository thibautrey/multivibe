import assert from "node:assert/strict";
import test from "node:test";
import { tracksSubscriptionQuota } from "../src/lib/accountQuota.js";
import type { Account, LocalRuntimeAdapterId } from "../src/types.js";

const localRuntimeAdapters: LocalRuntimeAdapterId[] = [
  "omlx",
  "ollama",
  "lm-studio",
  "vllm",
  "nvidia-pair",
  "manual-openai-compatible",
];

test("subscription quota tracking never applies to local runtimes", () => {
  for (const adapter of localRuntimeAdapters) {
    const account: Account = {
      id: `local-runtime-${adapter}`,
      provider: "openai-compatible",
      accessToken: "",
      enabled: true,
      localRuntime: {
        source:
          adapter === "nvidia-pair"
            ? "multivibe-local-configuration"
            : "multivibe-local-discovery",
        adapter,
        endpoint: "http://127.0.0.1:8000",
        confirmedModelIds: ["test/model"],
        authentication: "none",
      },
    };

    assert.equal(tracksSubscriptionQuota(account), false, adapter);
  }
});

test("hosted provider accounts retain subscription quota tracking", () => {
  assert.equal(
    tracksSubscriptionQuota({
      id: "openai-account",
      provider: "openai",
      accessToken: "token",
      enabled: true,
    }),
    true,
  );
});

test("the synthetic MultiVibe Cloud account uses its credit balance instead", () => {
  assert.equal(
    tracksSubscriptionQuota({
      id: "multivibe-cloud",
      provider: "openai-compatible",
      accessToken: "",
      enabled: true,
      multivibeCloud: true,
    }),
    false,
  );
});
