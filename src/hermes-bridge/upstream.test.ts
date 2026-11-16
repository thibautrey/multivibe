import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BRIDGE_CONFIG, mapModel, isLoopbackHost, type BridgeConfig, type ModelMapping } from "./config.js";
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

test("a turn can never change upstream after its first byte", () => {
  assert.equal(canSwitchAfterFirstByte(), false);
});
