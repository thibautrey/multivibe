import assert from "node:assert/strict";
import test from "node:test";
import { createDemoApi, DEMO_READ_ONLY } from "../../demo/api";

const now = Date.UTC(2026, 8, 7, 12);
const api = createDemoApi(now);
const read = (path: string) => api("GET", path).body as any;

test("demo request totals, costs, projects, and chart buckets reconcile", () => {
  const stats = read("/admin/stats/traces").stats;
  const projects = read("/admin/stats/usage").byProject;
  assert.ok(stats.totals.requests > 1000);
  assert.ok(stats.totals.errors > 0);
  assert.ok(stats.totals.costUsd > 0);
  assert.ok(stats.ttftByProviderModel.length > 0);
  assert.equal(stats.totals.requests, stats.totals.upstreamAttempts);
  assert.equal(stats.totals.tokensTotal, stats.totals.tokensInput + stats.totals.tokensOutput);
  assert.equal(projects.reduce((sum: number, project: any) => sum + project.requests, 0), stats.totals.requests);
  assert.equal(stats.timeseries.reduce((sum: number, bucket: any) => sum + bucket.requests, 0), stats.totals.requests);
  assert.ok(Math.abs(projects.reduce((sum: number, project: any) => sum + project.costUsd, 0) - stats.totals.costUsd) < 0.00001);
});

test("demo time ranges, pagination, and details operate on the same dataset", () => {
  const since = now - 86400000;
  const range = `sinceMs=${since}&untilMs=${now}`;
  const day = read(`/admin/stats/traces?${range}`).stats;
  assert.ok(day.totals.requests > 0 && day.totals.requests < read("/admin/stats/traces").stats.totals.requests);
  const first = read(`/admin/traces?${range}&pageSize=7`);
  const second = read(`/admin/traces?${range}&pageSize=7&page=2`);
  assert.equal(first.pagination.total, day.totals.requests + day.totals.upstreamAttempts);
  assert.equal(first.traces.length, 7);
  assert.ok(first.traces.every((trace: any) => trace.at >= since && trace.at <= now));
  assert.ok(second.traces.every((trace: any) => !first.traces.some((other: any) => other.id === trace.id)));
  assert.ok(read(`/admin/traces/${first.traces[0].id}`).trace.requestBody);
  assert.equal(read("/admin/traces?pageSize=0&page=-1").pagination.pageSize, 100);
  assert.equal(read(`/admin/traces?sinceMs=${now + 1}`).traces.length, 0);
});

test("demo rejects writes, OAuth, inference, and exports without changing fixtures", () => {
  const original = structuredClone(read("/admin/accounts"));
  for (const [method, path] of [["POST", "/admin/accounts"], ["PATCH", "/admin/settings"], ["DELETE", "/admin/accounts/demo-openai-studio"], ["POST", "/admin/oauth/start"], ["POST", "/v1/responses"], ["GET", "/admin/traces/export.zip"]]) {
    assert.deepEqual(api(method, path), { status: 403, body: { error: DEMO_READ_ONLY } });
  }
  assert.deepEqual(read("/admin/accounts"), original);
  assert.equal(api("GET", "/admin/unknown").status, 404);
  assert.deepEqual(api("POST", "/admin/local-runtimes/discover").body, { accounts: [] });
  assert.deepEqual(api("POST", "/admin/usage/refresh-stale").body, original);
  assert.equal(read("/admin/settings").settings.anonymousUsageSharingEnabled, false);
});
