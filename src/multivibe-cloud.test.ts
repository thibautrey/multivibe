import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AccountStore, OAuthStateStore } from "./store.js";
import { MultivibeCloudService } from "./multivibe-cloud.js";
import type { Account, OAuthFlowState, StoreSettings } from "./types.js";

const projectId = "00000000-0000-4000-8000-000000000001";

function fakeStores(initial: {
  settings?: StoreSettings;
  accounts?: Account[];
} = {}) {
  let settings = { ...(initial.settings ?? {}) };
  let accounts = [...(initial.accounts ?? [])];
  const states = new Map<string, OAuthFlowState>();
  const settingsPatches: Partial<StoreSettings>[] = [];
  const store = {
    async getSettings() { return settings; },
    async patchSettings(patch: Partial<StoreSettings>) {
      settingsPatches.push(patch);
      settings = { ...settings, ...patch };
      return settings;
    },
    async listAccounts() { return [...accounts]; },
    async upsertAccount(account: Account) {
      const index = accounts.findIndex((candidate) => candidate.id === account.id);
      if (index === -1) accounts.push(account);
      else accounts[index] = account;
      return account;
    },
    async patchAccount(id: string, patch: Partial<Account>) {
      const index = accounts.findIndex((candidate) => candidate.id === id);
      if (index === -1) throw new Error("account not found");
      accounts[index] = { ...accounts[index]!, ...patch };
      return accounts[index]!;
    },
    async flushIfDirty() {},
  } as unknown as AccountStore;
  const oauthStore = {
    async create(state: OAuthFlowState) { states.set(state.id, state); },
    async get(id: string) { return states.get(id); },
    async update(id: string, patch: Partial<OAuthFlowState>) {
      const current = states.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      states.set(id, next);
      return next;
    },
  } as unknown as OAuthStateStore;
  return {
    store,
    oauthStore,
    states,
    settingsPatches,
    get settings() { return settings; },
    get accounts() { return accounts; },
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function service(
  stores: ReturnType<typeof fakeStores>,
  fetchImpl: typeof fetch,
  privacyMode: "standard" | "confidential_verified" = "standard",
) {
  return new MultivibeCloudService(stores.store, stores.oauthStore, {
    authBaseUrl: "https://auth.example.test",
    apiBaseUrl: "https://app.example.test",
    inferenceBaseUrl: "https://api.example.test",
    redirectUri: "http://127.0.0.1:1455/admin/cloud/oauth/callback",
    topupUrl: "https://app.example.test/billing",
    privacyMode,
    fetchImpl,
  });
}

test("Cloud connection persists confidential mode on an existing managed account", async () => {
  const stores = fakeStores({
    settings: { multivibeCloud: { accessToken: "cloud-access", projectId } },
    accounts: [{
      id: "multivibe-cloud",
      provider: "openai-compatible",
      accessToken: "mvk_cloud_secret",
      baseUrl: "https://api.example.test",
      enabled: true,
      location: "cloud",
      multivibeCloud: true,
      expiresAt: Date.now() + 2 * 86_400_000,
    }],
  });
  const cloud = service(stores, async (input) => {
    if (String(input).endsWith("/client/v1/credits")) return response({ totalAvailableUsd: "1" });
    if (String(input).endsWith("/client/v1/billing/subscription")) return response({ data: null });
    throw new Error("unexpected Cloud call");
  }, "confidential_verified");

  assert.equal((await cloud.getStatus()).status, "connected");
  assert.equal(stores.accounts[0]?.privacyMode, "confidential_verified");
});

test("Cloud connection uses PKCE and provisions a local API-key account", async () => {
  const stores = fakeStores();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cloud = service(stores, async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/oauth/token")) {
      return response({ access_token: "cloud-access", refresh_token: "cloud-refresh", expires_in: 3600 });
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/client/v1/projects" && init?.method === "GET") return response({ data: [] });
    if (parsedUrl.pathname === "/client/v1/projects" && init?.method === "POST") return response({ id: projectId });
    if (url.includes(`/client/v1/projects/${projectId}/api-keys`)) {
      return response({
        secret: "mvk_cloud_secret",
        apiKey: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      });
    }
    throw new Error(`unexpected Cloud call: ${url}`);
  });

  const started = await cloud.startConnection("http://192.168.1.149:1455");
  const authorizeUrl = new URL(started.authorizeUrl);
  const flow = stores.states.get(started.flowId)!;
  assert.equal(authorizeUrl.pathname, "/oauth/authorize");
  assert.equal(authorizeUrl.searchParams.get("client_id"), "multivibe-core");
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://192.168.1.149:1455/admin/cloud/oauth/callback");
  assert.equal(flow.redirectUri, "http://192.168.1.149:1455/admin/cloud/oauth/callback");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorizeUrl.searchParams.get("scope") ?? "", /(?:^| )provider:read(?: |$)/);
  assert.equal(
    authorizeUrl.searchParams.get("code_challenge"),
    createHash("sha256").update(flow.codeVerifier).digest("base64url"),
  );

  await cloud.completeConnection(started.flowId, "authorization-code");
  const tokenCall = calls.find((call) => call.url.endsWith("/oauth/token"));
  assert.equal(
    new URLSearchParams(String(tokenCall?.init?.body ?? "")).get("redirect_uri"),
    "http://192.168.1.149:1455/admin/cloud/oauth/callback",
  );
  assert.equal(stores.states.get(started.flowId)?.status, "success");
  assert.deepEqual(stores.accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    baseUrl: account.baseUrl,
    accessToken: account.accessToken,
    location: account.location,
    multivibeCloud: account.multivibeCloud,
  })), [{
    id: "multivibe-cloud",
    provider: "openai-compatible",
    baseUrl: "https://api.example.test",
    accessToken: "mvk_cloud_secret",
    location: "cloud",
    multivibeCloud: true,
  }]);
  assert.equal(stores.settings.multivibeCloud?.projectId, projectId);
  assert.equal(calls.filter((call) => call.init?.method === "POST").length, 3);
});

test("Cloud connection rejects non-local-host callback origins", async () => {
  const stores = fakeStores();
  const cloud = service(stores, async () => response({}));
  await assert.rejects(
    () => cloud.startConnection("https://core.example.test"),
    /must use an IP address or localhost/,
  );
  await assert.rejects(
    () => cloud.startConnection("http://192.168.1.149:1455/admin"),
    /must be an HTTP\(S\) origin/,
  );
});

test("Cloud status reports balance and subscription without exposing the API key", async () => {
  const stores = fakeStores({
    settings: {
      multivibeCloud: {
        accessToken: "cloud-access",
        projectId,
      },
    },
    accounts: [{
      id: "multivibe-cloud",
      provider: "openai-compatible",
      accessToken: "mvk_cloud_secret",
      baseUrl: "https://api.example.test",
      enabled: true,
      location: "cloud",
      multivibeCloud: true,
      expiresAt: Date.now() + 2 * 86_400_000,
    }],
  });
  const seen: string[] = [];
  const cloud = service(stores, async (input, init) => {
    seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    if (String(input).endsWith("/client/v1/credits")) return response({ totalAvailableUsd: "12.50" });
    if (String(input).endsWith("/client/v1/billing/subscription")) return response({ data: { planCode: "credit-50", state: "active" } });
    if (String(input).endsWith("/client/v1/auto-recharge")) return response({ current: { state: "active", thresholdUsd: "5", rechargeUsd: "20" }, monetaryEffectsApplied: true });
    if (String(input).endsWith("/provider/v1/earnings")) return response({ currency: "USD", lifetimeNetUsd: "120", monthNetUsd: "45", averageMonthlyNetUsd: "30", monetaryEffectsApplied: true });
    throw new Error("unexpected Cloud call");
  });

  const status = await cloud.getStatus();
  assert.deepEqual(status, {
    status: "connected",
    balanceUsd: "12.50",
    subscription: "Credit 50",
    apiKeyExpiresAt: new Date(stores.accounts[0]!.expiresAt!).toISOString(),
    topupUrl: "https://app.example.test/billing",
    autoTopup: { enabled: true, thresholdUsd: "5", rechargeUsd: "20" },
    workerEarnings: { currency: "USD", lifetimeNetUsd: "120", monthNetUsd: "45", averageMonthlyNetUsd: "30" },
  });
  assert.equal(seen.length, 4);
  assert.equal(seen.every((entry) => entry.endsWith("Bearer cloud-access")), true);
  assert.equal(JSON.stringify(status).includes("mvk_cloud_secret"), false);
});

test("Cloud status rotates an expired OAuth session and keeps the local API key", async () => {
  const stores = fakeStores({
    settings: {
      multivibeCloud: {
        accessToken: "expired-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1_000,
        projectId,
      },
    },
    accounts: [{
      id: "multivibe-cloud",
      provider: "openai-compatible",
      accessToken: "mvk_cloud_secret",
      baseUrl: "https://api.example.test",
      enabled: true,
      location: "cloud",
      multivibeCloud: true,
      expiresAt: Date.now() + 2 * 86_400_000,
    }],
  });
  const calls: string[] = [];
  const cloud = service(stores, async (input, init) => {
    const url = String(input);
    calls.push(`${url} ${init?.method ?? "GET"}`);
    if (url.endsWith("/oauth/token")) return response({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
    if (url.endsWith("/client/v1/credits")) return response({ totalAvailableUsd: "0" });
    if (url.endsWith("/client/v1/billing/subscription")) return response({ data: null });
    throw new Error(`unexpected Cloud call: ${url}`);
  });

  const status = await cloud.getStatus();
  assert.equal(status.status, "connected");
  assert.equal(status.balanceUsd, "0");
  assert.equal(stores.settings.multivibeCloud?.accessToken, "rotated-access");
  assert.equal(stores.settings.multivibeCloud?.refreshToken, "rotated-refresh");
  assert.deepEqual(stores.accounts[0]?.accessToken, "mvk_cloud_secret");
  assert.equal(calls[0]?.endsWith("/oauth/token POST"), true);
});

test("Cloud status offers reconnection when project provisioning requires fresh authentication", async () => {
  const stores = fakeStores({
    settings: { multivibeCloud: { accessToken: "stale-cloud-access" } },
  });
  const calls: string[] = [];
  const cloud = service(stores, async (input, init) => {
    const url = String(input);
    calls.push(`${new URL(url).pathname} ${init?.method ?? "GET"}`);
    if (url.includes("/client/v1/projects?limit=50")) {
      return response({ data: [{ id: projectId, name: "Default", slug: "default" }] });
    }
    if (url.endsWith("/client/v1/projects") && init?.method === "POST") {
      return response({
        error: {
          code: "fresh_authentication_required",
          message: "Fresh authentication is required",
        },
      }, 403);
    }
    throw new Error(`unexpected Cloud call: ${url}`);
  });

  assert.deepEqual(await cloud.getStatus(), {
    status: "disconnected",
    topupUrl: "https://app.example.test/billing",
  });
  assert.deepEqual(calls, ["/client/v1/projects GET", "/client/v1/projects POST"]);
  assert.equal(stores.accounts.length, 0);
});

test("Cloud status keeps unrelated authorization failures unavailable", async () => {
  const stores = fakeStores({
    settings: { multivibeCloud: { accessToken: "cloud-access", projectId } },
  });
  const cloud = service(stores, async (input) => {
    if (String(input).includes(`/client/v1/projects/${projectId}/api-keys`)) {
      return response({ error: { code: "project_access_denied" } }, 403);
    }
    throw new Error(`unexpected Cloud call: ${String(input)}`);
  });

  assert.equal((await cloud.getStatus()).status, "unavailable");
});

test("Cloud status does not turn shadow money into user notifications", async () => {
  const stores = fakeStores({
    settings: { multivibeCloud: { accessToken: "cloud-access", projectId } },
    accounts: [{
      id: "multivibe-cloud", provider: "openai-compatible", accessToken: "key",
      baseUrl: "https://api.example.test", enabled: true, location: "cloud",
      multivibeCloud: true, expiresAt: Date.now() + 2 * 86_400_000,
    }],
  });
  const cloud = service(stores, async (input) => {
    const url = String(input);
    if (url.endsWith("/client/v1/credits")) return response({ totalAvailableUsd: "5.25" });
    if (url.endsWith("/client/v1/billing/subscription")) return response({ data: null });
    if (url.endsWith("/client/v1/auto-recharge")) return response({
      current: { state: "active", thresholdUsd: "5", rechargeUsd: "20" },
      monetaryEffectsApplied: false,
    });
    if (url.endsWith("/provider/v1/earnings")) return response({
      currency: "USD", lifetimeNetUsd: "100", monthNetUsd: "100", averageMonthlyNetUsd: "100",
      monetaryEffectsApplied: false,
    });
    throw new Error("unexpected Cloud call");
  });
  const status = await cloud.getStatus();
  assert.equal(status.autoTopup, undefined);
  assert.equal(status.workerEarnings, undefined);
});
