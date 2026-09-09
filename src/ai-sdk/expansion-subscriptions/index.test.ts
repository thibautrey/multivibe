import assert from "node:assert/strict";
import test from "node:test";
import { ACCESS, CATALOGS, PROVIDERS, QUOTA_FETCHERS, parseChutesUsage, parseKiloUsage, parseSyntheticUsage, parseVeniceBalance } from "./index.js";

test("every expansion provider has a sourced catalog, access policy, and quota result", async () => {
  assert.equal(new Set(PROVIDERS.map(p => p.id)).size, PROVIDERS.length);
  for (const provider of PROVIDERS) {
    assert.match(provider.baseURL, /^https:\/\//);
    assert.ok(CATALOGS[provider.id]?.models.length, `${provider.id} catalog`);
    assert.match(CATALOGS[provider.id].source, /^https:\/\//);
    assert.match(ACCESS[provider.id].source, /^https:\/\//);
    assert.equal(typeof QUOTA_FETCHERS[provider.id], "function");
  }
  const unsupported = await QUOTA_FETCHERS["ollama-cloud"]({ id: "a", accessToken: "key", enabled: true }, new AbortController().signal);
  assert.equal(unsupported.quotaStatus, "unsupported");
  assert.match(unsupported.quotaMessage!, /browser session cookie/);
});

test("Chutes keeps hard rolling and monthly subscription windows distinct", () => {
  const usage = parseChutesUsage({ rolling: { requests: 25, limit: 100, window_minutes: 240 }, monthly_usage: { remaining: 700, limit: 1000, resets_at: "2026-10-01T00:00:00Z" } }, 1);
  assert.deepEqual(usage.primary, { label: "4-hour quota", usedPercent: 25, windowSeconds: 14400, resetAt: undefined });
  assert.equal(usage.monthly?.usedPercent, 30);
  assert.equal(usage.fetchedAt, 1);
});

test("exact one in a provider percent field means one percent", () => {
  assert.equal(parseChutesUsage({ rolling_window: { usage_percent: 1 } }).primary?.usedPercent, 1);
  assert.equal(parseChutesUsage({ rolling_window: { usage_percent: 0.4 } }).primary?.usedPercent, 0.4);
});

test("a confirmed zero allowance is exhausted rather than unknown", () => {
  assert.equal(parseChutesUsage({ rolling_window: { used: 0, limit: 0 } }).primary?.usedPercent, 100);
});

test("Xiaomi Token Plan regions use fixed hosts and never fall through to PAYG", () => {
  const regions = PROVIDERS.filter(provider => provider.id.startsWith("xiaomi-token-plan"));
  assert.deepEqual(regions.map(provider => provider.baseURL), [
    "https://token-plan-cn.xiaomimimo.com/v1",
    "https://token-plan-ams.xiaomimimo.com/v1",
    "https://token-plan-sgp.xiaomimimo.com/v1",
  ]);
});

test("Venice reports absolute balance without inventing a percentage", () => {
  const usage = parseVeniceBalance({ balances: { diem: 42, usd: 3 }, consumptionCurrency: "DIEM" }, 2);
  assert.deepEqual(usage.balance, { remaining: 42, unit: "DIEM" });
  assert.equal(usage.primary, undefined);
});

test("Kilo separates PAYG credits from Kilo Pass allowance", () => {
  const usage = parseKiloUsage([{ result: { data: { json: { creditBlocks: [{ amount_mUsd: 10_000_000, balance_mUsd: 4_000_000 }] } } } }, { result: { data: { json: { subscription: { currentPeriodUsageUsd: 3, currentPeriodBaseCreditsUsd: 12, currentPeriodBonusCreditsUsd: 3, nextBillingAt: "2026-10-01T00:00:00Z" } } } } }], 3);
  assert.deepEqual(usage.balance, { remaining: 4, unit: "USD" });
  assert.deepEqual(usage.spend, { amount: 6, unit: "USD" });
  assert.equal(usage.credits, undefined);
  assert.equal(usage.allowances?.[0].usedPercent, 20);
  assert.equal(usage.allowances?.[0].label, "Kilo Pass");
});

test("Synthetic maps documented lanes and treats search as tools", () => {
  const usage = parseSyntheticUsage({ rollingFiveHourLimit: { used_percent: 0.4, window_minutes: 300 }, weeklyTokenLimit: { used: 25, limit: 100 }, search: { hourly: { remaining: 8, limit: 10 } } }, 4);
  assert.equal(usage.primary?.usedPercent, 0.4);
  assert.equal(usage.secondary?.usedPercent, 25);
  assert.equal(usage.tools?.usedPercent, 20);
});

test("Chutes preserves a successful partial subscription when optional quota lookup fails", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (requests.length === 1) return new Response(JSON.stringify({ monthly: { used: 2, limit: 10 } }), { status: 200 });
    return new Response("failure", { status: 503 });
  }) as typeof fetch;
  try {
    const usage = await QUOTA_FETCHERS.chutes({ id: "c", accessToken: "cpk_test", enabled: true }, new AbortController().signal);
    assert.equal(usage.monthly?.usedPercent, 20);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].init?.redirect, "error");
  } finally { globalThis.fetch = original; }
});

test("Kilo quota batch requests only credits and Pass data", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify([{ result: { data: { json: { creditBlocks: [] } } } }]), { status: 200 });
  }) as typeof fetch;
  try {
    await QUOTA_FETCHERS.kilo({ id: "k", accessToken: "token", enabled: true }, new AbortController().signal);
    assert.match(requested, /user\.getCreditBlocks,kiloPass\.getState/);
    assert.doesNotMatch(requested, /AutoTopUp|PaymentMethod/);
  } finally { globalThis.fetch = original; }
});
