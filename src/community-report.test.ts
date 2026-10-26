import assert from "node:assert/strict";
import test from "node:test";
import { assertCommunityReportPayload } from "./community-report-sharing.js";
import {
  COMMUNITY_CONTEXT_BUCKETS,
  COMMUNITY_LATENCY_UPPER_BOUNDS,
  COMMUNITY_REPORT_MODEL_LIMIT,
  COMMUNITY_SPEED_UPPER_BOUNDS,
  buildCommunityReportModels,
  contextBucketFor,
  type CommunityReportTrace,
} from "./community-report.js";

const allowlist = Object.freeze({ "public/model": "hf:public/model", "hf:public/model": "hf:public/model" });

function trace(overrides: Partial<CommunityReportTrace> = {}): CommunityReportTrace {
  return {
    lifecycleState: "completed",
    isError: false,
    provider: "openai-compatible",
    model: "public/model",
    requestedModel: "public/model",
    executionLocation: "local",
    latencyMs: 1_000,
    ttftMs: 100,
    tokensInput: 4_000,
    tokensOutput: 200,
    tokensInputCached: 0,
    tokensReasoning: 0,
    ...overrides,
  };
}

test("community report aggregates only locally executed completed traffic with known canonical models", () => {
  const models = buildCommunityReportModels([
    trace(),
    trace({ isError: true }),
    trace({ executionLocation: "cloud" }),
    trace({ executionLocation: undefined }),
    trace({ lifecycleState: "started" }),
    trace({ model: "public/unknown", requestedModel: "public/unknown", resolvedModel: undefined }),
  ], allowlist);
  assert.equal(models.length, 1);
  const entry = models[0]!;
  assert.equal(entry.modelId, "hf:public/model");
  assert.equal(entry.scope, "local");
  assert.equal(entry.requests, 2);
  assert.equal(entry.succeeded, 1);
  assert.equal(entry.failed, 1);
  assert.equal(entry.inputTokens, 8_000);
  assert.equal(entry.outputTokens, 400);
  assert.equal(entry.timeToFirstToken.samples, 2);
  assert.equal(entry.latency.samples, 2);
  assert.equal(entry.context.histogram.reduce((sum, count) => sum + count, 0), 2);
  assert.equal(entry.timeToFirstToken.histogram.length, COMMUNITY_LATENCY_UPPER_BOUNDS.length + 1);
  assert.equal(entry.outputTokensPerSecond.histogram.length, COMMUNITY_SPEED_UPPER_BOUNDS.length + 1);
  assert.equal(entry.outputTokensPerSecond.samples, 2);
  assert.deepEqual(entry.contextTimeToFirstToken.map((bucket) => bucket.bucket), ["1k-8k"]);
  assert.equal(entry.contextTimeToFirstToken[0]?.samples, 2);
});

test("community report separates execution scope and caps the published model list", () => {
  const traces: CommunityReportTrace[] = [];
  for (let index = 0; index < COMMUNITY_REPORT_MODEL_LIMIT + 12; index += 1) {
    traces.push(trace({ requestedModel: `public/model-${index}`, model: `public/model-${index}`, tokensOutput: index + 1 }));
  }
  const aliases = Object.fromEntries(traces.map((_, index) => [`public/model-${index}`, `hf:public/model-${index}`]));
  const models = buildCommunityReportModels(traces, aliases);
  assert.equal(models.length, COMMUNITY_REPORT_MODEL_LIMIT);
  assert.equal(models[0]?.modelId, `hf:public/model-${COMMUNITY_REPORT_MODEL_LIMIT + 11}`);
  const shared = buildCommunityReportModels([trace({ executionLocation: "personal-cluster" })], allowlist);
  assert.equal(shared[0]?.scope, "personal-cluster");
});

test("context buckets follow the published boundaries", () => {
  assert.equal(contextBucketFor(999), "lt1k");
  assert.equal(contextBucketFor(1_000), "1k-8k");
  assert.equal(contextBucketFor(8_000), "8k-32k");
  assert.equal(contextBucketFor(32_000), "32k-64k");
  assert.equal(contextBucketFor(64_000), "64k-128k");
  assert.equal(contextBucketFor(128_000), "128k-plus");
  assert.equal(contextBucketFor(Number.NaN), undefined);
  assert.equal(contextBucketFor(undefined), undefined);
  assert.equal(COMMUNITY_CONTEXT_BUCKETS.length, 6);
});

test("the outbound payload keeps the exact wire shape Cloud validates", () => {
  const models = buildCommunityReportModels([trace()], allowlist);
  const digest = `sha256:${"d".repeat(64)}`;
  // Pending reports from an older installation still use this Cloud wire contract.
  const syntheticBenchmarks = [{
    modelId: "hf:public/model", runtimeFamily: "legacy", samples: 3,
    ttftP50Ms: 120, ttftP95Ms: 180, prefillP50Ms: 20,
    outputTokensPerSecond: 42.5, peakMemoryBytes: 8_589_934_592,
    completedAt: "2026-09-01T21:01:25.032Z", resultDigest: digest,
  }];
  const payload = {
    schemaVersion: 2 as const,
    eventId: "6f1c0f0e-8f4a-4a1e-9f6b-1f2c3d4e5f60",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-09-02T00:00:00.000Z",
    host: {
      acceleratorKind: "cuda" as const,
      acceleratorName: "NVIDIA GeForce RTX 4090",
      acceleratorMemoryBytes: 24 * 1024 ** 3,
      hostMemoryBytes: 64 * 1024 ** 3,
      os: "linux" as const,
      architecture: "amd64" as const,
      machineModel: "",
    },
    models,
    syntheticBenchmarks,
  };
  assert.doesNotThrow(() => assertCommunityReportPayload(payload));
  const model = models[0]!;
  const synthetic = syntheticBenchmarks[0]!;
  // These lists mirror Cloud's validateCommunityReport/validateModelEntry exactly.
  assert.deepEqual(Object.keys(payload).sort(), ["eventId", "host", "models", "periodEnd", "periodStart", "schemaVersion", "syntheticBenchmarks"]);
  assert.deepEqual(Object.keys(payload.host).sort(), ["acceleratorKind", "acceleratorMemoryBytes", "acceleratorName", "architecture", "hostMemoryBytes", "machineModel", "os"]);
  assert.deepEqual(Object.keys(model).sort(), [
    "cachedInputTokens", "context", "contextTimeToFirstToken", "failed", "inputTokens", "latency",
    "modelId", "outputTokens", "outputTokensPerSecond", "reasoningTokens", "requests", "scope",
    "succeeded", "timeToFirstToken",
  ]);
  assert.deepEqual(Object.keys(model.context).sort(), ["histogram"]);
  assert.deepEqual(Object.keys(model.timeToFirstToken).sort(), ["histogram", "samples"]);
  assert.deepEqual(Object.keys(model.latency).sort(), ["histogram", "samples"]);
  assert.deepEqual(Object.keys(model.outputTokensPerSecond).sort(), ["histogram", "samples"]);
  assert.deepEqual(Object.keys(model.contextTimeToFirstToken[0]!).sort(), ["bucket", "histogram", "samples"]);
  assert.deepEqual(Object.keys(synthetic).sort(), [
    "completedAt", "modelId", "outputTokensPerSecond", "peakMemoryBytes", "prefillP50Ms",
    "resultDigest", "runtimeFamily", "samples", "ttftP50Ms", "ttftP95Ms",
  ]);
});
