import assert from "node:assert/strict";
import test from "node:test";
import {
  KIMI_BALANCE_URL,
  KIMI_CODING_MODELS,
  KIMI_CODING_PROVIDER,
  KIMI_CODING_USAGE_URL,
  KIMI_MODELS,
  KIMI_PROVIDER,
  buildKimiBalanceRequest,
  fetchKimiCodingUsage,
  parseKimiBalance,
} from "./kimi-provider.js";

test("declares Kimi's documented global endpoint and active models", () => {
  assert.deepEqual(KIMI_PROVIDER, {
    id: "kimi",
    name: "Kimi",
    adapter: "compatible",
    baseURL: "https://api.moonshot.ai/v1",
  });
  assert.deepEqual(KIMI_MODELS.map(({ id }) => id), [
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
  ]);
  assert.equal(KIMI_MODELS[0]?.context, 1_000_000);
  assert.ok(KIMI_MODELS.every((model) => model.tools && model.reasoning));
});

test("declares the distinct Kimi Code subscription provider", () => {
  assert.deepEqual(KIMI_CODING_PROVIDER, {
    id: "kimi-coding", name: "Kimi Code", adapter: "compatible", baseURL: "https://api.kimi.com/coding/v1",
  });
  assert.deepEqual(KIMI_CODING_MODELS.map(({ id }) => id), [
    "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed",
  ]);
});

test("builds the documented API-key-authenticated balance request", () => {
  assert.equal(KIMI_BALANCE_URL, "https://api.moonshot.ai/v1/users/me/balance");
  assert.deepEqual(buildKimiBalanceRequest(" Bearer test-key "), {
    url: KIMI_BALANCE_URL,
    init: { method: "GET", headers: { Authorization: "Bearer test-key" } },
  });
  assert.throws(() => buildKimiBalanceRequest("  "), /API key required/);
});

test("parses Kimi balances while preserving their currency values", () => {
  assert.deepEqual(parseKimiBalance({
    code: 0,
    data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
    scode: "0x0",
    status: true,
  }), { availableBalance: 49.58894, voucherBalance: 46.58893, cashBalance: 3.00001 });

  assert.throws(() => parseKimiBalance({ code: 0, status: true, data: {} }), /response is invalid/);
  assert.throws(() => parseKimiBalance({ code: 1, status: false, data: {
    available_balance: 0, voucher_balance: 0, cash_balance: 0,
  } }), /response is invalid/);
});

test("fetches and normalizes Kimi Code subscription usage", async () => {
  let request: { input?: string; init?: RequestInit } = {};
  const usage = await fetchKimiCodingUsage(" code-key ", undefined, (async (input: string | URL | Request, init?: RequestInit) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({
      usage: { limit: "2048", used: "512", remaining: "1536", resetTime: "2026-09-14T00:00:00Z" },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "200", used: "50", remaining: "150", resetTime: "2026-09-09T15:00:00Z" },
      }],
    }), { status: 200 });
  }) as typeof fetch);

  assert.equal(request.input, KIMI_CODING_USAGE_URL);
  assert.deepEqual(request.init?.headers, { Authorization: "Bearer code-key", Accept: "application/json" });
  assert.equal(usage.primary?.usedPercent, 25);
  assert.equal(usage.primary?.windowSeconds, 18_000);
  assert.equal(usage.secondary?.usedPercent, 25);
  assert.equal(usage.secondary?.windowSeconds, 604_800);
  assert.equal(usage.quotaStatus, "available");
});
