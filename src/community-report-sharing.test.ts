import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createCommunityReportSharingWorker, type CommunityReportPayload } from "./community-report-sharing.js";
import type { CommunityHostDescriptor } from "./community-host-profile.js";
import type { CommunityReportTrace } from "./community-report.js";
import type { StoreSettings } from "./types.js";

const now = new Date("2026-09-02T12:00:00.000Z");

const host: CommunityHostDescriptor = Object.freeze({
  acceleratorKind: "metal",
  acceleratorName: "Apple M3 Ultra",
  acceleratorMemoryBytes: 137_438_953_472,
  hostMemoryBytes: 274_877_906_944,
  os: "darwin",
  architecture: "arm64",
  machineModel: "Mac14,14",
});

function trace(): CommunityReportTrace {
  return {
    lifecycleState: "completed",
    isError: false,
    provider: "openai-compatible",
    model: "public/model",
    requestedModel: "public/model",
    executionLocation: "local",
    latencyMs: 1_200,
    ttftMs: 180,
    tokensInput: 3_500,
    tokensOutput: 400,
    tokensInputCached: 0,
    tokensReasoning: 0,
  };
}

async function harness(options: {
  settings: StoreSettings;
  hostAvailable?: boolean;
  reportStatus?: number;
  benchmarks?: unknown;
}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-community-report-"));
  const statePath = path.join(directory, "state.json");
  const posted: CommunityReportPayload[] = [];
  let fetchCalls = 0;
  let allowlistCalls = 0;
  const worker = createCommunityReportSharingWorker({
    settingsStore: { getSettings: async () => options.settings },
    traceSource: {
      collectCommunityReportTraces: async (sinceMs, untilMs) => {
        assert.equal(sinceMs, Date.parse("2026-09-01T12:00:00.000Z"));
        assert.equal(untilMs, Date.parse("2026-09-02T00:00:00.000Z"));
        return [trace()];
      },
    },
    hostProvider: async () => (options.hostAvailable === false ? undefined : host),
    benchmarkStore: {
      read: async () => {
        if (options.benchmarks === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return options.benchmarks;
      },
    },
    statePath,
    clock: () => now,
    random: () => 0,
    onWarning: () => undefined,
    fetchFn: (async (input, init) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.endsWith("/telemetry/v2/allowlist")) {
        allowlistCalls += 1;
        return Response.json({
          schemaVersion: 2,
          generatedAt: now.toISOString(),
          histogramBoundsVersion: "community-histogram-v1",
          models: { "public/model": "hf:public/model" },
          runtimeFamilies: ["ollama"],
          maxModels: 50,
        }, { headers: { etag: '"allowlist-v2"' } });
      }
      if (url.endsWith("/telemetry/v1/admission")) {
        return Response.json({
          ticketId: randomUUID(),
          challenge: "cd".repeat(32),
          eventId: JSON.parse(String(init?.body)).eventId,
          difficulty: 18,
          expiresAt: new Date(now.getTime() + 600_000).toISOString(),
        });
      }
      const headers = new Headers(init?.headers);
      assert.ok(headers.get("x-telemetry-ticket"));
      assert.ok(headers.get("x-telemetry-proof"));
      posted.push(JSON.parse(String(init?.body)) as CommunityReportPayload);
      return Response.json({ accepted: true, duplicate: false }, { status: options.reportStatus ?? 202 });
    }) as typeof fetch,
  });
  return { worker, statePath, posted, allowlistCalls: () => allowlistCalls, fetchCalls: () => fetchCalls };
}

test("community report sharing stays disabled, sends nothing and keeps no state until opted in", async () => {
  const run = await harness({ settings: {} });
  assert.equal(await run.worker.runOnce(), "disabled");
  assert.equal(run.fetchCalls(), 0);
  assert.equal(run.posted.length, 0);
  await assert.rejects(fs.readFile(run.statePath, "utf8"), { code: "ENOENT" });
});

test("an opted-in installation sends one bounded report per completed day", async () => {
  const run = await harness({
    settings: {
      communityBenchmarksSharingEnabled: true,
      communityBenchmarksSharingEnabledAt: "2026-09-01T12:00:00.000Z",
    },
  });
  assert.equal(await run.worker.runOnce(), "sent");
  const pending = run.posted[0]!;
  assert.equal(pending.schemaVersion, 2);
  assert.equal(pending.host.acceleratorName, "Apple M3 Ultra");
  assert.equal(pending.models.length, 1);
  assert.equal(pending.models[0]?.modelId, "hf:public/model");
  assert.deepEqual(pending.syntheticBenchmarks, []);
  const serialized = JSON.stringify(pending);
  for (const forbidden of ["account", "project", "prompt", "response", "serial", "hostname"]) {
    assert.equal(serialized.includes(forbidden), false, `report must not contain ${forbidden}`);
  }
  assert.equal((await fs.stat(run.statePath)).mode & 0o777, 0o600);
  const state = JSON.parse(await fs.readFile(run.statePath, "utf8"));
  assert.equal(state.pending, undefined);
  assert.equal(state.lastCompletedPeriodEnd, "2026-09-02T00:00:00.000Z");
  assert.equal(await run.worker.runOnce(), "skipped");
  assert.equal(run.posted.length, 1);
});

test("a failed ingestion keeps the identical pending report and retries it", async () => {
  const run = await harness({
    settings: {
      communityBenchmarksSharingEnabled: true,
      communityBenchmarksSharingEnabledAt: "2026-09-01T12:00:00.000Z",
    },
    reportStatus: 503,
  });
  assert.equal(await run.worker.runOnce(), "failed");
  const pending = JSON.parse(await fs.readFile(run.statePath, "utf8")).pending;
  assert.equal(pending.eventId, run.posted[0]?.eventId);
  assert.equal(run.posted.length, 1);
  const { worker } = run;
  await worker.applySettings({ communityBenchmarksSharingEnabled: false });
  await assert.rejects(fs.readFile(run.statePath, "utf8"), { code: "ENOENT" });
});

test("an unsupported machine completes the day without reporting or retrying forever", async () => {
  const run = await harness({
    settings: {
      communityBenchmarksSharingEnabled: true,
      communityBenchmarksSharingEnabledAt: "2026-09-01T12:00:00.000Z",
    },
    hostAvailable: false,
  });
  assert.equal(await run.worker.runOnce(), "empty");
  assert.equal(run.posted.length, 0);
  const state = JSON.parse(await fs.readFile(run.statePath, "utf8"));
  assert.equal(state.lastCompletedPeriodEnd, "2026-09-02T00:00:00.000Z");
});
