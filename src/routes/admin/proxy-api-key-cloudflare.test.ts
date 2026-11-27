import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import type { StoredProxyApiKey } from "../../types.js";

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

async function withServer(
  adminOptions: AdminRoutesOptions,
  run: (baseUrl: string) => Promise<void>,
) {
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function credential() {
  return {
    accountId: "0123456789abcdef0123456789abcdef",
    applicationId: "access-app-id",
    policyId: "policy-id",
    serviceTokenId: "token-id",
    clientId: "client-id.access",
    expiresAt: "2027-01-01T00:00:00Z",
  };
}

function memoryStore() {
  const keys: StoredProxyApiKey[] = [];
  return {
    keys,
    getCachedProxyApiKeys: () => keys.map((entry) => ({ ...entry })),
    listProxyApiKeys: async () => keys.map((entry) => ({ ...entry })),
    findProxyApiKey: async (id: string) => {
      const entry = keys.find((candidate) => candidate.id === id);
      return entry ? { ...entry } : undefined;
    },
    addProxyApiKey: async (entry: StoredProxyApiKey) => {
      keys.push({ ...entry });
      return { ...entry };
    },
    deleteProxyApiKey: async (id: string) => {
      const index = keys.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      keys.splice(index, 1);
      return true;
    },
  };
}

test("a key can opt into a Cloudflare Access token and revocation follows it", async () => {
  const store = memoryStore();
  const provisioned: string[] = [];
  const revoked: string[] = [];
  const cloudflareAccess = {
    describe: () => ({
      provisioningEnabled: true,
      configured: true,
      applications: ["staging-worker"],
    }),
    canManage: (application: string) => application === "staging-worker",
    provision: async (application: string, name: string) => {
      provisioned.push(`${application}:${name}`);
      return { credential: credential(), clientSecret: "secret-shown-once" };
    },
    revoke: async (entry: { serviceTokenId: string }) => {
      revoked.push(entry.serviceTokenId);
      return { policyDeleted: true };
    },
  };

  await withServer(
    options({ store: store as unknown as AdminRoutesOptions["store"], cloudflareAccess }),
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/admin/proxy-api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          application: "staging-worker",
          provisionCloudflareAccess: true,
        }),
      });
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as any;
      assert.equal(createdBody.proxyApiKey.cloudflareAccess.clientSecret, "secret-shown-once");
      assert.equal(createdBody.proxyApiKey.cloudflareAccess.clientId, "client-id.access");
      assert.equal(provisioned.length, 1);
      assert.match(provisioned[0], /^staging-worker:multivibe-staging-worker-/);
      // The secret is never part of the persisted key.
      assert.equal("clientSecret" in store.keys[0].cloudflareAccess!, false);
      assert.equal(store.keys[0].cloudflareAccess?.serviceTokenId, "token-id");

      const listed = await fetch(`${baseUrl}/admin/proxy-api-keys`);
      const listedBody = (await listed.json()) as any;
      assert.equal(listedBody.proxyApiKeys[0].cloudflareAccess.clientSecret, undefined);
      assert.equal(listedBody.proxyApiKeys[0].cloudflareAccess.clientId, "client-id.access");

      const revokedResponse = await fetch(
        `${baseUrl}/admin/proxy-api-keys/${encodeURIComponent(store.keys[0].id)}`,
        { method: "DELETE" },
      );
      assert.equal(revokedResponse.status, 200);
      assert.deepEqual(revoked, ["token-id"]);
      assert.equal(store.keys.length, 0);
    },
  );
});

test("a key without the flag provisions nothing", async () => {
  const store = memoryStore();
  let provisioned = false;
  const cloudflareAccess = {
    describe: () => ({
      provisioningEnabled: true,
      configured: true,
      applications: ["staging-worker"],
    }),
    canManage: () => true,
    provision: async () => {
      provisioned = true;
      return { credential: credential(), clientSecret: "secret" };
    },
    revoke: async () => ({ policyDeleted: true }),
  };

  await withServer(
    options({ store: store as unknown as AdminRoutesOptions["store"], cloudflareAccess }),
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/admin/proxy-api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ application: "staging-worker" }),
      });
      assert.equal(created.status, 201);
      assert.equal(provisioned, false);
      assert.equal(store.keys[0].cloudflareAccess, undefined);
      assert.equal(
        ((await created.json()) as any).proxyApiKey.cloudflareAccess,
        undefined,
      );
    },
  );
});

test("a failed Cloudflare revocation keeps the local key", async () => {
  const store = memoryStore();
  store.keys.push({
    id: "key-id",
    application: "staging-worker",
    key: "mv_secret",
    createdAt: 1,
    cloudflareAccess: credential(),
  });
  const cloudflareAccess = {
    describe: () => ({
      provisioningEnabled: true,
      configured: true,
      applications: ["staging-worker"],
    }),
    canManage: () => true,
    provision: async () => ({ credential: credential(), clientSecret: "secret" }),
    revoke: async () => {
      throw new Error("Cloudflare API DELETE failed (500): outage");
    },
  };

  await withServer(
    options({ store: store as unknown as AdminRoutesOptions["store"], cloudflareAccess }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/proxy-api-keys/key-id`, {
        method: "DELETE",
      });
      assert.equal(response.status, 502);
      assert.match(((await response.json()) as any).error, /local key was kept/);
      assert.equal(store.keys.length, 1);
    },
  );
});

test("provisioning is refused when the feature is disabled", async () => {
  const store = memoryStore();
  await withServer(
    options({ store: store as unknown as AdminRoutesOptions["store"] }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/proxy-api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          application: "staging-worker",
          provisionCloudflareAccess: true,
        }),
      });
      assert.equal(response.status, 503);
      assert.equal(store.keys.length, 0);
    },
  );
});

test("revocation is refused when a linked key loses provisioning config", async () => {
  const store = memoryStore();
  store.keys.push({
    id: "key-id",
    application: "staging-worker",
    key: "mv_secret",
    createdAt: 1,
    cloudflareAccess: credential(),
  });
  await withServer(
    options({ store: store as unknown as AdminRoutesOptions["store"] }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/proxy-api-keys/key-id`, {
        method: "DELETE",
      });
      assert.equal(response.status, 503);
      assert.equal(store.keys.length, 1);

      // Explicit escape hatch: the operator already deleted the token in
      // Cloudflare and only needs the local key removed.
      const forced = await fetch(
        `${baseUrl}/admin/proxy-api-keys/key-id?force=true`,
        { method: "DELETE" },
      );
      assert.equal(forced.status, 200);
      assert.match(
        ((await forced.json()) as any).warning,
        /without revoking its Cloudflare Access service token/,
      );
      assert.equal(store.keys.length, 0);
    },
  );
});

test("a provisioner missing its API token refuses remote revocation but allows force", async () => {
  const store = memoryStore();
  store.keys.push({
    id: "key-id",
    application: "staging-worker",
    key: "mv_secret",
    createdAt: 1,
    cloudflareAccess: credential(),
  });
  let revokeCalled = false;
  const cloudflareAccess = {
    describe: () => ({
      provisioningEnabled: true,
      configured: false,
      applications: ["staging-worker"],
      error: "CLOUDFLARE_API_TOKEN is not set.",
    }),
    canManage: () => true,
    provision: async () => ({ credential: credential(), clientSecret: "secret" }),
    revoke: async () => {
      revokeCalled = true;
      return { policyDeleted: true };
    },
  };

  await withServer(
    options({
      store: store as unknown as AdminRoutesOptions["store"],
      cloudflareAccess,
    }),
    async (baseUrl) => {
      const refused = await fetch(`${baseUrl}/admin/proxy-api-keys/key-id`, {
        method: "DELETE",
      });
      assert.equal(refused.status, 503);
      assert.match(
        ((await refused.json()) as any).error,
        /CLOUDFLARE_API_TOKEN is not set/,
      );
      assert.equal(revokeCalled, false);
      assert.equal(store.keys.length, 1);

      const forced = await fetch(
        `${baseUrl}/admin/proxy-api-keys/key-id?force=true`,
        { method: "DELETE" },
      );
      assert.equal(forced.status, 200);
      assert.equal(revokeCalled, false);
      assert.equal(store.keys.length, 0);
    },
  );
});
