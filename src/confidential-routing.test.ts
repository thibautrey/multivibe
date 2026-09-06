import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAliasPolicy,
  parseRoutingHeaders,
  type ResourceSnapshot,
} from "./smart-routing.js";
import type { ModelAlias } from "./types.js";

test("confidential privacy opts into synchronous fail-closed routing", () => {
  const request = parseRoutingHeaders({
    "x-multivibe-privacy": "confidential_verified",
  });
  assert.equal(request.privacyMode, "confidential_verified");
  assert.equal(request.executionMode, "sync");
  assert.equal(request.optedIn, true);

  const alias: ModelAlias = {
    schemaVersion: 2,
    id: "private-model",
    enabled: true,
    rules: [{
      id: "confidential-only",
      constraints: { requiredPrivacy: "confidential_verified" },
      candidates: [{ model: "private-model" }],
      onNoCapacity: "reject",
    }],
  };
  const base: Omit<ResourceSnapshot, "accountId" | "privacyMode"> = {
    model: "private-model",
    provider: "openai-compatible",
    location: "cloud",
    enabled: true,
    inFlight: 0,
    maxConcurrent: 2,
    freeSlots: 2,
    predictedWaitMs: 0,
    averageLatencyMs: 100,
    confidence: "declared",
  };
  const decision = evaluateAliasPolicy(alias, request, [
    { ...base, accountId: "ordinary", privacyMode: "standard" },
    { ...base, accountId: "protected", privacyMode: "confidential_verified" },
  ]);
  assert.deepEqual(decision.eligible.map((candidate) => candidate.resource.accountId), ["protected"]);
  assert.deepEqual(
    decision.candidates.find((candidate) => candidate.resource.accountId === "ordinary")?.rejectedReasons,
    ["privacy_mode_not_allowed"],
  );
});
