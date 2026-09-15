import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { createModelBenchmarkClient } from "../../model-benchmarks.js";
import { createCachedModelBenchmarkClient } from "../../model-benchmark-cache.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { modelBenchmarkRoutes } from "./model-benchmark-routes.js";

async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-routes-")); t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const fetcher = (async input => {
    const url = String(input);
    if (url.includes("leaderboard")) return new Response(JSON.stringify([{ rank: 1, model_id: "owner/model", value: 8 }]));
    if (url.includes("artificialanalysis")) return new Response(JSON.stringify({ tier: "free", intelligence_index_version: 4.3, pagination: { page: 1 }, data: [] }));
    return new Response(JSON.stringify({ id: "owner/model", evalResults: [] }));
  }) as typeof fetch;
  const client = createCachedModelBenchmarkClient(createModelBenchmarkClient({ fetcher, artificialAnalysisApiKey: "test" }), { path: path.join(directory, "cache.json") });
  const app = express(); app.use("/admin/benchmarks", modelBenchmarkRoutes(client));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/benchmarks`;
}

test("dashboard benchmark endpoints expose source, model, leaderboard and optional catalog contracts", async t => {
  const base = await fixture(t);
  for (const path of ["/sources", "/cache", "/cached-models", "/models?model=owner%2Fmodel", "/leaderboards?dataset=org%2Fbench&limit=1", "/artificial-analysis/models?page=1"]) {
    const response = await fetch(base + path); assert.equal(response.status, 200, path); assert.equal(response.headers.get("cache-control"), "private, max-age=300");
  }
});

test("invalid dashboard queries return stable errors", async t => {
  const base = await fixture(t);
  const response = await fetch(`${base}/models?model=unsafe`);
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "invalid_request" });
});
