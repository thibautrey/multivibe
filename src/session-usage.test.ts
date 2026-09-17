import assert from "node:assert/strict";
import test from "node:test";
import { aggregateSessionUsage, sessionTurnsFor } from "./session-usage.js";
import { sessionKeyFor } from "./session-identity.js";
import type { TraceEntry } from "./traces.js";

const BASE = 1_728_000_000_000;

function attempt(
  overrides: Partial<TraceEntry> & Pick<TraceEntry, "id" | "at">,
): TraceEntry {
  return {
    route: "/v1/responses",
    traceKind: "upstream-attempt",
    application: "codex",
    codexSessionId: "thread-one",
    provider: "openai",
    model: "gpt-5.4-mini",
    status: 200,
    isError: false,
    stream: true,
    latencyMs: 900,
    lifecycleState: "completed",
    usageStatus: "measured",
    ...overrides,
  };
}

test("aggregates per-session turns, growth and cache reuse", () => {
  const traces: TraceEntry[] = [
    attempt({
      id: "turn-1",
      at: BASE,
      clientRequestId: "request-1",
      tokensInput: 12_000,
      tokensInputCached: 0,
      tokensOutput: 300,
      tokensTotal: 12_300,
    }),
    attempt({
      id: "turn-2-attempt-1",
      at: BASE + 1_000,
      clientRequestId: "request-2",
      upstreamAttempt: 1,
      status: 429,
      isError: true,
      tokensInput: 15_000,
      tokensOutput: 0,
    }),
    attempt({
      id: "turn-2-attempt-2",
      at: BASE + 1_100,
      clientRequestId: "request-2",
      upstreamAttempt: 2,
      tokensInput: 15_000,
      tokensInputCached: 12_000,
      tokensOutput: 250,
      tokensTotal: 15_250,
    }),
    attempt({
      id: "turn-3",
      at: BASE + 2_000,
      clientRequestId: "request-3",
      tokensInput: 17_000,
      tokensInputCached: 16_000,
      tokensOutput: 400,
      tokensTotal: 17_400,
    }),
    attempt({
      id: "turn-4",
      at: BASE + 3_000,
      clientRequestId: "request-4",
      status: 429,
      isError: true,
      tokensInput: 18_000,
      tokensOutput: 0,
    }),
  ];

  const { summary, sessions } = aggregateSessionUsage(traces);
  assert.equal(sessions.length, 1);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.turns, 4);
  assert.equal(summary.coverage, 1);
  assert.equal(summary.turnsPerSessionMedian, 4);

  const session = sessions[0];
  assert.equal(session.sessionKey, sessionKeyFor("codex", "thread-one"));
  assert.equal(session.turns, 4);
  assert.equal(session.initialInputTokens, 12_000);
  assert.equal(session.initialInputTokenBucket, "8k-32k");
  assert.equal(session.medianInputTokens, 16_000);
  assert.equal(session.maxInputTokens, 18_000);
  assert.equal(session.contextGrowthTokens, 6_000);
  assert.equal(session.cachedInputTokens, 28_000);
  assert.equal(session.inputTokens, 62_000);
  assert.equal(session.cachedInputRatio, 28_000 / 62_000);
  assert.equal(session.cacheHitTurns, 2);
  assert.equal(session.cacheMissTurns, 2);
  assert.equal(session.cacheWriteTurns, 0);
  assert.equal(session.errorTurns, 1);
  assert.deepEqual(session.models, ["gpt-5.4-mini"]);
  assert.equal(session.firstAt, BASE);
  assert.equal(session.lastAt, BASE + 3_000);
  assert.equal(session.durationMs, 3_000);
  assert.ok(session.costUsd > 0);
  assert.ok(session.costUsdWithoutCache > session.costUsd);
  assert.ok(session.cacheSavingsUsd > 0);
  assert.equal(summary.cacheSavingsUsd, session.cacheSavingsUsd);
});

test("reports coverage and skips traces without a session identity", () => {
  const traces: TraceEntry[] = [
    attempt({
      id: "identified-1",
      at: BASE,
      clientRequestId: "request-1",
      tokensInput: 1_000,
      tokensOutput: 100,
    }),
    attempt({
      id: "anonymous-1",
      at: BASE + 1,
      codexSessionId: undefined,
      clientRequestId: "request-2",
      tokensInput: 2_000,
      tokensOutput: 200,
    }),
    attempt({
      id: "anonymous-2",
      at: BASE + 2,
      codexSessionId: undefined,
      clientRequestId: "request-3",
      tokensInput: 3_000,
      tokensOutput: 300,
    }),
    {
      id: "client-outcome",
      at: BASE + 3,
      route: "POST /v1/responses",
      traceKind: "client-request",
      status: 200,
      isError: false,
      stream: true,
      latencyMs: 100,
      clientRequestId: "request-1",
    },
  ];

  const { summary, sessions } = aggregateSessionUsage(traces);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.totalAttempts, 3);
  assert.equal(summary.attempts, 1);
  assert.equal(summary.coverage, 1 / 3);
  assert.equal(sessions[0].turns, 1);
});

test("scopes identical session ids by application", () => {
  const traces: TraceEntry[] = [
    attempt({
      id: "a-1",
      at: BASE,
      application: "codex-a",
      codexSessionId: "shared",
      clientRequestId: "request-1",
      tokensInput: 1_000,
      tokensOutput: 100,
    }),
    attempt({
      id: "b-1",
      at: BASE + 1,
      application: "codex-b",
      codexSessionId: "shared",
      clientRequestId: "request-2",
      tokensInput: 2_000,
      tokensOutput: 200,
    }),
  ];

  const { sessions } = aggregateSessionUsage(traces);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((session) => session.application).sort(),
    ["codex-a", "codex-b"],
  );
  assert.notEqual(sessions[0].sessionKey, sessions[1].sessionKey);
});

test("returns ordered turns for a session key", () => {
  const traces: TraceEntry[] = [
    attempt({
      id: "turn-2",
      at: BASE + 1_000,
      clientRequestId: "request-2",
      tokensInput: 2_000,
      tokensOutput: 200,
    }),
    attempt({
      id: "turn-1",
      at: BASE,
      clientRequestId: "request-1",
      tokensInput: 1_000,
      tokensOutput: 100,
    }),
    attempt({
      id: "other-session",
      at: BASE + 2_000,
      codexSessionId: "thread-two",
      clientRequestId: "request-3",
      tokensInput: 3_000,
      tokensOutput: 300,
    }),
  ];

  const key = sessionKeyFor("codex", "thread-one");
  const turns = sessionTurnsFor(traces, key);
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => turn.clientRequestId),
    ["request-1", "request-2"],
  );
  assert.equal(turns[0].inputTokens, 1_000);
  assert.deepEqual(sessionTurnsFor(traces, "0".repeat(24)), []);
});
