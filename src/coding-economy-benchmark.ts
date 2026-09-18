import { buildTaskLedger, groupLedgerTurns, ledgerRoleFor, type CodingTaskLedger, type CodingTaskLedgerOptions } from "./task-ledger.js";
import { estimateCostUsd } from "./model-pricing.js";
import type { TraceEntry } from "./traces.js";

export type CodingEconomyCacheState = "warm" | "cold" | "mixed" | "unknown";

export type CodingEconomyTaskEvaluation = {
  taskId: string;
  correlation: CodingTaskLedger["correlation"];
  application?: string;
  turns: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  /** Measured, priced spend for this task. */
  measuredApiCashUsd: number;
  /** Modelled cost if every priced turn had run on the parent model. */
  baselineParentCostUsd?: number;
  /** baseline - actual. Negative means delegation cost more than it saved. */
  predictedSavingUsd?: number;
  predictedSavingPercent?: number;
  /** Cache state of the delegated work, from measured cached input share. */
  cacheState: CodingEconomyCacheState;
  priceIncomplete: boolean;
  meetsMargin?: boolean;
  notes: string[];
};

export type CodingEconomyEvaluation = {
  tasks: CodingEconomyTaskEvaluation[];
  totals: {
    tasks: number;
    turns: number;
    measuredApiCashUsd: number;
    baselineParentCostUsd?: number;
    predictedSavingUsd?: number;
    uneconomicTasks: number;
    priceIncompleteTasks: number;
  };
  marginPercent: number;
  parentModel?: string;
};

export type CodingEconomyBenchmarkOptions = CodingTaskLedgerOptions & {
  /** Predicted saving required for a task to count as economic. Defaults to 20. */
  marginPercent?: number;
  limit?: number;
};

/**
 * Cache state of the delegated work. Worker turns are measured on their own
 * because the worker's cold prompt is the case that loses money; when a task has
 * no worker turn the whole task is measured instead.
 */
function cacheState(turns: readonly TraceEntry[], parentModel?: string, fallback?: CodingTaskLedger): CodingEconomyCacheState {
  const workerTurns = turns.filter((entry) => ledgerRoleFor(entry, parentModel) === "worker");
  const measured = workerTurns.length ? workerTurns : turns;
  let cached = 0;
  let uncached = 0;
  if (measured.length) {
    for (const entry of measured) {
      const cachedInput = Math.max(0, entry.tokensInputCached ?? 0);
      const write = Math.max(0, entry.tokensInputCacheWrite ?? 0);
      cached += cachedInput;
      uncached += Math.max(0, (entry.tokensInput ?? 0) - cachedInput - write);
    }
  } else if (fallback) {
    cached = fallback.cacheWarmth.cachedInputTokens;
    uncached = fallback.cacheWarmth.uncachedInputTokens;
  }
  const total = cached + uncached;
  if (total <= 0) return "unknown";
  const share = cached / total;
  if (share >= 0.5) return "warm";
  if (share < 0.05) return "cold";
  return "mixed";
}

/**
 * Evaluates complete tasks rather than single responses: it compares the
 * measured spend of a delegated task against the modelled cost of running the
 * same measured tokens on the parent model. Cold and warm cache states are
 * reported separately because a cold worker is the case that usually loses
 * money. Nothing here is a measured saving.
 */
export function evaluateCodingEconomy(
  traces: readonly TraceEntry[],
  options: CodingEconomyBenchmarkOptions = {},
): CodingEconomyEvaluation {
  const marginPercent = Math.max(0, options.marginPercent ?? 20);
  const ledger = buildTaskLedger(traces, options);
  const turnsByTask = groupLedgerTurns(traces, options);
  const tasks: CodingEconomyTaskEvaluation[] = ledger.map((task) => {
    const notes: string[] = [];
    const priced = (turnsByTask.get(task.taskId) ?? []).filter(
      (entry) => entry.usageStatus === "measured" && typeof entry.costUsd === "number",
    );
    let baseline: number | undefined = options.parentModel ? 0 : undefined;
    if (baseline !== undefined) {
      for (const entry of priced) {
        const pricedAtParent = estimateCostUsd(
          options.parentModel,
          Math.max(0, entry.tokensInput ?? 0),
          Math.max(0, entry.tokensOutput ?? 0),
          Math.max(0, entry.tokensInputCached ?? 0),
          Math.max(0, entry.tokensInputCacheWrite ?? 0),
        );
        if (pricedAtParent === undefined) {
          baseline = undefined;
          notes.push(`No published price for ${options.parentModel}; the comparison is unknown, not zero.`);
          break;
        }
        baseline += pricedAtParent;
      }
    }
    const saving = baseline === undefined ? undefined : baseline - task.measuredApiCashUsd;
    const savingPercent =
      baseline === undefined || baseline <= 0 ? undefined : (saving! / baseline) * 100;
    const state = cacheState(turnsByTask.get(task.taskId) ?? [], options.parentModel, task);
    if (task.priceIncomplete) notes.push("At least one measured turn has no published price; totals are incomplete.");
    if (saving !== undefined && saving < 0) notes.push("Delegation cost more than the modelled parent baseline for this task.");
    if (state === "cold") notes.push("Cold worker context: repricing the same tokens understates the real worker cost, because a cold worker must prefill its own context. Compare against the measured parent turns before trusting this saving.");
    if (state === "unknown") notes.push("Cache usage was not reported, so the warm/cold split is unknown.");
    const evaluated: CodingEconomyTaskEvaluation = {
      taskId: task.taskId,
      correlation: task.correlation,
      application: task.application,
      turns: task.turns,
      cachedInputTokens: task.cacheWarmth.cachedInputTokens,
      uncachedInputTokens: task.cacheWarmth.uncachedInputTokens,
      measuredApiCashUsd: task.measuredApiCashUsd,
      ...(baseline === undefined ? {} : { baselineParentCostUsd: baseline }),
      ...(saving === undefined ? {} : { predictedSavingUsd: saving }),
      ...(savingPercent === undefined ? {} : { predictedSavingPercent: savingPercent }),
      cacheState: state,
      priceIncomplete: task.priceIncomplete,
      ...(savingPercent === undefined ? {} : { meetsMargin: savingPercent >= marginPercent }),
      notes,
    };
    return evaluated;
  });

  const evaluatedTasks = typeof options.limit === "number" ? tasks.slice(0, Math.max(0, options.limit)) : tasks;
  const withBaseline = evaluatedTasks.filter((task) => task.baselineParentCostUsd !== undefined);
  return {
    tasks: evaluatedTasks,
    totals: {
      tasks: evaluatedTasks.length,
      turns: evaluatedTasks.reduce((sum, task) => sum + task.turns, 0),
      measuredApiCashUsd: evaluatedTasks.reduce((sum, task) => sum + task.measuredApiCashUsd, 0),
      ...(withBaseline.length === evaluatedTasks.length && evaluatedTasks.length > 0
        ? {
            baselineParentCostUsd: withBaseline.reduce((sum, task) => sum + task.baselineParentCostUsd!, 0),
            predictedSavingUsd: withBaseline.reduce((sum, task) => sum + task.predictedSavingUsd!, 0),
          }
        : {}),
      uneconomicTasks: evaluatedTasks.filter((task) => task.meetsMargin === false).length,
      priceIncompleteTasks: evaluatedTasks.filter((task) => task.priceIncomplete).length,
    },
    marginPercent,
    parentModel: options.parentModel,
  };
}
