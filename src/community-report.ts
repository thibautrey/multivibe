import { createHash } from "node:crypto";
import type { TraceEntry } from "./traces.js";

/**
 * Opt-in community report (schema v2). It aggregates only what this
 * installation already measured locally, reduces the machine to a bounded
 * descriptor and never includes prompts, outputs, projects, accounts, host
 * names, serial numbers or any installation identifier. Volumes, latency and
 * hardware class are self-reported and unverifiable by design.
 */

export const COMMUNITY_REPORT_SCHEMA_VERSION = 2 as const;
export const COMMUNITY_REPORT_MODEL_LIMIT = 50;
export const COMMUNITY_REPORT_SYNTHETIC_LIMIT = 10;
export const COMMUNITY_LATENCY_BOUNDS_VERSION = "community-histogram-v1" as const;

export const COMMUNITY_LATENCY_UPPER_BOUNDS: readonly number[] = Object.freeze([
  25, 50, 100, 200, 350, 500, 750, 1_000, 1_500, 2_500, 5_000, 10_000, 20_000, 30_000, 60_000,
]);
export const COMMUNITY_SPEED_UPPER_BOUNDS: readonly number[] = Object.freeze([1, 5, 10, 20, 40, 80, 160]);
export const COMMUNITY_CONTEXT_BUCKETS = Object.freeze([
  "lt1k", "1k-8k", "8k-32k", "32k-64k", "64k-128k", "128k-plus",
] as const);
export type CommunityContextBucket = (typeof COMMUNITY_CONTEXT_BUCKETS)[number];

export type CommunityReportScope = "local" | "personal-cluster";

export type CommunityReportMetric = Readonly<{ samples: number; histogram: readonly number[] }>;

export type CommunityReportModelEntry = Readonly<{
  modelId: string;
  scope: CommunityReportScope;
  requests: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  timeToFirstToken: CommunityReportMetric;
  latency: CommunityReportMetric;
  outputTokensPerSecond: CommunityReportMetric;
  contextHistogram: readonly number[];
  contextTimeToFirstToken: readonly Readonly<{ bucket: CommunityContextBucket; samples: number; histogram: readonly number[] }>[];
}>;

export type CommunityReportSyntheticEntry = Readonly<{
  modelId: string;
  runtimeFamily: string;
  samples: number;
  ttftP50Ms: number;
  ttftP95Ms: number;
  prefillP50Ms: number;
  outputTokensPerSecond: number;
  peakMemoryBytes: number;
  completedAt: string;
  resultDigest: string;
}>;

/** Structural subset of TraceEntry used for aggregation. */
export type CommunityReportTrace = Pick<TraceEntry,
  "lifecycleState" | "isError" | "provider" | "model" | "requestedModel" | "resolvedModel"
  | "executionLocation" | "latencyMs" | "ttftMs"
  | "tokensInput" | "tokensOutput" | "tokensInputCached" | "tokensReasoning">;

export function histogramIndex(bounds: readonly number[], value: number): number {
  for (let index = 0; index < bounds.length; index += 1) {
    if (value <= (bounds[index] as number)) return index;
  }
  return bounds.length;
}

export function contextBucketFor(tokensInput: number | undefined): CommunityContextBucket | undefined {
  if (typeof tokensInput !== "number" || !Number.isFinite(tokensInput) || tokensInput < 0) return undefined;
  if (tokensInput < 1_000) return "lt1k";
  if (tokensInput < 8_000) return "1k-8k";
  if (tokensInput < 32_000) return "8k-32k";
  if (tokensInput < 64_000) return "32k-64k";
  if (tokensInput < 128_000) return "64k-128k";
  return "128k-plus";
}

function emptyHistogram(length: number): number[] {
  return new Array<number>(length).fill(0);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type Accumulator = {
  modelId: string;
  scope: CommunityReportScope;
  requests: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  ttft: number[];
  ttftSamples: number;
  latency: number[];
  latencySamples: number;
  speed: number[];
  speedSamples: number;
  context: number[];
  contextTtft: Map<CommunityContextBucket, number[]>;
};

/**
 * Aggregates one completed UTC day of local traces. Cloud-routed traffic is
 * excluded because the gateway already measures it, and traces without a
 * local execution location cannot be attributed to this machine.
 */
export function buildCommunityReportModels(
  traces: readonly CommunityReportTrace[],
  allowlist: Readonly<Record<string, string>>,
  limit = COMMUNITY_REPORT_MODEL_LIMIT,
): readonly CommunityReportModelEntry[] {
  const accumulators = new Map<string, Accumulator>();
  for (const trace of traces) {
    if (trace.lifecycleState !== "completed") continue;
    const scope = trace.executionLocation;
    if (scope !== "local" && scope !== "personal-cluster") continue;
    const publicModelId = trace.requestedModel ?? trace.resolvedModel ?? trace.model;
    if (!publicModelId) continue;
    const canonicalModelId = allowlist[publicModelId];
    if (!canonicalModelId) continue;
    const key = `${canonicalModelId}\u0000${scope}`;
    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = {
        modelId: canonicalModelId,
        scope,
        requests: 0,
        succeeded: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        ttft: emptyHistogram(COMMUNITY_LATENCY_UPPER_BOUNDS.length + 1),
        ttftSamples: 0,
        latency: emptyHistogram(COMMUNITY_LATENCY_UPPER_BOUNDS.length + 1),
        latencySamples: 0,
        speed: emptyHistogram(COMMUNITY_SPEED_UPPER_BOUNDS.length + 1),
        speedSamples: 0,
        context: emptyHistogram(COMMUNITY_CONTEXT_BUCKETS.length),
        contextTtft: new Map(),
      };
      accumulators.set(key, accumulator);
    }
    accumulator.requests += 1;
    if (trace.isError) accumulator.failed += 1;
    else accumulator.succeeded += 1;
    if (finite(trace.tokensInput)) accumulator.inputTokens += Math.floor(trace.tokensInput);
    if (finite(trace.tokensOutput)) accumulator.outputTokens += Math.floor(trace.tokensOutput);
    if (finite(trace.tokensInputCached)) accumulator.cachedInputTokens += Math.floor(trace.tokensInputCached);
    if (finite(trace.tokensReasoning)) accumulator.reasoningTokens += Math.floor(trace.tokensReasoning);
    const ttft = finite(trace.ttftMs) ? trace.ttftMs : undefined;
    const latency = finite(trace.latencyMs) ? trace.latencyMs : undefined;
    if (latency !== undefined) {
      accumulator.latency[histogramIndex(COMMUNITY_LATENCY_UPPER_BOUNDS, latency)]! += 1;
      accumulator.latencySamples += 1;
    }
    if (ttft !== undefined) {
      accumulator.ttft[histogramIndex(COMMUNITY_LATENCY_UPPER_BOUNDS, ttft)]! += 1;
      accumulator.ttftSamples += 1;
    }
    const generationMs = latency !== undefined && ttft !== undefined ? latency - ttft : latency;
    if (generationMs !== undefined && generationMs > 0 && finite(trace.tokensOutput)) {
      const tokensPerSecond = Math.min(1_000_000, (trace.tokensOutput / generationMs) * 1_000);
      accumulator.speed[histogramIndex(COMMUNITY_SPEED_UPPER_BOUNDS, tokensPerSecond)]! += 1;
      accumulator.speedSamples += 1;
    }
    const bucket = contextBucketFor(trace.tokensInput);
    if (bucket) {
      accumulator.context[COMMUNITY_CONTEXT_BUCKETS.indexOf(bucket)]! += 1;
      if (ttft !== undefined) {
        const bucketHistogram = accumulator.contextTtft.get(bucket) ?? emptyHistogram(COMMUNITY_LATENCY_UPPER_BOUNDS.length + 1);
        bucketHistogram[histogramIndex(COMMUNITY_LATENCY_UPPER_BOUNDS, ttft)]! += 1;
        accumulator.contextTtft.set(bucket, bucketHistogram);
      }
    }
  }
  return Object.freeze([...accumulators.values()]
    .sort((left, right) => right.outputTokens - left.outputTokens
      || right.requests - left.requests
      || left.modelId.localeCompare(right.modelId)
      || left.scope.localeCompare(right.scope))
    .slice(0, limit)
    .map((accumulator) => Object.freeze({
      modelId: accumulator.modelId,
      scope: accumulator.scope,
      requests: accumulator.requests,
      succeeded: accumulator.succeeded,
      failed: accumulator.failed,
      inputTokens: accumulator.inputTokens,
      outputTokens: accumulator.outputTokens,
      cachedInputTokens: accumulator.cachedInputTokens,
      reasoningTokens: accumulator.reasoningTokens,
      timeToFirstToken: Object.freeze({ samples: accumulator.ttftSamples, histogram: Object.freeze([...accumulator.ttft]) }),
      latency: Object.freeze({ samples: accumulator.latencySamples, histogram: Object.freeze([...accumulator.latency]) }),
      outputTokensPerSecond: Object.freeze({ samples: accumulator.speedSamples, histogram: Object.freeze([...accumulator.speed]) }),
      contextHistogram: Object.freeze([...accumulator.context]),
      contextTimeToFirstToken: Object.freeze([...accumulator.contextTtft.entries()]
        .sort(([left], [right]) => COMMUNITY_CONTEXT_BUCKETS.indexOf(left) - COMMUNITY_CONTEXT_BUCKETS.indexOf(right))
        .map(([bucket, histogram]) => Object.freeze({
          bucket,
          samples: histogram.reduce((sum, count) => sum + count, 0),
          histogram: Object.freeze([...histogram]),
        }))),
    })));
}

const RUNTIME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/u;

export function runtimeFamilyFromRuntimeId(runtimeId: string): string {
  const normalized = String(runtimeId ?? "").trim().toLowerCase()
    .replace(/-adapter-v\d+/u, "")
    .replace(/-managed$/u, "")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return RUNTIME_ID_PATTERN.test(normalized) ? normalized : "unknown-runtime";
}

type BenchmarkDistribution = { samples?: unknown; p50?: unknown; p95?: unknown };

function distributionValue(value: unknown): { samples: number; p50: number; p95: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as BenchmarkDistribution;
  if (!finite(row.p50) || !finite(row.p95) || !finite(row.samples)) return undefined;
  return { samples: Math.floor(row.samples), p50: row.p50, p95: row.p95 };
}

/**
 * Reads new synthetic runtime benchmark results from the bounded local store
 * written by the provider-agent runtime-benchmark command. Results are keyed by
 * their own digest so a re-read never resends the same measurement.
 */
export function readSyntheticBenchmarkResults(
  document: unknown,
  allowlist: Readonly<Record<string, string>>,
  alreadySent: ReadonlySet<string>,
  limit = COMMUNITY_REPORT_SYNTHETIC_LIMIT,
): readonly CommunityReportSyntheticEntry[] {
  const store = document as { schema_version?: unknown; results?: unknown } | null;
  if (!store || typeof store !== "object" || store.schema_version !== "provider-runtime-benchmark-store-v1") return Object.freeze([]);
  if (!Array.isArray(store.results)) return Object.freeze([]);
  const entries: CommunityReportSyntheticEntry[] = [];
  for (const raw of (store.results as unknown[]).slice(0, 256)) {
    if (!raw || typeof raw !== "object") continue;
    const result = raw as Record<string, unknown>;
    const digest = typeof result.result_digest === "string" ? result.result_digest : "";
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest) || alreadySent.has(digest)) continue;
    if (result.passed !== true) continue;
    const modelId = typeof result.model_id === "string" ? allowlist[result.model_id] : undefined;
    if (!modelId) continue;
    const ttft = distributionValue(result.time_to_first_token_milliseconds);
    const prefill = distributionValue(result.prefill_milliseconds);
    const speed = distributionValue(result.tokens_per_second_milli);
    const successfulRuns = finite(result.successful_runs) ? Math.floor(result.successful_runs) : 0;
    const completedAt = typeof result.completed_at === "string" && Number.isFinite(Date.parse(result.completed_at))
      ? new Date(result.completed_at).toISOString()
      : undefined;
    if (!ttft || !completedAt || successfulRuns < 1) continue;
    const memory = result.memory && typeof result.memory === "object"
      ? (result.memory as { sampled_peak_bytes?: unknown }).sampled_peak_bytes
      : undefined;
    const peakMemoryBytes = distributionValue(memory)?.p50 ?? 0;
    entries.push(Object.freeze({
      modelId,
      runtimeFamily: runtimeFamilyFromRuntimeId(typeof result.runtime_id === "string" ? result.runtime_id : "unknown"),
      samples: Math.min(50, Math.max(1, successfulRuns)),
      ttftP50Ms: Math.round(ttft.p50),
      ttftP95Ms: Math.round(Math.max(ttft.p95, ttft.p50)),
      prefillP50Ms: Math.round(prefill?.p50 ?? 0),
      outputTokensPerSecond: Math.max(0, (speed?.p50 ?? 0) / 1_000),
      peakMemoryBytes: Math.round(peakMemoryBytes),
      completedAt,
      resultDigest: digest,
    }));
    if (entries.length >= limit) break;
  }
  return Object.freeze(entries);
}

export function communityReportDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
