import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMUNITY_CONTEXT_BUCKETS,
  COMMUNITY_LATENCY_UPPER_BOUNDS,
  COMMUNITY_REPORT_MODEL_LIMIT,
  COMMUNITY_SPEED_UPPER_BOUNDS,
  buildCommunityReportModels,
  contextBucketFor,
  readSyntheticBenchmarkResults,
  runtimeFamilyFromRuntimeId,
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
  assert.equal(entry.contextHistogram.reduce((sum, count) => sum + count, 0), 2);
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

test("synthetic benchmark results are bounded, deduplicated by digest and mapped to canonical models", () => {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  const document = {
    schema_version: "provider-runtime-benchmark-store-v1",
    results: [
      {
        result_digest: digest("a"), model_id: "hf:public/model", runtime_id: "ollama-managed",
        passed: true, successful_runs: 3, completed_at: "2026-09-01T21:01:25.032Z",
        time_to_first_token_milliseconds: { samples: 3, minimum: 100, p50: 120, p95: 180, maximum: 200 },
        prefill_milliseconds: { samples: 3, minimum: 10, p50: 20, p95: 25, maximum: 30 },
        tokens_per_second_milli: { samples: 3, minimum: 1_000, p50: 42_500, p95: 50_000, maximum: 52_000 },
        memory: { sampled_peak_bytes: { samples: 3, minimum: 1, p50: 8_589_934_592, p95: 8_600_000_000, maximum: 8_700_000_000 } },
      },
      { result_digest: digest("b"), model_id: "hf:public/model", runtime_id: "ollama-managed", passed: false, successful_runs: 0, completed_at: "2026-09-01T21:01:25.032Z" },
      { result_digest: digest("c"), model_id: "hf:not-in-allowlist", runtime_id: "ollama-managed", passed: true, successful_runs: 3, completed_at: "2026-09-01T21:01:25.032Z",
        time_to_first_token_milliseconds: { samples: 3, minimum: 1, p50: 1, p95: 2, maximum: 3 } },
    ],
  };
  const entries = readSyntheticBenchmarkResults(document, allowlist, new Set());
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.modelId, "hf:public/model");
  assert.equal(entries[0]?.runtimeFamily, "ollama");
  assert.equal(entries[0]?.ttftP50Ms, 120);
  assert.equal(entries[0]?.outputTokensPerSecond, 42.5);
  assert.equal(entries[0]?.peakMemoryBytes, 8_589_934_592);
  assert.equal(readSyntheticBenchmarkResults(document, allowlist, new Set([digest("a")])).length, 0);
  assert.equal(readSyntheticBenchmarkResults({ schema_version: "other" }, allowlist, new Set()).length, 0);
  assert.equal(runtimeFamilyFromRuntimeId("llama-cpp-adapter-v1"), "llama-cpp");
  assert.equal(runtimeFamilyFromRuntimeId("vLLM"), "vllm");
});
