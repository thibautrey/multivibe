import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd } from "./model-pricing.js";
import { CODING_AGENT_ROLE_HEADER, CODING_TASK_ID_HEADER, buildTaskLedger, buildTaskLedgerEntry } from "./task-ledger.js";
import { CODING_PARENT_MODEL, CODING_WORKER_MODEL } from "./coding-economy-model.js";
import type { TraceEntry } from "./traces.js";

const PARENT = "gpt-5.2-codex";
const WORKER = "gpt-5.1-codex-mini";

function turn(overrides: Partial<TraceEntry>): TraceEntry {
  return {
    id: `trace-${Math.random()}`,
    at: 1_700_000_000_000,
    route: "/responses",
    traceKind: "upstream-attempt",
    status: 200,
    isError: false,
    stream: true,
    latencyMs: 10,
    usageStatus: "measured",
    ...overrides,
  } as TraceEntry;
}

test("groups explicit-task turns by role and keeps the four cost kinds separate", () => {
  const traces = [
    turn({ id: "p1", model: CODING_PARENT_MODEL, resolvedModel: PARENT, tokensInput: 10_000, tokensOutput: 500,
      costUsd: estimateCostUsd(PARENT, 10_000, 500), requestHeaders: { [CODING_TASK_ID_HEADER]: "task-1" } }),
    turn({ id: "w1", at: 1_700_000_001_000, model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 1_000, tokensOutput: 100,
      costUsd: estimateCostUsd(WORKER, 1_000, 100), accountId: "sub-1", executionLocation: "cloud",
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-1" } }),
    turn({ id: "w2", at: 1_700_000_002_000, model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 500, tokensOutput: 50,
      costUsd: estimateCostUsd(WORKER, 500, 50), accountId: "local-1", executionLocation: "local",
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-1" } }),
  ];
  const [task] = buildTaskLedger(traces, {
    parentModel: PARENT,
    subscriptionAccountIds: new Set(["sub-1"]),
    localAccountIds: new Set(["local-1"]),
  });

  assert.equal(task.taskId, "task-1");
  assert.equal(task.correlation, "explicit");
  assert.equal(task.turns, 3);
  assert.deepEqual(task.roles.parent, { turns: 1, tokens: 10_500 });
  assert.deepEqual(task.roles.worker, { turns: 2, tokens: 1_650 });
  assert.equal(task.priceIncomplete, false);
  assert.equal(task.unpricedTurns, 0);
  assert.ok(Math.abs(task.measuredApiCashUsd - (estimateCostUsd(PARENT, 10_000, 500)! + estimateCostUsd(WORKER, 1_000, 100)! + estimateCostUsd(WORKER, 500, 50)!)) < 1e-12);
  // Subscription quota is reported in tokens, not dollars.
  assert.equal(task.estimatedSubscriptionQuotaUnits, 1_100);
  // Local compute is reported in tokens and never as cash.
  assert.equal(task.localComputeTokens, 550);
  // Counterfactual savings only reprice worker turns at the parent model's rates.
  const workerInput = 1_000 + 500;
  const workerOutput = 100 + 50;
  const expectedSavings = estimateCostUsd(PARENT, workerInput, workerOutput)! - estimateCostUsd(WORKER, workerInput, workerOutput)!;
  assert.ok(Math.abs(task.counterfactualSavingsUsd! - expectedSavings) < 1e-12);
  assert.match(task.counterfactualBasis!, /Not a measured saving/);
});

test("unknown prices stay unknown instead of becoming zero", () => {
  const traces = [
    turn({ id: "u1", model: CODING_WORKER_MODEL, resolvedModel: "unlisted-model", tokensInput: 100, tokensOutput: 10,
      costUsd: undefined, requestHeaders: { [CODING_TASK_ID_HEADER]: "task-unknown" } }),
  ];
  const [task] = buildTaskLedger(traces, { parentModel: PARENT });
  assert.equal(task.measuredApiCashUsd, 0);
  assert.equal(task.unpricedTurns, 1);
  assert.equal(task.priceIncomplete, true);
  assert.equal(task.counterfactualSavingsUsd, undefined);
});

test("correlates by session, honors the explicit role header, and never fabricates an attribution", () => {
  const session = buildTaskLedger([
    turn({ id: "s1", model: CODING_PARENT_MODEL, resolvedModel: PARENT, codexSessionId: "thread-9", tokensInput: 10, tokensOutput: 1, costUsd: 0.000001 }),
  ])[0];
  assert.equal(session.taskId, "session:thread-9");
  assert.equal(session.correlation, "session");

  const headerRole = buildTaskLedger([
    turn({ id: "h1", model: PARENT, resolvedModel: PARENT, tokensInput: 10, tokensOutput: 1, costUsd: 0.000001,
      requestHeaders: { [CODING_AGENT_ROLE_HEADER]: "worker", [CODING_TASK_ID_HEADER]: "task-header" } }),
  ])[0];
  assert.equal(headerRole.roles.worker.turns, 1);

  const unattributed = buildTaskLedger([
    turn({ id: "a1", model: PARENT, resolvedModel: PARENT, application: "app", tokensInput: 10, tokensOutput: 1, costUsd: 0.000001 }),
  ])[0];
  assert.equal(unattributed.correlation, "unattributed");
  assert.match(unattributed.taskId, /^unattributed:app:/);
  assert.equal(unattributed.roles.unattributed.turns, 1);
});

test("ignores failed attempts and non-inference routes, and looks up a single task", () => {
  const traces = [
    turn({ id: "ok", model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 10, tokensOutput: 1, costUsd: 0.00001,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-2" } }),
    turn({ id: "failed", model: CODING_WORKER_MODEL, resolvedModel: WORKER, status: 500, isError: true, tokensInput: 10, tokensOutput: 1, costUsd: 0.5,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-2" } }),
    turn({ id: "other-route", route: "/admin/modules", model: CODING_WORKER_MODEL, tokensInput: 10, tokensOutput: 1, costUsd: 0.5,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-2" } }),
    turn({ id: "client", traceKind: "client-request", model: CODING_WORKER_MODEL, tokensInput: 10, tokensOutput: 1, costUsd: 0.5,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-2" } }),
  ];
  const tasks = buildTaskLedger(traces);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].turns, 1);
  assert.equal(tasks[0].measuredApiCashUsd, 0.00001);
  assert.equal(buildTaskLedgerEntry(traces, "task-2")?.turns, 1);
  assert.equal(buildTaskLedgerEntry(traces, "missing"), undefined);
});
