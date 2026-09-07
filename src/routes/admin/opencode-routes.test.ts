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

test("account listing never exposes OpenCode inference keys or credential headers", async () => {
  const account = {
    id: "console", provider: "opencode", enabled: true, accessToken: "session-secret-value",
    opencodeApiKey: "inference-secret-value",
    opencodeHeaders: { "x-custom-key": "header-secret-value" },
    opencodeOrgId: "org_selected",
  };
  const store = { listAccounts: async () => [account] } as unknown as AdminRoutesOptions["store"];
  await withServer(options({ store }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/accounts`);
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const secret of [account.accessToken, account.opencodeApiKey, account.opencodeHeaders["x-custom-key"]]) {
      assert.equal(text.includes(secret), false);
    }
    assert.equal(JSON.parse(text).accounts[0].opencodeOrgId, "org_selected");
    assert.equal(account.opencodeApiKey, "inference-secret-value");
  });
});
