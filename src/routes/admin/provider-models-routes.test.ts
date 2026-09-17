import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import { ModelsDevCatalog } from "../../ai-sdk/models-dev-catalog.js";
import type { LiveModelCatalogSnapshot, LiveModelCatalogSource } from "../../ai-sdk/live-model-catalog.js";
import type { Account } from "../../types.js";

const providerAccount: Account = {
  id: "anthropic-1",
  provider: "ai-sdk",
  sdkProvider: "anthropic",
  accessToken: "sk-ant-super-secret",
  enabled: true,
};

function options(overrides: Partial<AdminRoutesOptions> = {}): AdminRoutesOptions {
  return {
    store: { listAccounts: async () => [providerAccount] } as unknown as AdminRoutesOptions["store"],
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

function liveCatalog(ids: string[], overrides: Partial<LiveModelCatalogSnapshot> = {}) {
  const calls = { snapshot: 0, refresh: 0 };
  const catalog: LiveModelCatalogSource = {
    async snapshot(): Promise<LiveModelCatalogSnapshot> {
      calls.snapshot += 1;
      return { ids, source: "https://api.anthropic.com/v1/models", fetchedAt: "2026-09-17T10:00:00.000Z", stale: false, ...overrides };
    },
    async refresh(): Promise<LiveModelCatalogSnapshot> {
      calls.refresh += 1;
      return { ids, source: "https://api.anthropic.com/v1/models", fetchedAt: "2026-09-17T10:05:00.000Z", stale: false, ...overrides };
    },
  };
  return { catalog, calls };
}

function runtimeCatalog() {
  const catalog = new ModelsDevCatalog({
    fetch: (async () => Response.json({
      anthropic: {
        models: {
          "claude-live": { id: "claude-live", name: "Claude Live", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 200_000 } },
        },
      },
    })) as typeof fetch,
  });
  return catalog;
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

test("account model listing merges live ids with runtime metadata and never leaks the key", async () => {
  const { catalog, calls } = liveCatalog(["claude-live", "claude-new"]);
  const modelsDevCatalog = runtimeCatalog();
  await modelsDevCatalog.refresh();
  await withServer(options({ liveModelCatalog: catalog, modelsDevCatalog }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/accounts/anthropic-1/models`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /super-secret/);
    const body = JSON.parse(text);
    assert.equal(body.provider, "anthropic");
    assert.equal(body.discovered, true);
    assert.equal(body.live.source, "https://api.anthropic.com/v1/models");
    assert.equal(body.catalog.fetchedAt, new Date(body.catalog.fetchedAt).toISOString());
    assert.deepEqual(body.data.map((model: { id: string }) => model.id), ["anthropic/claude-live", "anthropic/claude-new"]);
    assert.equal(body.data[0].name, "Claude Live");
    assert.equal(body.data[0].context_window, 200_000);
    assert.equal(body.data[1].name, "claude-new");
    assert.equal(calls.snapshot, 1);
    assert.equal(calls.refresh, 0);
  });
});

test("account model refresh forces provider revalidation", async () => {
  const { catalog, calls } = liveCatalog(["claude-refreshed"]);
  await withServer(options({ liveModelCatalog: catalog }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/accounts/anthropic-1/models/refresh`, { method: "POST" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].id, "anthropic/claude-refreshed");
    assert.equal(body.live.fetchedAt, "2026-09-17T10:05:00.000Z");
    assert.equal(calls.refresh, 1);
  });
});

test("account model listing rejects accounts that are not enabled SDK providers", async () => {
  const store = { listAccounts: async () => [{ ...providerAccount, enabled: false }] } as unknown as AdminRoutesOptions["store"];
  await withServer(options({ store }), async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/admin/accounts/anthropic-1/models`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/admin/accounts/missing/models`)).status, 404);
  });
});

test("provider catalog advertises live discovery and runtime metadata", async () => {
  const modelsDevCatalog = runtimeCatalog();
  await modelsDevCatalog.refresh();
  await withServer(options({ modelsDevCatalog }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/provider-catalog`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const anthropic = body.providers.find((provider: { id: string }) => provider.id === "anthropic");
    assert.equal(anthropic.liveDiscovery, true);
    assert.equal(anthropic.source, "https://models.dev/api.json");
    assert.deepEqual(anthropic.models.map((model: { id: string }) => model.id), ["claude-live"]);
    const mammouth = body.providers.find((provider: { id: string }) => provider.id === "mammouth");
    assert.equal(mammouth.liveDiscovery, false);
  });
});
