import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCodingEconomy } from "./coding-economy-benchmark.js";
import { CODING_PARENT_MODEL, CODING_WORKER_MODEL } from "./coding-economy-model.js";
import { CODING_TASK_ID_HEADER } from "./task-ledger.js";
import { estimateCostUsd } from "./model-pricing.js";
import type { TraceEntry } from "./traces.js";

const PARENT = "gpt-5.2-codex";
const WORKER = "gpt-5.1-codex-mini";

function turn(overrides: Partial<TraceEntry>): TraceEntry {
  return {
    id: `t-${Math.random()}`,
    at: 1_700_000_000_000,
    route: "/responses",
    traceKind: "upstream-attempt",
    status: 200,
    isError: false,
    stream: true,
    latencyMs: 5,
    usageStatus: "measured",
    ...overrides,
  } as TraceEntry;
}

test("reports a warm delegated task that beats the parent baseline", () => {
  const traces = [
    turn({ id: "p", model: CODING_PARENT_MODEL, resolvedModel: PARENT, tokensInput: 20_000, tokensOutput: 400,
      costUsd: estimateCostUsd(PARENT, 20_000, 400), requestHeaders: { [CODING_TASK_ID_HEADER]: "warm-task" } }),
    turn({ id: "w", model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 8_000, tokensInputCached: 7_000, tokensOutput: 300,
      costUsd: estimateCostUsd(WORKER, 8_000, 300, 7_000), requestHeaders: { [CODING_TASK_ID_HEADER]: "warm-task" } }),
  ];
  const evaluation = evaluateCodingEconomy(traces, { parentModel: PARENT, marginPercent: 20 });
  const [task] = evaluation.tasks;
  assert.equal(task.cacheState, "warm");
  assert.ok(task.predictedSavingUsd! > 0, "delegation still wins");
  // A cached parent context is priced at its own cached rate, so a warm worker
  // that still has to prefill part of its context saves far less than list
  // prices suggest. The margin gate is what surfaces that.
  assert.ok(task.predictedSavingPercent! > 0 && task.predictedSavingPercent! < 20);
  assert.equal(task.meetsMargin, false);
  assert.equal(evaluation.totals.uneconomicTasks, 1);
  assert.equal(evaluateCodingEconomy(traces, { parentModel: PARENT, marginPercent: 5 }).tasks[0].meetsMargin, true);
});

test("reports a cold worker context honestly instead of implying a guaranteed saving", () => {
  const traces = [
    turn({ id: "w", model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 200_000, tokensOutput: 200,
      costUsd: estimateCostUsd(WORKER, 200_000, 200), requestHeaders: { [CODING_TASK_ID_HEADER]: "cold-task" } }),
  ];
  const [task] = evaluateCodingEconomy(traces, { parentModel: PARENT }).tasks;
  assert.equal(task.cacheState, "cold");
  // Repricing identical token counts always favours the cheaper model, which is
  // exactly why the cold-context warning must accompany the number.
  assert.ok(task.predictedSavingUsd! > 0);
  assert.match(task.notes.join(" "), /Cold worker context/);
});

test("an unpriced pair of turns keeps the comparison unknown", () => {
  const traces = [
    turn({ id: "w", model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 5_000, tokensInputCached: 4_000, tokensOutput: 100,
      costUsd: estimateCostUsd(WORKER, 5_000, 100, 4_000), requestHeaders: { [CODING_TASK_ID_HEADER]: "mixed-task" } }),
  ];
  const [task] = evaluateCodingEconomy(traces, { parentModel: PARENT }).tasks;
  assert.equal(task.cacheState, "warm");
  assert.equal(task.uncachedInputTokens, 1_000);
  assert.equal(task.cachedInputTokens, 4_000);
});

test("keeps the baseline unknown when it cannot be priced", () => {
  const unpricedParent = evaluateCodingEconomy([
    turn({ id: "w", model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 10, tokensOutput: 1, costUsd: 0.00001,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-a" } }),
  ], { parentModel: "no-such-published-model" });
  assert.equal(unpricedParent.tasks[0].baselineParentCostUsd, undefined);
  assert.equal(unpricedParent.tasks[0].predictedSavingUsd, undefined);
  assert.equal(unpricedParent.tasks[0].meetsMargin, undefined);
  assert.equal(unpricedParent.totals.baselineParentCostUsd, undefined);

  const missingModel = evaluateCodingEconomy([
    turn({ id: "w", model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 10, tokensOutput: 1, costUsd: 0.00001,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-b" } }),
    turn({ id: "u", model: CODING_WORKER_MODEL, resolvedModel: "unlisted", tokensInput: 10, tokensOutput: 1, costUsd: undefined,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "task-b" } }),
  ], { parentModel: PARENT });
  assert.equal(missingModel.totals.priceIncompleteTasks, 1);
  assert.match(missingModel.tasks[0].notes.join(" "), /no published price/);
});

test("totals sum measured cash across tasks", () => {
  const traces = [
    turn({ id: "1", model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 100, tokensOutput: 10, costUsd: 0.001,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "t1" } }),
    turn({ id: "2", model: CODING_WORKER_MODEL, resolvedModel: WORKER, tokensInput: 100, tokensOutput: 10, costUsd: 0.002,
      requestHeaders: { [CODING_TASK_ID_HEADER]: "t2" } }),
  ];
  const evaluation = evaluateCodingEconomy(traces, { parentModel: PARENT, limit: 1 });
  assert.equal(evaluation.totals.tasks, 1);
  assert.equal(evaluation.totals.turns, 1);
  assert.ok(Math.abs(evaluation.totals.measuredApiCashUsd - 0.001) < 1e-12);
});
