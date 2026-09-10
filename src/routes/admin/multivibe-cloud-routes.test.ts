import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import type { MultivibeCloudService } from "../../multivibe-cloud.js";
import type { ManagedTeamEnrollmentService } from "../../managed-team-enrollment.js";

const flowId = "00000000-0000-4000-8000-000000000001";
type CloudRoutesStub = Pick<
  MultivibeCloudService,
  "getStatus" | "startConnection" | "completeConnection" | "failConnection" | "disconnect"
>;

function options(multivibeCloud: Partial<CloudRoutesStub>): AdminRoutesOptions {
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
    multivibeCloud: multivibeCloud as MultivibeCloudService,
  };
}

async function withServer(
  multivibeCloud: Partial<CloudRoutesStub>,
  run: (baseUrl: string) => Promise<void>,
  store?: AdminRoutesOptions["store"],
) {
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter({ ...options(multivibeCloud), ...(store ? { store } : {}) }));
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

test("Cloud status is exposed without depending on Host mode", async () => {
  await withServer({
    async getStatus() {
      return { status: "disconnected", topupUrl: "https://app.multivibe.cloud/billing" };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/cloud`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "disconnected",
      topupUrl: "https://app.multivibe.cloud/billing",
    });
  });
});

test("Cloud callback rejects malformed state and accepts only the expected query shape", async () => {
  const completed: string[] = [];
  await withServer({
    async completeConnection(state: string, code: string) {
      completed.push(`${state}:${code}`);
    },
    async failConnection() {},
  }, async (baseUrl) => {
    const malformed = await fetch(`${baseUrl}/admin/cloud/oauth/callback?state=bad&code=valid-code`, { redirect: "manual" });
    assert.equal(malformed.status, 303);
    assert.equal(malformed.headers.get("location"), "/?tab=accounts&cloud=error");

    const unexpected = await fetch(`${baseUrl}/admin/cloud/oauth/callback?state=${flowId}&code=valid-code&extra=1`, { redirect: "manual" });
    assert.equal(unexpected.status, 303);
    assert.equal(unexpected.headers.get("location"), "/?tab=accounts&cloud=error");
    assert.deepEqual(completed, []);

    const valid = await fetch(`${baseUrl}/admin/cloud/oauth/callback?state=${flowId}&code=valid-code`, { redirect: "manual" });
    assert.equal(valid.status, 303);
    assert.equal(valid.headers.get("location"), "/?tab=accounts&cloud=connected");
    assert.deepEqual(completed, [`${flowId}:valid-code`]);
  });
});

test("Cloud disconnect invokes the service and reports failures", async () => {
  let calls = 0;
  await withServer({
    async disconnect() {
      calls += 1;
      if (calls === 2) throw new Error("storage unavailable");
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/cloud/disconnect`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const failure = await fetch(`${baseUrl}/admin/cloud/disconnect`, { method: "POST" });
    assert.equal(failure.status, 503);
    assert.equal(calls, 2);
  });
});

test("Initial account listing includes the managed Cloud provider with redacted credentials", async () => {
  const account = {
    id: "multivibe-cloud", provider: "openai-compatible", multivibeCloud: true,
    enabled: true, accessToken: "cloud-secret-access-token",
  };
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/accounts`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].multivibeCloud, true);
    assert.equal(body.accounts[0].id, account.id);
    assert.notEqual(body.accounts[0].accessToken, account.accessToken);
  }, { async listAccounts() { return [account]; } } as AdminRoutesOptions["store"]);
});

test("managed Team enrollment status is exposed only through its redacted projection", async () => {
  const status = {
    schemaVersion: "multivibe-managed-enrollment-status-v1", state: "enrolled", profileId: flowId,
    organizationId: "10000000-0000-4000-8000-000000000001", membershipId: "20000000-0000-4000-8000-000000000002",
    instanceId: "30000000-0000-4000-8000-000000000003", managementChannel: "device",
    enrollmentId: "40000000-0000-4000-8000-000000000004", teamKeyPrefix: "mvt_redacted", enrolledAt: Date.now(),
  } as const;
  const app = express();
  app.use("/admin", createAdminRouter({ ...options({}), managedTeamEnrollment: { status: async () => status } as unknown as ManagedTeamEnrollmentService }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/admin/team/managed-enrollment`);
    assert.equal(response.status, 200);assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();assert.equal(text.includes("mvmb_"), false);assert.equal(text.includes("mvir_"), false);assert.equal(text.includes("instanceAccessToken"), false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
