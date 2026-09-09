import assert from "node:assert/strict";
import test from "node:test";
import { fetchOpenRouterUsage, parseOpenRouterKeyUsage } from "./openrouter-quota.js";
import type { Account } from "../types.js";

const account: Account = { id: "or", provider: "ai-sdk", sdkProvider: "openrouter", accessToken: "sk-or-secret", enabled: true };

test("maps the authenticated key's explicit credit cap", () => {
  const usage = parseOpenRouterKeyUsage({ data: { limit: 40, limit_remaining: 10, usage: 35, limit_reset: "monthly" } });
  assert.equal(usage.credits?.usedPercent, 75);
  assert.equal(usage.quotaStatus, "available");
});

test("preserves an unlimited key without inventing a credit window", () => {
  const usage = parseOpenRouterKeyUsage({ data: { limit: null, limit_remaining: null, usage: 12 } });
  assert.equal(usage.credits, undefined);
  assert.equal(usage.quotaStatus, "available");
});

test("rejects incomplete payloads and recognizes a zero spending cap", () => {
  assert.throws(() => parseOpenRouterKeyUsage({ data: { limit: 20 } }), /limit_remaining/);
  assert.equal(parseOpenRouterKeyUsage({ data: { limit: 0, limit_remaining: 0 } }).credits?.usedPercent, 100);
});

test("uses the inference key against the fixed key endpoint", async () => {
  const controller = new AbortController();
  const usage = await fetchOpenRouterUsage(account, controller.signal, async (input, init) => {
    assert.equal(input, "https://openrouter.ai/api/v1/key");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk-or-secret");
    assert.equal(init?.signal, controller.signal);
    return Response.json({ data: { limit: 50, limit_remaining: 40 } });
  });
  assert.ok(Math.abs((usage.credits?.usedPercent ?? 0) - 20) < 1e-9);
});

test("surfaces authentication failures", async () => {
  await assert.rejects(fetchOpenRouterUsage(account, undefined, async () => new Response(null, { status: 401 })), /probe failed 401/);
});
