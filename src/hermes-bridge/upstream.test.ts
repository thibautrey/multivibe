import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BRIDGE_CONFIG, deriveNousModel, mapModel, isLoopbackHost, type BridgeConfig, type ModelMapping } from "./config.js";
import { canSwitchAfterFirstByte, routeTurn } from "./upstream.js";

const MAPPINGS: ModelMapping[] = [
  { from: "hermes-4-405b", edge: "nousresearch/hermes-4-405b", nous: "hermes-4-405b" },
  { from: "hermes-4-70b", edge: "nousresearch/hermes-4-70b", nous: "hermes-4-70b" },
];

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return { ...DEFAULT_BRIDGE_CONFIG, mappings: MAPPINGS, ...overrides };
}

test("maps a model per upstream and refuses to invent one", () => {
  assert.equal(mapModel(MAPPINGS, "hermes-4-405b", "edge"), "nousresearch/hermes-4-405b");
  assert.equal(mapModel(MAPPINGS, "hermes-4-405b", "nous"), "hermes-4-405b");
  assert.equal(mapModel(MAPPINGS, "unknown-model", "edge"), undefined);
});

test("only loopback binds are accepted", () => {
  assert.ok(isLoopbackHost("127.0.0.1"));
  assert.ok(isLoopbackHost("localhost"));
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
});

test("an edge offering capacity is used", () => {
  const decision = routeTurn(config(), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    edge: { reachable: true, admission: { decision: "admit", lease: "adml_1" } },
  });
  assert.deepEqual(decision, { upstream: "edge", reason: "mode", model: "nousresearch/hermes-4-405b" });
});

test("an unreachable edge falls back to Nous instead of failing", () => {
  for (const error of ["timeout", "http", "network"] as const) {
    const decision = routeTurn(config(), MAPPINGS, {
      requestedModel: "hermes-4-405b",
      now: 1_000,
      edge: { reachable: false, error },
    });
    assert.equal(decision.upstream, "nous");
    assert.equal(decision.model, "hermes-4-405b");
  }
});

test("a timeout is reported distinctly from a plain outage", () => {
  const timeout = routeTurn(config(), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    edge: { reachable: false, error: "timeout" },
  });
  assert.equal(timeout.reason, "edge_timeout");
});

test("no equivalent model refuses the turn rather than downgrading", () => {
  const decision = routeTurn(config(), MAPPINGS, {
    requestedModel: "unmapped-model",
    now: 1_000,
    edge: { reachable: false, error: "network" },
  });
  assert.deepEqual(decision, { upstream: null, reason: "no_equivalent_model", model: null });
});

test("an edge at capacity sends the turn to Nous", () => {
  const decision = routeTurn(config(), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    edge: { reachable: true, admission: { decision: "queue", waitMs: 30_000 } },
  });
  assert.equal(decision.upstream, "nous");
  assert.equal(decision.reason, "edge_queued");
});

test("a switched conversation stays on Nous while sticky", () => {
  const decision = routeTurn(config(), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    stickyUntilMs: 60_000,
    edge: { reachable: true, admission: { decision: "admit" } },
  });
  assert.equal(decision.upstream, "nous");
  assert.equal(decision.reason, "sticky_nous");
});

test("stickiness expires", () => {
  const decision = routeTurn(config(), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 100_000,
    stickyUntilMs: 60_000,
    edge: { reachable: true, admission: { decision: "admit" } },
  });
  assert.equal(decision.upstream, "edge");
});

test("pinned modes ignore admission entirely", () => {
  const nousOnly = routeTurn(config({ mode: "nous-only" }), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    edge: { reachable: true, admission: { decision: "admit" } },
  });
  assert.equal(nousOnly.upstream, "nous");

  const edgeOnly = routeTurn(config({ mode: "edge-only" }), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    edge: { reachable: false, error: "network" },
  });
  assert.equal(edgeOnly.upstream, "edge");
});

test("edge-first waits out a queue inside its budget instead of switching", () => {
  // The caller chose `edge-first`, so queueing is the answer they asked for.
  const decision = routeTurn(config({ mode: "edge-first" }), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    edge: { reachable: true, admission: { decision: "queue", waitMs: 10_000 } },
  });
  assert.equal(decision.upstream, null, "no upstream yet, but not a switch");
  assert.equal(decision.reason, "edge_queued");
});

test("edge-first still switches once the wait exceeds its budget", () => {
  const decision = routeTurn(config({ mode: "edge-first", maxQueueWaitMs: 5_000 }), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    edge: { reachable: true, admission: { decision: "queue", waitMs: 60_000 } },
  });
  assert.equal(decision.upstream, "nous");
});

test("an explicit switch request is honoured in either mode", () => {
  const decision = routeTurn(config({ mode: "edge-first" }), MAPPINGS, {
    requestedModel: "hermes-4-405b",
    now: 1_000,
    edge: { reachable: true, admission: { decision: "switch", waitMs: 1_000 } },
  });
  assert.equal(decision.upstream, "nous");
});

test("a turn can never change upstream after its first byte", () => {
  assert.equal(canSwitchAfterFirstByte(), false);
});

test("the Nous identifier is derived from its own catalogue, never guessed", async () => {
  // Nous qualifies hosted models as `vendor/name` while the edge often serves the
  // bare `name`. Deriving the correspondence from `GET /v1/models` turns a human
  // decision into a lookup, but only a *hit* counts: an invented mapping would
  // silently change which model answers.
  const catalogue = ["deepseek/deepseek-v4.1-flash", "openai/gpt-5.6", "z-ai/glm-5.3"];

  assert.equal(deriveNousModel("deepseek-v4.1-flash", catalogue), "deepseek/deepseek-v4.1-flash");
  assert.equal(deriveNousModel("deepseek-v4.1-flash", ["deepseek/deepseek-chat"]), undefined);
  // Already-qualified names resolve to themselves when Nous lists them.
  assert.equal(deriveNousModel("openai/gpt-5.6", catalogue), "openai/gpt-5.6");
  assert.equal(deriveNousModel("z-ai/glm-5.3", catalogue), "z-ai/glm-5.3");
  // A model Nous does not host must stay unmapped: the bridge waits instead.
  assert.equal(deriveNousModel("gpt-5.6", []), undefined);
  assert.equal(deriveNousModel("gpt-5.6", ["openai/gpt-5"]), undefined);
  // An empty request is not a model.
  assert.equal(deriveNousModel("", catalogue), undefined);
});
