import { codingRoleForRequestedModel, type CodingAgentRole } from "./coding-economy-model.js";
import { estimateCostUsd, MODEL_PRICING_VERSION } from "./model-pricing.js";
import { isInferenceTraceRoute, type TraceEntry } from "./traces.js";

/** Explicit task id header honored when request-header tracing is enabled. */
export const CODING_TASK_ID_HEADER = "x-multivibe-task-id";
/** Explicit agent role header honored when request-header tracing is enabled. */
export const CODING_AGENT_ROLE_HEADER = "x-multivibe-agent-role";

export type CodingLedgerRole = CodingAgentRole | "unattributed";
export type CodingLedgerCorrelation = "explicit" | "session" | "unattributed";

/**
 * Four cost kinds are kept separate on purpose: measured API cash is what a
 * provider invoice can be reconciled against, subscription quota consumption is
 * an estimate in tokens, local compute consumes hardware rather than money, and
 * counterfactual savings are a modelled comparison. Unknown values stay
 * unknown; they are never silently reported as zero.
 */
export type CodingTaskLedger = {
  taskId: string;
  correlation: CodingLedgerCorrelation;
  application?: string;
  projectId?: string;
  projectName?: string;
  firstAt: number;
  lastAt: number;
  turns: number;
  roles: Record<CodingLedgerRole, { turns: number; tokens: number }>;
  cacheWarmth: {
    cachedInputTokens: number;
    uncachedInputTokens: number;
    cacheWriteTokens: number;
  };
  /** Cost kind 1: provider-priced spend for measured usage. */
  measuredApiCashUsd: number;
  /** True when at least one measured turn had no published price. */
  priceIncomplete: boolean;
  unpricedTurns: number;
  /** Cost kind 2: estimated subscription-quota consumption (tokens). */
  estimatedSubscriptionQuotaUnits: number;
  /** Cost kind 3: tokens served by local compute (no cash). */
  localComputeTokens: number;
  /** Cost kind 4: modelled comparison, not a measured saving. */
  counterfactualSavingsUsd?: number;
  counterfactualBasis?: string;
  pricingVersion: string;
};

export type CodingTaskLedgerOptions = {
  /** Strong model used as the counterfactual baseline. */
  parentModel?: string;
  /** Accounts billed by subscription quota rather than per-token cash. */
  subscriptionAccountIds?: ReadonlySet<string>;
  /** Accounts served by local runtimes. */
  localAccountIds?: ReadonlySet<string>;
  /** Correlation window for the unattributed bucket. Defaults to one hour. */
  attributionWindowMs?: number;
  limit?: number;
  now?: number;
};

function headerValue(entry: TraceEntry, name: string): string | undefined {
  const value = entry.requestHeaders?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolves the ledger role of one turn from explicit evidence, then the model id. */
export function ledgerRoleFor(entry: TraceEntry, parentModel?: string): CodingLedgerRole {
  const explicit = headerValue(entry, CODING_AGENT_ROLE_HEADER);
  if (explicit === "parent" || explicit === "worker") return explicit;
  const declared = codingRoleForRequestedModel(entry.model ?? entry.requestedModel);
  if (declared) return declared;
  if (parentModel && (entry.resolvedModel ?? entry.model) === parentModel) return "parent";
  return "unattributed";
}

function totalTokens(entry: TraceEntry): number {
  const input = Math.max(0, entry.tokensInput ?? 0);
  const cached = Math.max(0, entry.tokensInputCached ?? 0);
  const write = Math.max(0, entry.tokensInputCacheWrite ?? 0);
  const output = Math.max(0, entry.tokensOutput ?? 0);
  return input + cached + write + output;
}

function emptyRoles(): CodingTaskLedger["roles"] {
  return {
    parent: { turns: 0, tokens: 0 },
    worker: { turns: 0, tokens: 0 },
    unattributed: { turns: 0, tokens: 0 },
  };
}

/** Resolves the task a measured turn belongs to, and how it was correlated. */
export function ledgerTaskKey(
  entry: TraceEntry,
  options: CodingTaskLedgerOptions,
): { taskId: string; correlation: CodingLedgerCorrelation } {
  const explicit = headerValue(entry, CODING_TASK_ID_HEADER);
  if (explicit) return { taskId: explicit, correlation: "explicit" };
  if (entry.codexSessionId) return { taskId: `session:${entry.codexSessionId}`, correlation: "session" };
  const window = Math.max(60_000, options.attributionWindowMs ?? 3_600_000);
  return {
    taskId: `unattributed:${entry.application ?? "default"}:${Math.floor(entry.at / window)}`,
    correlation: "unattributed",
  };
}

/** A turn contributes to the ledger only when it is a completed inference attempt. */
export function isLedgerTurn(entry: TraceEntry): boolean {
  return (
    entry.traceKind === "upstream-attempt" &&
    isInferenceTraceRoute(entry.route) &&
    entry.status < 400
  );
}

/** Groups ledger turns by task id, preserving chronological order. */
export function groupLedgerTurns(
  traces: readonly TraceEntry[],
  options: CodingTaskLedgerOptions = {},
): Map<string, TraceEntry[]> {
  const groups = new Map<string, TraceEntry[]>();
  for (const entry of [...traces].filter(isLedgerTurn).sort((left, right) => left.at - right.at)) {
    const { taskId } = ledgerTaskKey(entry, options);
    const bucket = groups.get(taskId);
    if (bucket) bucket.push(entry);
    else groups.set(taskId, [entry]);
  }
  return groups;
}

/** Groups measured inference attempts into per-task, role-attributed records. */
export function buildTaskLedger(
  traces: readonly TraceEntry[],
  options: CodingTaskLedgerOptions = {},
): CodingTaskLedger[] {
  const tasks = new Map<string, CodingTaskLedger>();
  for (const [taskId, bucket] of groupLedgerTurns(traces, options)) {
    for (const entry of bucket) {
      const role = ledgerRoleFor(entry, options.parentModel);
      const measured = entry.usageStatus === "measured";
      const input = Math.max(0, entry.tokensInput ?? 0);
      const cached = Math.max(0, entry.tokensInputCached ?? 0);
      const write = Math.max(0, entry.tokensInputCacheWrite ?? 0);
      const output = Math.max(0, entry.tokensOutput ?? 0);
      const tokens = totalTokens(entry);
      const priced = measured && typeof entry.costUsd === "number";

      let task = tasks.get(taskId);
      if (!task) {
        task = {
          taskId,
          correlation: ledgerTaskKey(entry, options).correlation,
          application: entry.application,
          projectId: entry.projectId,
          projectName: entry.projectName,
          firstAt: entry.at,
          lastAt: entry.at,
          turns: 0,
          roles: emptyRoles(),
          cacheWarmth: { cachedInputTokens: 0, uncachedInputTokens: 0, cacheWriteTokens: 0 },
          measuredApiCashUsd: 0,
          priceIncomplete: false,
          unpricedTurns: 0,
          estimatedSubscriptionQuotaUnits: 0,
          localComputeTokens: 0,
          pricingVersion: MODEL_PRICING_VERSION,
        };
        tasks.set(taskId, task);
      }
      task.lastAt = Math.max(task.lastAt, entry.at);
      task.turns += 1;
      task.roles[role].turns += 1;
      task.roles[role].tokens += tokens;
      task.cacheWarmth.cachedInputTokens += cached;
      task.cacheWarmth.cacheWriteTokens += write;
      task.cacheWarmth.uncachedInputTokens += Math.max(0, input - cached - write);
      if (priced) task.measuredApiCashUsd += entry.costUsd!;
      else if (measured) {
        task.unpricedTurns += 1;
        task.priceIncomplete = true;
      }
      if (entry.accountId && options.subscriptionAccountIds?.has(entry.accountId)) {
        task.estimatedSubscriptionQuotaUnits += tokens;
      }
      if (
        entry.executionLocation === "local" ||
        (entry.accountId ? options.localAccountIds?.has(entry.accountId) : false)
      ) {
        task.localComputeTokens += tokens;
      }
      if (role === "worker" && measured && options.parentModel && priced) {
        const baseline = estimateCostUsd(options.parentModel, input, output, cached, write);
        if (typeof baseline === "number") {
          task.counterfactualSavingsUsd = (task.counterfactualSavingsUsd ?? 0) + (baseline - entry.costUsd!);
          task.counterfactualBasis =
            `Estimate: worker tokens repriced at ${options.parentModel}'s published rates (same token counts and cache mix). Not a measured saving.`;
        } else {
          task.counterfactualBasis = task.counterfactualBasis ??
            `Baseline model ${options.parentModel} has no published price; savings stays unknown.`;
        }
      }
    }
  }
  const values = [...tasks.values()].sort((left, right) => right.lastAt - left.lastAt);
  return typeof options.limit === "number" ? values.slice(0, Math.max(0, options.limit)) : values;
}

/** Returns one task record, or undefined when the task has no measured turns. */
export function buildTaskLedgerEntry(
  traces: readonly TraceEntry[],
  taskId: string,
  options: CodingTaskLedgerOptions = {},
): CodingTaskLedger | undefined {
  return buildTaskLedger(traces, options).find((task) => task.taskId === taskId);
}
