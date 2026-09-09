import assert from "node:assert/strict";
import test from "node:test";
import {
  accountFromCopilotOAuth, buildCopilotHeaders, copilotModelEntries,
  pollCopilotDeviceCode, refreshCopilotAccessToken, requestCopilotDeviceCode, trustedCopilotBaseUrl,
} from "./github-copilot.js";
import { ensureValidToken, isAccountReauthenticationError, isTokenRefreshNeeded } from "./account-utils.js";
import { normalizeProvider, refreshUsageIfNeeded } from "./quota.js";
import { authorizationForAccountRequest } from "./local-runtime-discovery.js";
import type { Account, OAuthFlowState } from "./types.js";

const account: Account & { refreshToken: string } = {
  id: "copilot", provider: "github-copilot", enabled: true,
  accessToken: "old-inference-token", refreshToken: "github-secret", expiresAt: 1,
};
const jsonFetch = (body: unknown) => (async () => Response.json(body)) as typeof fetch;
const tokenResponse = () => ({ token: "inference-secret", expires_at: Math.floor(Date.now() / 1000) + 3600,
  endpoints: { api: "https://api.business.githubcopilot.com" } });

test("GitHub device authorization uses the registered client and validates the verification URL", async () => {
  const device = await requestCopilotDeviceCode(async (url, init) => {
    assert.equal(url, "https://github.com/login/device/code");
    assert.equal(init?.redirect, "error");
    assert.equal(JSON.parse(String(init?.body)).scope, "read:user");
    return Response.json({ device_code: "device-secret", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 });
  });
  assert.equal(device.deviceCode, "device-secret");
  assert.equal(device.intervalSeconds, 5);
  assert.ok(device.expiresAt > Date.now());
  await assert.rejects(requestCopilotDeviceCode(jsonFetch({ device_code: "d", user_code: "CODE", verification_uri: "https://evil.example/login/device" })), /untrusted/);
  await assert.rejects(requestCopilotDeviceCode(jsonFetch({ device_code: "", user_code: "CODE", verification_uri: "https://github.com/login/device" })), /invalid/);
});

test("GitHub HTTP-200 OAuth errors preserve pending/slow-down and reject denied or expired codes", async () => {
  assert.deepEqual(await pollCopilotDeviceCode("d", 5, jsonFetch({ error: "authorization_pending" })), { status: "pending", intervalSeconds: 5 });
  assert.deepEqual(await pollCopilotDeviceCode("d", 5, jsonFetch({ error: "slow_down", interval: 15 })), { status: "pending", intervalSeconds: 15 });
  assert.deepEqual(await pollCopilotDeviceCode("d", 15, jsonFetch({ error: "slow_down", interval: 2 })), { status: "pending", intervalSeconds: 20 });
  for (const error of ["access_denied", "expired_token", "unknown_error"]) {
    await assert.rejects(pollCopilotDeviceCode("d", 5, jsonFetch({ error, error_description: "github-secret" })), (error: Error) => !error.message.includes("github-secret"));
  }
  assert.deepEqual(await pollCopilotDeviceCode("d", 5, jsonFetch({ access_token: "github-secret" })), { status: "success", githubToken: "github-secret" });
  await assert.rejects(pollCopilotDeviceCode("d", 5, jsonFetch({})), /access token/);
});

test("Copilot exchanges GitHub credentials and preserves reauthentication account settings", async () => {
  const result = await accountFromCopilotOAuth({ email: "new label", targetAccountId: account.id } as OAuthFlowState,
    "github-secret", { ...account, priority: 7, enabled: false }, async (url, init) => {
      assert.equal(url, "https://api.github.com/copilot_internal/v2/token");
      assert.equal(new Headers(init?.headers).get("authorization"), "token github-secret");
      assert.equal(init?.redirect, "error");
      return Response.json(tokenResponse());
    });
  assert.equal(result.id, account.id);
  assert.equal(result.refreshToken, "github-secret");
  assert.equal(result.accessToken, "inference-secret");
  assert.equal(result.baseUrl, "https://api.business.githubcopilot.com");
  assert.equal(result.priority, 7);
  assert.equal(result.enabled, false);
  assert.equal(result.email, "new label");
  assert.equal(isTokenRefreshNeeded(result), false);
});

test("invalid tokens and untrusted inference endpoints are rejected without leaking credentials", async () => {
  for (const value of ["https://evil.example", "http://api.githubcopilot.com", "https://api.githubcopilot.com.evil.example", "https://secret@api.githubcopilot.com", "https://api.githubcopilot.com/path", "https://api.githubcopilot.com?secret"]) {
    assert.throws(() => trustedCopilotBaseUrl(value));
    await assert.rejects(refreshCopilotAccessToken(account, jsonFetch({ ...tokenResponse(), endpoints: { api: value } })));
  }
  await assert.rejects(refreshCopilotAccessToken(account, jsonFetch({ token: "secret", expires_at: 1 })), /invalid/);
  await assert.rejects(refreshCopilotAccessToken(account, async () => new Response("github-secret", { status: 403 })), /Copilot access/);
  assert.throws(() => authorizationForAccountRequest(account, "https://evil.example/models"), /boundary/);
  assert.throws(() => authorizationForAccountRequest(account, "https://api.githubcopilot.com/copilot_internal/v2/token"), /boundary/);
  assert.equal(authorizationForAccountRequest(account, "https://api.githubcopilot.com/models"), "Bearer old-inference-token");
});

test("token renewal coalesces concurrent calls and blocks accounts on failure", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json(tokenResponse()); };
  assert.equal(isTokenRefreshNeeded(account), true);
  assert.equal(isAccountReauthenticationError(account, 401), true);
  const [a, b] = await Promise.all([ensureValidToken(account, {} as any), ensureValidToken(account, {} as any)]);
  assert.equal(requests, 1);
  assert.equal(a, b);
  assert.equal(a.accessToken, "inference-secret");
  globalThis.fetch = async () => new Response("github-secret", { status: 401 });
  const failed = await ensureValidToken(account, {} as any);
  assert.equal(failed.state?.needsTokenRefresh, true);
  assert.ok(failed.state!.authBlockedUntil! > Date.now());
  assert.equal(failed.state?.lastError?.includes("github-secret"), false);
});

test("Copilot headers distinguish user prompts, tool continuations, and images", () => {
  const user = buildCopilotHeaders("inference", { input: "hello" });
  assert.equal(user["x-initiator"], "user");
  assert.equal(user.authorization, "Bearer inference");
  assert.equal(user["copilot-integration-id"], "vscode-chat");
  assert.equal(buildCopilotHeaders("inference", { messages: [{ role: "user", content: "hello" }] })["x-initiator"], "user");
  const tool = buildCopilotHeaders("inference", { messages: [{ role: "user", content: [{ type: "image_url" }] }, { role: "tool", content: "done" }] });
  assert.equal(tool["x-initiator"], "agent");
  assert.equal(tool["copilot-vision-request"], "true");
  assert.equal(buildCopilotHeaders("inference", { input: [{ type: "function_call_output", output: "done" }] })["x-initiator"], "agent");
});

test("model discovery filters policies and unsupported protocols and normalizes capabilities", () => {
  const entries = copilotModelEntries({ data: [
    { id: "chat", supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", limits: { max_context_window_tokens: 128000, max_output_tokens: 16000 }, supports: { tool_calls: true } } },
    { id: "response", supported_endpoints: ["/responses"] },
    { id: "legacy" },
    { id: "disabled", policy: { state: "disabled" } },
    { id: "hidden", model_picker_enabled: false },
    { id: "embedding", capabilities: { type: "embeddings" } },
    { id: "anthropic-only", supported_endpoints: ["/v1/messages"] },
    { id: "unknown", supported_endpoints: [] },
  ] });
  assert.deepEqual(entries.map(e => [e.id, e.upstreamMode]), [["chat", "chat/completions"], ["response", "responses"], ["legacy", "chat/completions"]]);
  assert.equal(entries[0].context_window, 128000);
  assert.equal(entries[0].max_output_tokens, 16000);
});

test("Copilot quota uses the GitHub OAuth token and never probes ChatGPT", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.github.com/copilot_internal/user");
    assert.equal(new Headers(init?.headers).get("authorization"), "token github-secret");
    return Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 80 } } });
  };
  assert.equal(normalizeProvider(account), "github-copilot");
  const result = await refreshUsageIfNeeded({ ...account }, "https://api.githubcopilot.com", true);
  assert.equal(result.usage?.quotaStatus, "available");
  assert.equal(result.usage?.credits?.usedPercent, 20);
});
