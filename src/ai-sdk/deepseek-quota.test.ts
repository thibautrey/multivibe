import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "../types.js";
import { fetchDeepSeekUsage, parseDeepSeekBalance } from "./deepseek-quota.js";

const account: Account = {
  id: "deepseek-test",
  provider: "ai-sdk",
  sdkProvider: "deepseek",
  accessToken: "test-key",
  enabled: true,
};

test("DeepSeek balance parsing exposes spendable API credit without inventing a quota window", () => {
  const usage = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    }],
  });
  assert.deepEqual(usage.balance, { remaining: 110, unit: "CNY" });
  assert.equal(usage.quotaStatus, "available");
  assert.match(usage.quotaMessage ?? "", /spendable API credit, not a subscription quota window/);
  assert.equal(usage.primary, undefined);
  assert.equal(usage.secondary, undefined);
});

test("DeepSeek balance fetch uses only the fixed official endpoint", async () => {
  const usage = await fetchDeepSeekUsage(account, undefined, async (input, init) => {
    assert.equal(String(input), "https://api.deepseek.com/user/balance");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    return Response.json({
      is_available: false,
      balance_infos: [{ currency: "USD", total_balance: "0.25", granted_balance: "0.25", topped_up_balance: "0.00" }],
    });
  });
  assert.deepEqual(usage.balance, { remaining: 0.25, unit: "USD" });
  assert.match(usage.quotaMessage ?? "", /insufficient for API calls/);
});

test("DeepSeek balance parsing rejects ambiguous or malformed balances", () => {
  assert.throws(() => parseDeepSeekBalance({ is_available: true, balance_infos: [] }), /unambiguous/);
  assert.throws(() => parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: "EUR", total_balance: "1", granted_balance: "0", topped_up_balance: "1" }],
  }), /currency/);
  assert.throws(() => parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "NaN", granted_balance: "0", topped_up_balance: "0" }],
  }), /total_balance/);
});
