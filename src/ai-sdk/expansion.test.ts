import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "../types.js";
import { fetchSdkUsage } from "./quota.js";

const account = (sdkProvider: string): Account => ({ id: `test-${sdkProvider}`, provider: "ai-sdk", sdkProvider, accessToken: "test-key", enabled: true });

test("the shared quota dispatcher uses reviewed subscription endpoints and returns quota readings", async t => {
  const cases = [
    { id: "chutes", host: "api.chutes.ai", payload: { rolling: { used: 2, limit: 10 }, monthly: { used: 5, limit: 100 } } },
    { id: "venice", host: "api.venice.ai", payload: { balances: { diem: 42 }, consumptionCurrency: "DIEM" } },
    { id: "kilo", host: "app.kilo.ai", payload: [{ result: { data: { json: { creditBlocks: [{ amount_mUsd: 10_000_000, balance_mUsd: 4_000_000 }] } } } }] },
    { id: "synthetic", host: "api.synthetic.new", payload: { rollingFiveHourLimit: { used: 2, limit: 10 } } },
  ];
  for (const c of cases) {
    let called = false;
    const mocked = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      called = true;
      assert.equal(new URL(String(input)).hostname, c.host);
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
      return Response.json(c.payload);
    });
    const usage = await fetchSdkUsage(account(c.id), new AbortController().signal);
    mocked.mock.restore();
    assert.equal(called, true, c.id);
    assert.equal(usage.quotaStatus, "available", c.id);
    assert.ok(usage.primary || usage.balance, c.id);
  }
});

test("browser-only subscription meters remain explicit and do not probe with the wrong credentials", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected inference-key quota probe"); });
  for (const id of ["byteplus-coding", "xiaomi-token-plan", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp", "ollama-cloud", "bedrock", "azure-foundry", "vertex-express", "cloudflare"]) {
    const usage = await fetchSdkUsage(account(id), new AbortController().signal);
    assert.equal(usage.quotaStatus, "unsupported", id);
    assert.ok(usage.quotaMessage, id);
    assert.equal(usage.primary, undefined);
  }
});
