import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";

function options(overrides: Partial<AdminRoutesOptions> = {}): AdminRoutesOptions {
  return {
    store: {} as AdminRoutesOptions["store"],
    oauthStore: {} as AdminRoutesOptions["oauthStore"],
    traceManager: { pageSizeMax: 100 } as AdminRoutesOptions["traceManager"],
    codexProjectRegistry: {} as AdminRoutesOptions["codexProjectRegistry"],
    oauthConfig: {} as AdminRoutesOptions["oauthConfig"],
    openaiBaseUrl: "https://example.test",
    mistralBaseUrl: "https://example.test",
    zaiBaseUrl: "https://example.test",
    codexProjectRegistrationToken: "",
    configuredProxyApiKeys: [],
    storagePaths: {
      accountsPath: "/data/accounts.json",
      oauthStatePath: "/data/oauth.json",
      tracePath: "/data/traces.jsonl",
      traceStatsHistoryPath: "/data/trace-stats.jsonl",
      codexProjectsPath: "/data/projects.json",
    },
    ...overrides,
  };
}

async function withServer(adminOptions: AdminRoutesOptions, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(adminOptions));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Copilot device login, pending polling, completion and reauth preserve the account and redact tokens", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const accounts: any[] = [];
  const flows = new Map<string, any>();
  let polls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return original(input, init);
    if (url === "https://github.com/login/device/code") return Response.json({ device_code: "private-device-code", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    if (url === "https://github.com/login/oauth/access_token") {
      polls++;
      assert.equal(JSON.parse(String(init?.body)).device_code, "private-device-code");
      return Response.json(polls === 1 ? { error: "slow_down", interval: 10 } : { access_token: "github-secret" });
    }
    if (url === "https://api.github.com/copilot_internal/v2/token") {
      assert.equal(new Headers(init?.headers).get("authorization"), "token github-secret");
      return Response.json({ token: "inference-secret", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (url === "https://api.github.com/copilot_internal/user") {
      assert.equal(new Headers(init?.headers).get("authorization"), "token github-secret");
      return Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 75 } } });
    }
    assert.fail(`Unexpected request: ${url}`);
  };
  const store = {
    listAccounts: async () => accounts,
    addOrUpdate: async (account: any) => {
      const index = accounts.findIndex(a => a.id === account.id);
      if (index < 0) accounts.push(account); else accounts[index] = account;
    },
  } as unknown as AdminRoutesOptions["store"];
  const oauthStore = {
    create: async (flow: any) => { flows.set(flow.id, flow); },
    get: async (id: string) => flows.get(id),
    update: async (id: string, patch: any) => { const flow = { ...flows.get(id), ...patch }; flows.set(id, flow); return flow; },
  } as unknown as AdminRoutesOptions["oauthStore"];
  await withServer(options({ store, oauthStore }), async baseUrl => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${baseUrl}/admin${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    const started = await post("/oauth/start", { provider: "github-copilot" });
    assert.equal(started.status, 200);
    assert.equal(started.data.method, "device");
    assert.equal(started.data.provider, "github-copilot");
    assert.equal(started.data.verificationUrl, "https://github.com/login/device");
    assert.equal(JSON.stringify(started).includes("private-device-code"), false);
    const flowId = started.data.flowId;
    const pending = await post("/oauth/device/poll", { flowId });
    assert.equal(pending.data.status, "pending");
    assert.equal(pending.data.intervalSeconds, 10);
    assert.equal(flows.get(flowId).intervalSeconds, 10);
    const complete = await post("/oauth/device/poll", { flowId });
    assert.equal(complete.status, 200);
    assert.equal(complete.data.status, "success");
    assert.equal(complete.data.account.provider, "github-copilot");
    assert.equal(complete.data.account.accessToken, "[redacted]");
    assert.equal(complete.data.account.refreshToken, "[redacted]");
    assert.equal(accounts[0].refreshToken, "github-secret");
    assert.equal(accounts[0].accessToken, "inference-secret");
    assert.equal(accounts[0].usage.quotaStatus, "available");
    assert.equal(accounts[0].usage.credits.usedPercent, 25);
    assert.equal(flows.get(flowId).status, "success");
    const repeated = await post("/oauth/device/poll", { flowId });
    assert.equal(repeated.data.status, "success");
    assert.equal(polls, 2);
    assert.equal(accounts.length, 1);
    const listing = await (await fetch(`${baseUrl}/admin/accounts`)).text();
    assert.equal(listing.includes("github-secret"), false);
    assert.equal(listing.includes("inference-secret"), false);
    accounts[0].priority = 9;
    accounts[0].enabled = false;
    const reauth = await post("/oauth/start", { provider: "github-copilot", accountId: accounts[0].id, email: "work" });
    const reauthenticated = await post("/oauth/device/poll", { flowId: reauth.data.flowId });
    assert.equal(reauthenticated.data.account.id, accounts[0].id);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].priority, 9);
    assert.equal(accounts[0].enabled, false);
    const wrongProvider = await post("/oauth/start", { provider: "xai", accountId: accounts[0].id });
    assert.equal(wrongProvider.status, 400);
    const manual = await post("/accounts", { provider: "github-copilot", accessToken: "token" });
    assert.equal(manual.status, 400);
  });
});
