import assert from "node:assert/strict";
import test from "node:test";
import { LiveModelCatalog, isNonChatProviderModelId } from "./live-model-catalog.js";
import { sdkAccountModels } from "./catalog.js";
import type { Account } from "../types.js";

function deepseekAccount(overrides: Partial<Account> = {}): Account {
  return { id: "deepseek", provider: "ai-sdk", sdkProvider: "deepseek", accessToken: "provider-secret", enabled: true, ...overrides };
}

function providerResponse(ids: string[]): Response {
  return Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "deepseek" })) });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("lists models from the reviewed provider endpoint and serves them from cache", async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const catalog = new LiveModelCatalog({
    fetch: (async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return providerResponse(["deepseek-v4-pro", "deepseek-flash"]);
    }) as typeof fetch,
    blockingBudgetMs: 500,
  });
  const account = deepseekAccount();
  const first = await catalog.snapshot(account);
  assert.deepEqual(first?.ids, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(first?.source, "https://api.deepseek.com/models");
  assert.equal(first?.stale, false);
  assert.equal(first?.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/models");
  assert.equal(calls[0].headers.get("authorization"), "Bearer provider-secret");
  assert.equal(calls[0].headers.get("accept"), "application/json");
  const second = await catalog.snapshot(account);
  assert.deepEqual(second?.ids, first?.ids);
  assert.equal(calls.length, 1);
});

test("serves the cached list while revalidating once the window elapses", async () => {
  let now = 5_000_000;
  const responses = [["deepseek-flash"], ["deepseek-flash", "deepseek-v4.1-flash"]];
  let calls = 0;
  const catalog = new LiveModelCatalog({
    fetch: (async () => { calls++; return providerResponse(responses[calls - 1] ?? []); }) as typeof fetch,
    ttlMs: 1_000,
    blockingBudgetMs: 500,
    now: () => now,
  });
  const account = deepseekAccount();
  assert.deepEqual((await catalog.snapshot(account))?.ids, ["deepseek-flash"]);
  assert.equal(calls, 1);
  now += 5_000;
  const stale = await catalog.snapshot(account);
  assert.deepEqual(stale?.ids, ["deepseek-flash"]);
  assert.equal(stale?.stale, true);
  await waitFor(() => calls === 2 && catalog.state(account.id)?.ids?.length === 2);
  const refreshed = await catalog.snapshot(account);
  assert.deepEqual(refreshed?.ids, ["deepseek-flash", "deepseek-v4.1-flash"]);
  assert.equal(refreshed?.stale, false);
  assert.equal(calls, 2);
});

test("shares one upstream request between concurrent callers", async () => {
  let calls = 0;
  const catalog = new LiveModelCatalog({
    fetch: (async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return providerResponse(["deepseek-chat"]); }) as typeof fetch,
    blockingBudgetMs: 500,
  });
  const account = deepseekAccount();
  const snapshots = await Promise.all([catalog.snapshot(account), catalog.snapshot(account), catalog.snapshot(account)]);
  assert.equal(calls, 1);
  for (const snapshot of snapshots) assert.deepEqual(snapshot?.ids, ["deepseek-chat"]);
});

test("falls back to the reviewed snapshot and backs off after a failed refresh", async () => {
  let calls = 0;
  const catalog = new LiveModelCatalog({
    fetch: (async () => { calls++; return new Response("unauthorized", { status: 401 }); }) as typeof fetch,
    blockingBudgetMs: 500,
  });
  const account = deepseekAccount();
  assert.equal(await catalog.snapshot(account), undefined);
  assert.equal(calls, 1);
  const state = catalog.state(account.id);
  assert.equal(state?.ids, undefined);
  assert.equal(state?.consecutiveFailures, 1);
  assert.equal(state?.lastError, "provider_discovery_authentication_rejected");
  assert.ok((state?.nextRefreshAt ?? 0) > Date.now());
  assert.equal(await catalog.snapshot(account), undefined);
  assert.equal(calls, 1);
});

test("keeps a working list when a later refresh fails", async () => {
  let calls = 0;
  const catalog = new LiveModelCatalog({
    fetch: (async () => {
      calls++;
      if (calls === 1) return providerResponse(["deepseek-chat"]);
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch,
    ttlMs: 1_000,
    blockingBudgetMs: 500,
  });
  const account = deepseekAccount();
  assert.deepEqual((await catalog.snapshot(account))?.ids, ["deepseek-chat"]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const stale = await catalog.snapshot(account);
  assert.deepEqual(stale?.ids, ["deepseek-chat"]);
  await waitFor(() => catalog.state(account.id)?.lastError !== undefined);
  const afterFailure = await catalog.snapshot(account);
  assert.deepEqual(afterFailure?.ids, ["deepseek-chat"]);
  assert.equal(afterFailure?.error, "provider_discovery_upstream_unavailable");
});

test("keeps only chat model ids the provider lists", async () => {
  const catalog = new LiveModelCatalog({
    fetch: (async () => providerResponse([
      "deepseek-chat", "whisper-large-v3", "text-embedding-3-small", "bge-reranker-v2", "../escape", "-leading-dash", "deepseek-v4.1-flash",
    ])) as typeof fetch,
    blockingBudgetMs: 500,
  });
  assert.deepEqual((await catalog.snapshot(deepseekAccount()))?.ids, ["deepseek-chat", "deepseek-v4.1-flash"]);
  assert.equal(isNonChatProviderModelId("qwen3-tts-flash"), true);
  assert.equal(isNonChatProviderModelId("deepseek-flash"), false);
});

test("does not call a provider without a reviewed models endpoint", async () => {
  let calls = 0;
  const catalog = new LiveModelCatalog({
    fetch: (async () => { calls++; return providerResponse(["anything"]); }) as typeof fetch,
    blockingBudgetMs: 500,
  });
  const anthropic: Account = { id: "anthropic", provider: "ai-sdk", sdkProvider: "anthropic", accessToken: "key", enabled: true };
  assert.equal(await catalog.snapshot(anthropic), undefined);
  assert.equal(await catalog.snapshot({ ...anthropic, accessToken: "" }), undefined);
  assert.equal(await catalog.snapshot({ ...anthropic, provider: "openai-compatible" }), undefined);
  assert.equal(calls, 0);
});

test("refreshes when the account credential changes", async () => {
  const tokens: (string | null)[] = [];
  const catalog = new LiveModelCatalog({
    fetch: (async (_input, init) => { tokens.push(new Headers(init?.headers).get("authorization")); return providerResponse(["deepseek-chat"]); }) as typeof fetch,
    blockingBudgetMs: 500,
  });
  const account = deepseekAccount();
  await catalog.snapshot(account);
  await catalog.snapshot({ ...account, accessToken: "rotated-secret" });
  assert.deepEqual(tokens, ["Bearer provider-secret", "Bearer rotated-secret"]);
});

test("merges discovered ids with reviewed metadata and keeps an explicit selection", () => {
  const account = deepseekAccount();
  const snapshot = { ids: ["deepseek-v4-flash", "deepseek-flash"], source: "https://api.deepseek.com/models", fetchedAt: "2026-09-14T10:00:00.000Z", stale: false };
  const models = sdkAccountModels(account, snapshot);
  assert.deepEqual(models.map((model) => model.id), ["deepseek/deepseek-v4-flash", "deepseek/deepseek-flash"]);
  assert.equal(models[0].catalog_source, "https://api.deepseek.com/models");
  assert.equal(models[0].catalog_fetched_at, "2026-09-14T10:00:00.000Z");
  assert.equal(models[0].name, "DeepSeek V4 Flash");
  assert.equal(models[0].context_window, 1_000_000);
  assert.equal(models[0].supports_tools, true);
  assert.ok(models[0].pricing);
  assert.equal(models[1].catalog_source, "https://api.deepseek.com/models");
  assert.equal(models[1].name, "deepseek-flash");
  assert.deepEqual(models[1].input_modalities, ["text"]);
  assert.equal(models[1].pricing, undefined);
  assert.deepEqual(sdkAccountModels({ ...account, sdkModels: ["deepseek-flash"] }, snapshot).map((model) => model.id), ["deepseek/deepseek-flash"]);
  assert.deepEqual(sdkAccountModels({ ...account, sdkModels: ["custom-deployment"] }, snapshot).map((model) => model.id), ["deepseek/custom-deployment"]);
  const reviewed = sdkAccountModels(account);
  assert.equal(reviewed[0].catalog_source, "https://models.dev/api.json");
  assert.deepEqual(reviewed.map((model) => model.id), ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-vision-exp", "deepseek/deepseek-v4-pro"]);
});
