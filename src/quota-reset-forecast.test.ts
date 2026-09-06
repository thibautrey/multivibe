import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexQuotaResetForecastCache,
  CODEX_QUOTA_RESET_FORECAST_API_URL,
  fetchCodexQuotaResetForecast,
} from "./quota-reset-forecast.js";

test("normalizes the public Codex reset forecast payload", async () => {
  let requestedUrl = "";
  const forecast = await fetchCodexQuotaResetForecast(async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      forecast: { score: 42.4, state: "forecast", horizonHours: 48 },
    }), { status: 200 });
  });

  assert.equal(requestedUrl, CODEX_QUOTA_RESET_FORECAST_API_URL);
  assert.deepEqual(forecast, {
    score: 42.4,
    state: "forecast",
    horizonHours: 48,
  });
});

test("rejects an invalid forecast score", async () => {
  await assert.rejects(
    fetchCodexQuotaResetForecast(async () =>
      new Response(JSON.stringify({ forecast: { score: 101 } }), { status: 200 }),
    ),
    /invalid score/,
  );
});

test("rejects an unavailable forecast upstream", async () => {
  await assert.rejects(
    fetchCodexQuotaResetForecast(async () =>
      new Response("unavailable", { status: 503 }),
    ),
    /HTTP 503/,
  );
});

test("forecast cache coalesces and throttles menu-bar polling", async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const cache = new CodexQuotaResetForecastCache(async () => {
    calls += 1;
    return new Response(JSON.stringify({ forecast: { score: 42, state: "quiet" } }), { status: 200 });
  }, () => now);

  const [first, second] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(first.score, 42);
  assert.equal(second.score, 42);
  assert.equal(calls, 1);
  now += 4 * 60_000;
  assert.equal((await cache.get()).score, 42);
  assert.equal(calls, 1);
  now += 2 * 60_000;
  await cache.get();
  assert.equal(calls, 2);
});

test("forecast cache throttles repeated failures", async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const cache = new CodexQuotaResetForecastCache(async () => {
    calls += 1;
    return new Response("unavailable", { status: 503 });
  }, () => now);

  await assert.rejects(cache.get(), /HTTP 503/);
  await assert.rejects(cache.get(), /HTTP 503/);
  assert.equal(calls, 1);
  now += 61_000;
  await assert.rejects(cache.get(), /HTTP 503/);
  assert.equal(calls, 2);
});
