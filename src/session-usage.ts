import { estimateCostUsd } from "./model-pricing.js";
import { sessionKeyOf } from "./session-identity.js";
import { ttftInputTokenBucket } from "./traces.js";
import type { TtftInputTokenBucket } from "./traces.js";
import type { TraceEntry } from "./traces.js";
import type { ProviderId } from "./types.js";

export type SessionTurnUsage = {
  at: number;
  lastAt: number;
  clientRequestId: string;
  application?: string;
  projectId?: string;
  projectName?: string;
  provider?: ProviderId;
  model?: string;
  status: number;
  isError: boolean;
  upstreamAttempts: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  ttftMs?: number;
  latencyMs: number;
  costUsd: number;
  costUsdWithoutCache: number;
};

export type SessionUsage = {
  sessionKey: string;
  application?: string;
  projectId?: string;
  projectName?: string;
  provider?: ProviderId;
  models: string[];
  turns: number;
  firstAt: number;
  lastAt: number;
  durationMs: number;
  initialInputTokens?: number;
  initialInputTokenBucket: TtftInputTokenBucket;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  medianInputTokens?: number;
  maxInputTokens?: number;
  medianOutputTokens?: number;
  cachedInputRatio?: number;
  cacheHitTurns: number;
  cacheMissTurns: number;
  cacheWriteTurns: number;
  contextGrowthTokens?: number;
  medianTurnGrowthTokens?: number;
  errorTurns: number;
  costUsd: number;
  costUsdWithoutCache: number;
  cacheSavingsUsd: number;
};

export type SessionUsageSummary = {
  sessions: number;
  turns: number;
  attempts: number;
  totalAttempts: number;
  coverage: number;
  initialInputTokensMedian?: number;
  initialInputTokenBuckets: Record<TtftInputTokenBucket, number>;
  turnsPerSessionMedian: number;
  cachedInputRatio?: number;
  cacheHitTurns: number;
  cacheHitRatio: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
};

export type SessionUsageReport = {
  summary: SessionUsageSummary;
  sessions: SessionUsage[];
};

type MutableTurn = {
  at: number;
  lastAt: number;
  lastMeasuredAt: number;
  clientRequestId: string;
  application?: string;
  projectId?: string;
  projectName?: string;
  provider?: ProviderId;
  model?: string;
  status: number;
  isError: boolean;
  upstreamAttempts: number;
  hasUsage: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  ttftMs?: number;
  latencyMs: number;
  costUsd: number;
  costUsdWithoutCache: number;
};

type MutableSession = {
  sessionKey: string;
  application?: string;
  projectId?: string;
  projectName?: string;
  turns: Map<string, MutableTurn>;
};

function isUpstreamAttemptTrace(trace: TraceEntry): boolean {
  return trace.traceKind === undefined || trace.traceKind === "upstream-attempt";
}

function traceHasUsage(trace: TraceEntry): boolean {
  return (
    trace.usageStatus === "measured" ||
    Boolean(trace.usage) ||
    typeof trace.tokensInput === "number" ||
    typeof trace.tokensOutput === "number" ||
    typeof trace.tokensTotal === "number"
  );
}

function traceCostUsd(trace: TraceEntry): number {
  if (typeof trace.costUsd === "number" && Number.isFinite(trace.costUsd)) {
    return trace.costUsd;
  }
  return (
    estimateCostUsd(
      trace.model,
      trace.tokensInput ?? 0,
      trace.tokensOutput ?? 0,
      trace.tokensInputCached ?? 0,
      trace.tokensInputCacheWrite ?? 0,
    ) ?? 0
  );
}

function traceCostUsdWithoutCache(trace: TraceEntry): number {
  const cachedInput = Math.max(0, trace.tokensInputCached ?? 0);
  if (cachedInput === 0) return traceCostUsd(trace);
  if (!traceHasUsage(trace)) return 0;
  const input = Math.max(0, trace.tokensInput ?? 0);
  const cacheWrite = Math.min(
    input,
    Math.max(0, trace.tokensInputCacheWrite ?? 0),
  );
  return (
    estimateCostUsd(
      trace.model,
      input,
      trace.tokensOutput ?? 0,
      0,
      cacheWrite,
    ) ?? 0
  );
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function createTurn(trace: TraceEntry, turnKey: string): MutableTurn {
  return {
    at: trace.at,
    lastAt: trace.at,
    lastMeasuredAt: Number.NEGATIVE_INFINITY,
    clientRequestId: turnKey,
    application: trace.application,
    projectId: trace.projectId,
    projectName: trace.projectName,
    provider: trace.provider,
    model: trace.model,
    status: trace.status,
    isError: trace.isError,
    upstreamAttempts: 0,
    hasUsage: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ttftMs: undefined,
    latencyMs: 0,
    costUsd: 0,
    costUsdWithoutCache: 0,
  };
}

function addTraceToTurn(turn: MutableTurn, trace: TraceEntry) {
  turn.at = Math.min(turn.at, trace.at);
  turn.upstreamAttempts += 1;
  if (trace.at >= turn.lastAt) {
    turn.lastAt = trace.at;
    turn.provider = trace.provider ?? turn.provider;
    turn.model = trace.model ?? turn.model;
    turn.status = trace.status;
    turn.isError = trace.isError;
    turn.latencyMs = Number.isFinite(trace.latencyMs) ? trace.latencyMs : 0;
    turn.ttftMs = trace.ttftMs ?? turn.ttftMs;
    turn.projectId = trace.projectId ?? turn.projectId;
    turn.projectName = trace.projectName ?? turn.projectName;
  }
  if (traceHasUsage(trace) && trace.at >= turn.lastMeasuredAt) {
    turn.lastMeasuredAt = trace.at;
    turn.hasUsage = true;
    const input = Math.max(0, trace.tokensInput ?? 0);
    turn.inputTokens = input;
    turn.cachedInputTokens = Math.max(0, trace.tokensInputCached ?? 0);
    turn.cacheWriteTokens = Math.max(0, trace.tokensInputCacheWrite ?? 0);
    turn.outputTokens = Math.max(0, trace.tokensOutput ?? 0);
    turn.totalTokens =
      trace.tokensTotal ?? turn.inputTokens + turn.outputTokens;
  }
  turn.costUsd += traceCostUsd(trace);
  turn.costUsdWithoutCache += traceCostUsdWithoutCache(trace);
}

function finalizeTurn(turn: MutableTurn): SessionTurnUsage {
  return {
    at: turn.at,
    lastAt: turn.lastAt,
    clientRequestId: turn.clientRequestId,
    application: turn.application,
    projectId: turn.projectId,
    projectName: turn.projectName,
    provider: turn.provider,
    model: turn.model,
    status: turn.status,
    isError: turn.isError,
    upstreamAttempts: turn.upstreamAttempts,
    inputTokens: turn.inputTokens,
    cachedInputTokens: turn.cachedInputTokens,
    cacheWriteTokens: turn.cacheWriteTokens,
    outputTokens: turn.outputTokens,
    totalTokens: turn.totalTokens,
    ttftMs: turn.ttftMs,
    latencyMs: turn.latencyMs,
    costUsd: turn.costUsd,
    costUsdWithoutCache: turn.costUsdWithoutCache,
  };
}

function collectSessions(
  traces: TraceEntry[],
): {
  sessions: MutableSession[];
  attempts: number;
  totalAttempts: number;
} {
  const sessions = new Map<string, MutableSession>();
  let attempts = 0;
  let totalAttempts = 0;
  for (const trace of traces) {
    if (!isUpstreamAttemptTrace(trace)) continue;
    totalAttempts += 1;
    const sessionKey = sessionKeyOf(trace);
    if (!sessionKey) continue;
    attempts += 1;
    const session = sessions.get(sessionKey) ?? {
      sessionKey,
      application: trace.application,
      projectId: trace.projectId,
      projectName: trace.projectName,
      turns: new Map<string, MutableTurn>(),
    };
    session.application ??= trace.application;
    session.projectId ??= trace.projectId;
    session.projectName ??= trace.projectName;
    const turnKey = trace.clientRequestId ?? trace.id;
    const turn = session.turns.get(turnKey) ?? createTurn(trace, turnKey);
    addTraceToTurn(turn, trace);
    session.turns.set(turnKey, turn);
    sessions.set(sessionKey, session);
  }
  return { sessions: Array.from(sessions.values()), attempts, totalAttempts };
}

function finalizeSession(session: MutableSession): SessionUsage {
  const turns = Array.from(session.turns.values())
    .map(finalizeTurn)
    .sort((a, b) => a.at - b.at);
  const measured = turns.filter((turn) => turn.inputTokens > 0);
  const modelCounts = new Map<string, number>();
  for (const turn of turns) {
    if (!turn.model) continue;
    modelCounts.set(turn.model, (modelCounts.get(turn.model) ?? 0) + 1);
  }
  const models = Array.from(modelCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model]) => model);

  const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
  const cachedInputTokens = turns.reduce(
    (sum, turn) => sum + turn.cachedInputTokens,
    0,
  );
  const cacheWriteTokens = turns.reduce(
    (sum, turn) => sum + turn.cacheWriteTokens,
    0,
  );
  const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
  const totalTokens = turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
  const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
  const costUsdWithoutCache = turns.reduce(
    (sum, turn) => sum + turn.costUsdWithoutCache,
    0,
  );
  const initialTurn = measured[0];
  const lastTurn = measured[measured.length - 1];
  const initialInputTokens = initialTurn?.inputTokens;
  const growthSamples = measured
    .slice(1)
    .map((turn, index) => turn.inputTokens - measured[index].inputTokens);
  const firstAt = turns[0]?.at ?? 0;
  const lastAt = turns[turns.length - 1]?.lastAt ?? firstAt;

  return {
    sessionKey: session.sessionKey,
    application: session.application,
    projectId: session.projectId,
    projectName: session.projectName,
    provider: turns[turns.length - 1]?.provider,
    models,
    turns: turns.length,
    firstAt,
    lastAt,
    durationMs: Math.max(0, lastAt - firstAt),
    initialInputTokens,
    initialInputTokenBucket: ttftInputTokenBucket(initialInputTokens),
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens,
    medianInputTokens: median(measured.map((turn) => turn.inputTokens)),
    maxInputTokens: measured.length
      ? Math.max(...measured.map((turn) => turn.inputTokens))
      : undefined,
    medianOutputTokens: median(
      turns.filter((turn) => turn.inputTokens > 0).map((turn) => turn.outputTokens),
    ),
    cachedInputRatio:
      inputTokens > 0
        ? Math.max(0, Math.min(1, cachedInputTokens / inputTokens))
        : undefined,
    cacheHitTurns: turns.filter((turn) => turn.cachedInputTokens > 0).length,
    cacheMissTurns: turns.filter(
      (turn) => turn.inputTokens > 0 && turn.cachedInputTokens === 0,
    ).length,
    cacheWriteTurns: turns.filter((turn) => turn.cacheWriteTokens > 0).length,
    contextGrowthTokens:
      initialTurn && lastTurn
        ? lastTurn.inputTokens - initialTurn.inputTokens
        : undefined,
    medianTurnGrowthTokens: median(growthSamples),
    errorTurns: turns.filter((turn) => turn.isError).length,
    costUsd,
    costUsdWithoutCache,
    cacheSavingsUsd: Math.max(0, costUsdWithoutCache - costUsd),
  };
}

export function aggregateSessionUsage(traces: TraceEntry[]): SessionUsageReport {
  const { sessions: mutableSessions, attempts, totalAttempts } = collectSessions(traces);
  const sessions = mutableSessions
    .map(finalizeSession)
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.turns - a.turns ||
        b.lastAt - a.lastAt ||
        a.sessionKey.localeCompare(b.sessionKey),
    );
  const turns = sessions.reduce((sum, session) => sum + session.turns, 0);
  const cachedInputTokens = sessions.reduce(
    (sum, session) => sum + session.cachedInputTokens,
    0,
  );
  const inputTokens = sessions.reduce(
    (sum, session) => sum + session.inputTokens,
    0,
  );
  const cacheHitTurns = sessions.reduce(
    (sum, session) => sum + session.cacheHitTurns,
    0,
  );
  const cacheWriteTokens = sessions.reduce(
    (sum, session) => sum + session.cacheWriteTokens,
    0,
  );
  const costUsd = sessions.reduce((sum, session) => sum + session.costUsd, 0);
  const cacheSavingsUsd = sessions.reduce(
    (sum, session) => sum + session.cacheSavingsUsd,
    0,
  );
  const outputTokens = sessions.reduce(
    (sum, session) => sum + session.outputTokens,
    0,
  );
  const initialInputTokenBuckets = sessions.reduce(
    (buckets, session) => {
      buckets[session.initialInputTokenBucket] += 1;
      return buckets;
    },
    {
      lt1k: 0,
      "1k-8k": 0,
      "8k-32k": 0,
      "32k-64k": 0,
      "64k-128k": 0,
      "128k-plus": 0,
      unknown: 0,
    } satisfies Record<TtftInputTokenBucket, number>,
  );

  return {
    summary: {
      sessions: sessions.length,
      turns,
      attempts,
      totalAttempts,
      coverage: totalAttempts > 0 ? attempts / totalAttempts : 0,
      initialInputTokensMedian: median(
        sessions
          .map((session) => session.initialInputTokens)
          .filter((value): value is number => typeof value === "number"),
      ),
      initialInputTokenBuckets,
      turnsPerSessionMedian: median(sessions.map((session) => session.turns)) ?? 0,
      cachedInputRatio:
        inputTokens > 0
          ? Math.max(0, Math.min(1, cachedInputTokens / inputTokens))
          : undefined,
      cacheHitTurns,
      cacheHitRatio: turns > 0 ? cacheHitTurns / turns : 0,
      inputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      outputTokens,
      costUsd,
      cacheSavingsUsd,
    },
    sessions,
  };
}

export function sessionTurnsFor(
  traces: TraceEntry[],
  sessionKey: string,
): SessionTurnUsage[] {
  const { sessions } = collectSessions(traces);
  const session = sessions.find((entry) => entry.sessionKey === sessionKey);
  if (!session) return [];
  return Array.from(session.turns.values())
    .map(finalizeTurn)
    .sort((a, b) => a.at - b.at);
}
