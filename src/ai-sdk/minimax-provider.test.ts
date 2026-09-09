import assert from "node:assert/strict";
import test from "node:test";
import { MINIMAX_MODELS, MINIMAX_PROVIDER, fetchMinimaxUsage, parseMinimaxUsage } from "./minimax-provider.js";

const fixture = {
  base_resp: { status_code: "0" },
  data: { model_remains: [{
    model_name: "general",
    current_interval_total_count: 0,
    current_interval_usage_count: 0,
    current_interval_remaining_percent: "96",
    end_time: 1_780_297_200_000,
    current_weekly_remaining_percent: 99,
    weekly_end_time: 1_780_848_000_000,
  }] },
};

test("declares the reviewed MiniMax OpenAI-compatible provider and models", () => {
  assert.deepEqual(MINIMAX_PROVIDER, { id: "minimax", name: "MiniMax", adapter: "compatible", baseURL: "https://api.minimax.io/v1" });
  assert.deepEqual(MINIMAX_MODELS.map(({ id }) => id), ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"]);
});

test("parses percent-based 5-hour and weekly token-plan windows", () => {
  const usage = parseMinimaxUsage(fixture, 1_780_282_340_000);
  assert.deepEqual(usage.primary, { usedPercent: 4, resetAt: 1_780_297_200_000, windowSeconds: 18_000 });
  assert.deepEqual(usage.secondary, { usedPercent: 1, resetAt: 1_780_848_000_000, windowSeconds: 604_800 });
  assert.equal(usage.quotaStatus, "available");
});

test("fetches token-plan usage with bearer authentication", async () => {
  const usage = await fetchMinimaxUsage(" secret ", undefined, async (input, init) => {
    assert.equal(input, "https://www.minimax.io/v1/token_plan/remains");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret");
    return new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(usage.primary?.usedPercent, 4);
});

test("rejects undocumented or unsuccessful quota responses", async () => {
  assert.throws(() => parseMinimaxUsage({ base_resp: { status_code: 0 } }), /no model quota windows/);
  await assert.rejects(fetchMinimaxUsage("key", undefined, async () => new Response("no", { status: 401 })), /failed 401/);
});
