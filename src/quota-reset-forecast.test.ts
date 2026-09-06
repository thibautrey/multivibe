import assert from "node:assert/strict";
import test from "node:test";
import {
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
