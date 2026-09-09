import assert from "node:assert/strict";
import test from "node:test";
import { createSdkModel } from "./models.js";
import { sdkAccountModels, sdkModelId, sdkProviderCatalog } from "./catalog.js";
import { sdkCallOptions, chatResult } from "./protocol.js";
import { refreshUsageIfNeeded, isUsageRefreshNeeded } from "../quota.js";
import { fetchPoeUsage, parsePoeUsage } from "./poe-provider.js";
import { parseMammouthUsage } from "./mammouth-quota.js";
import type { Account } from "../types.js";

const endpoints = {
  poe: "https://api.poe.com/v1",
  minimax: "https://api.minimax.io/v1",
  "minimax-coding": "https://api.minimax.io/v1",
  kimi: "https://api.moonshot.ai/v1",
  "kimi-coding": "https://api.kimi.com/coding/v1",
  huggingface: "https://router.huggingface.co/v1",
  abacus: "https://routellm.abacus.ai/v1",
  "qwen-coding": "https://coding-intl.dashscope.aliyuncs.com/v1",
};

for (const [provider, endpoint] of Object.entries(endpoints)) test(`${provider}: catalog selection reaches the reviewed endpoint in buffered and streaming mode`, async () => {
  const account: Account = { id: "account", enabled: true, provider: "ai-sdk", sdkProvider: provider, accessToken: "secret" };
  const listed = sdkAccountModels(account);
  assert.ok(listed.length);
  const upstreamModel = sdkModelId(account, listed[0].id);
  assert.ok(sdkProviderCatalog().providers.some((p) => p.id === provider));
  const model = createSdkModel(account, upstreamModel, async (url, init) => {
    assert.equal(String(url), `${endpoint}/chat/completions`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, upstreamModel);
    assert.equal(body.messages[0].content, "Hello");
    if (body.stream) return new Response([
      { id: "reply", object: "chat.completion.chunk", created: 1, model: upstreamModel, choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] },
      { id: "reply", object: "chat.completion.chunk", created: 1, model: upstreamModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    return Response.json({ id: "reply", object: "chat.completion", created: 1, model: upstreamModel,
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  });
  const options = sdkCallOptions({ messages: [{ role: "user", content: "Hello" }] }, new AbortController().signal);
  const reply = chatResult(listed[0].id, await model.doGenerate(options));
  assert.equal(reply.choices[0].message.content, "Hi");
  assert.ok(reply.usage);
  assert.equal(reply.usage.total_tokens, 6);
  const stream = await model.doStream(options);
  const parts = [];
  for await (const part of stream.stream) parts.push(part);
  assert.ok(parts.some((part) => part.type === "text-delta" && part.delta === "Hi"));
  assert.ok(parts.some((part) => part.type === "finish"));
  assert.ok(!parts.some((part) => part.type === "error"));
});

test("Poe balance uses its fixed endpoint and never invents a denominator", async () => {
  const usage = await fetchPoeUsage("secret", undefined, async (url, init) => {
    assert.equal(url, "https://api.poe.com/usage/current_balance");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    assert.equal(init?.redirect, "error");
    return Response.json({ current_point_balance: 1500 });
  });
  assert.deepEqual(usage.balance, { remaining: 1500, unit: "points" });
  assert.equal(usage.credits, undefined);
  for (const payload of [null, {}, { current_point_balance: -1 }, { current_point_balance: "1500" }, { current_point_balance: Infinity }]) assert.throws(() => parsePoeUsage(payload));
});

test("Mammouth exposes key spend and only an explicit key budget, never raw keys", () => {
  const usage = parseMammouthUsage({ key: "secret", info: { token: "secret", spend: 3, max_budget: 10, budget_reset_at: "2026-10-01T00:00:00Z" } });
  assert.equal(usage.credits?.usedPercent, 30);
  assert.equal(usage.credits?.resetAt, Date.UTC(2026, 9, 1));
  assert.deepEqual(usage.spend, { amount: 3, unit: "USD" });
  assert.ok(!JSON.stringify(usage).includes("secret"));
  assert.equal(parseMammouthUsage({ info: { spend: 2, max_budget: null } }).credits, undefined);
  assert.throws(() => parseMammouthUsage({ info: { spend: "unknown" } }));
});

test("new quota probes use shared stale-data, retry and recovery behavior", async () => {
  const originalFetch = globalThis.fetch;
  const account: Account = { id: "poe", provider: "ai-sdk", sdkProvider: "poe", enabled: true, accessToken: "secret" };
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; assert.equal(url, "https://api.poe.com/usage/current_balance"); return Response.json({ current_point_balance: 20 }); };
  try {
    await refreshUsageIfNeeded(account, "https://untrusted.invalid", true);
    assert.equal(account.usage?.balance?.remaining, 20);
    await refreshUsageIfNeeded(account, "https://untrusted.invalid");
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await refreshUsageIfNeeded(account, "https://untrusted.invalid", true);
    assert.equal(account.usage?.quotaStatus, "error");
    assert.equal(account.usage?.balance?.remaining, 20);
    assert.equal(isUsageRefreshNeeded(account), false);
    assert.equal(isUsageRefreshNeeded(account, Date.now() + 61_000), true);
    globalThis.fetch = async () => Response.json({ current_point_balance: 12 });
    await refreshUsageIfNeeded(account, "https://untrusted.invalid", true);
    assert.equal(account.usage?.quotaStatus, "available");
    assert.equal(account.state?.lastError, undefined);
    assert.equal(account.usage?.balance?.remaining, 12);
    account.sdkProvider = "minimax";
    globalThis.fetch = async () => { throw new Error("PAYG keys must not be probed as subscriptions"); };
    await refreshUsageIfNeeded(account, "https://untrusted.invalid", true);
    assert.equal(account.usage?.quotaStatus, "unsupported");
    assert.equal(account.usage?.balance, undefined);
  } finally { globalThis.fetch = originalFetch; }
});
