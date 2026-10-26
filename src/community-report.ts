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
  context: Readonly<{ histogram: readonly number[] }>;
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
      context: Object.freeze({ histogram: Object.freeze([...accumulator.context]) }),
      contextTimeToFirstToken: Object.freeze([...accumulator.contextTtft.entries()]
        .sort(([left], [right]) => COMMUNITY_CONTEXT_BUCKETS.indexOf(left) - COMMUNITY_CONTEXT_BUCKETS.indexOf(right))
        .map(([bucket, histogram]) => Object.freeze({
          bucket,
          samples: histogram.reduce((sum, count) => sum + count, 0),
          histogram: Object.freeze([...histogram]),
        }))),
    })));
}

export function communityReportDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
