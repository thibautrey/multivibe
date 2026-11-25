import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateModuleAnalytics,
  analyticsTraceRoots,
  moduleAnalyticsDescriptors,
  validateModuleAnalytics,
} from "./module-analytics.js";
import { headroomPluginManifest } from "./headroom-plugin.js";
import { TraceAnalyticsStore } from "./trace-analytics-store.js";
import type { TraceEntry } from "./traces.js";

const BASE = 1_790_000_000_000;
const descriptors = moduleAnalyticsDescriptors([
  { id: headroomPluginManifest.id, manifest: headroomPluginManifest },
]);

function compressed(at: number, id: string, tokensSaved: number, ratio: number): TraceEntry {
  return {
    id,
    at,
    completedAt: at + 10,
    route: "/responses",
    traceKind: "upstream-attempt",
    status: 200,
    isError: false,
    stream: true,
    lifecycleState: "completed",
    latencyMs: 100,
    tokensInput: 300,
    tokensInputCached: 120,
    tokensOutput: 20,
    tokensTotal: 320,
    costUsd: 0.01,
    compression: {
      provider: "headroom",
      outcome: "compressed",
      tokensBefore: 1000,
      tokensAfter: 1000 - tokensSaved,
      tokensSaved,
      compressionRatio: ratio,
      toolTokensSaved: 5,
    },
  };
}

test("headroom contributes validated dashboard metrics without running module code", () => {
  assert.equal(descriptors.length, 4);
  const values = aggregateModuleAnalytics([
    compressed(1, "a", 700, 0.3),
    compressed(2, "b", 300, 0.5),
    {
      ...compressed(3, "skipped", 0, 1),
      compression: { provider: "headroom", outcome: "skipped" },
    },
  ], descriptors)["multivibe.headroom"];
  const byId = Object.fromEntries(values.map((value) => [value.id, value]));
  assert.equal(byId.compressedRequests.value, 2);
  assert.equal(byId.compressedRequests.samples, 2);
  assert.equal(byId.tokensSaved.value, 1000);
  assert.equal(byId.toolTokensSaved.value, 10);
  assert.equal(byId.avgPayloadKept.value, 0.4);
  assert.equal(byId.avgPayloadKept.unit, "ratio");
  // Provider cache hits stay independent from Headroom savings.
  assert.equal(byId.tokensSaved.value, 1000);
});

test("extension metrics are scoped to their module and to the selected traces", () => {
  const result = aggregateModuleAnalytics([compressed(1, "a", 700, 0.3)], [
    ...descriptors,
    { moduleId: "other.extension", metric: { id: "tokensSaved", label: "Other", path: "compression.tokensSaved", aggregation: "sum" } },
  ]);
  assert.equal(result["other.extension"][0].value, 700);
  assert.equal(result["multivibe.headroom"].length, 4);
  assert.deepEqual(analyticsTraceRoots(descriptors), ["compression"]);
  assert.deepEqual(moduleAnalyticsDescriptors([]), []);
});

test("manifest analytics declarations are bounded and reject unsafe selectors", () => {
  assert.equal(validateModuleAnalytics(undefined), undefined);
  assert.throws(() => validateModuleAnalytics([{ id: "Bad", label: "x", aggregation: "sum", path: "compression.tokensSaved" }]), /analytics metric id/);
  assert.throws(() => validateModuleAnalytics([{ id: "ok", label: "x", aggregation: "sum", path: "compression.tokensSaved.__proto__" }]), /analytics path/);
  assert.throws(() => validateModuleAnalytics([{ id: "ok", label: "x", aggregation: "median", path: "compression.tokensSaved" }]), /aggregation/);
  assert.throws(() => validateModuleAnalytics([{ id: "ok", label: "x", aggregation: "sum" }]), /requires a path/);
  assert.throws(() => validateModuleAnalytics([{ id: "ok", label: "x", aggregation: "count", when: { "compression.outcome": undefined } }]), /condition value/);
});

test("the analytics worker aggregates extension metrics from the stored journal", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-module-analytics-"));
  const config = { dbPath: path.join(dir, "stats.sqlite"), historyFilePath: path.join(dir, "history.jsonl"), filePath: path.join(dir, "journal.jsonl"), externalWriter: true, retentionMax: 10 };
  const store = await TraceAnalyticsStore.open(config);
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  store.append([compressed(BASE, "a", 700, 0.3), compressed(BASE + 1, "b", 300, 0.5)], undefined, true);
  const result = store.query("module-analytics", { descriptors, sinceMs: BASE, untilMs: BASE + 1 }) as Record<string, Array<{ id: string; value: number }>>;
  const byId = Object.fromEntries(result["multivibe.headroom"].map((value) => [value.id, value.value]));
  assert.equal(byId.compressedRequests, 2);
  assert.equal(byId.tokensSaved, 1000);
  assert.equal(byId.avgPayloadKept, 0.4);
  const outside = store.query("module-analytics", { descriptors, sinceMs: BASE + 2, untilMs: BASE + 3 }) as Record<string, Array<{ id: string; value: number; samples: number }>>;
  assert.equal(outside["multivibe.headroom"][0].samples, 0);
});
