import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createInternalV1EdgeRouter } from "./internal-v1-edge-routes.js";
import { AccountStore } from "./store.js";

const INTERNAL_TOKEN = "internal-test-token";

async function createHarness() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "multivibe-v1-edge-token-"),
  );
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();
  await store.addOrUpdate({
    id: "openai-account",
    provider: "openai",
    email: "before@example.test",
    accessToken: "access-before",
    refreshToken: "refresh-before",
    expiresAt: 100,
    enabled: true,
    priority: 7,
    state: {
      lastError: "unrelated error",
      needsTokenRefresh: true,
      authBlockedUntil: 123,
    },
  });

  const app = express();
  app.use(express.json());
  app.use(
    "/internal/v1-edge",
    createInternalV1EdgeRouter({ store, internalToken: INTERNAL_TOKEN }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  return {
    directory,
    filePath,
    store,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function persistToken(
  url: string,
  body: unknown,
  token: string | undefined = INTERNAL_TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["x-multivibe-internal-token"] = token;
  return fetch(`${url}/internal/v1-edge/accounts/openai-account/token`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("the v1 edge token endpoint requires the internal token", async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
    await fs.rm(harness.directory, { recursive: true, force: true });
  });

  const body = {
    expectedAccessToken: "access-before",
    accessToken: "must-not-be-written",
    needsTokenRefresh: false,
  };
  assert.equal((await persistToken(harness.url, body, undefined)).status, 401);
  assert.equal((await persistToken(harness.url, body, "wrong-token")).status, 401);
  assert.equal(
    harness.store.getCachedAccounts()[0]?.accessToken,
    "access-before",
  );
});

test("the v1 edge token endpoint validates its payload and account", async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
    await fs.rm(harness.directory, { recursive: true, force: true });
  });

  assert.equal(
    (
      await persistToken(harness.url, {
        accessToken: "missing-cas",
        needsTokenRefresh: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await persistToken(harness.url, {
        expectedAccessToken: "access-before",
        accessToken: "missing-refresh-state",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await persistToken(harness.url, {
        expectedAccessToken: "access-before",
        accessToken: "access-after",
        expiresAt: Number.NaN,
        needsTokenRefresh: false,
      })
    ).status,
    400,
  );
  const missing = await fetch(
    `${harness.url}/internal/v1-edge/accounts/missing/token`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-multivibe-internal-token": INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        expectedAccessToken: "access-before",
        accessToken: "access-after",
        needsTokenRefresh: false,
      }),
    },
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "account_not_found");
});

test("the v1 edge token endpoint rejects a stale CAS without exposing tokens", async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
    await fs.rm(harness.directory, { recursive: true, force: true });
  });

  const response = await persistToken(harness.url, {
    expectedAccessToken: "stale-access",
    accessToken: "must-not-be-written",
    refreshToken: "must-not-be-written-either",
    needsTokenRefresh: false,
  });
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, "stale_access_token");
  assert.equal(text.includes("stale-access"), false);
  assert.equal(text.includes("must-not-be-written"), false);

  const persisted = JSON.parse(await fs.readFile(harness.filePath, "utf8"));
  assert.equal(persisted.accounts[0].accessToken, "access-before");
  assert.equal(persisted.accounts[0].refreshToken, "refresh-before");
});

test("a token CAS conflict flushes the concurrent winning credential", async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
    await fs.rm(harness.directory, { recursive: true, force: true });
  });

  await harness.store.patchAccount("openai-account", {
    accessToken: "admin-winner",
  });
  const response = await persistToken(harness.url, {
    expectedAccessToken: "access-before",
    accessToken: "rust-loser",
    needsTokenRefresh: false,
  });

  assert.equal(response.status, 409);
  const persisted = JSON.parse(await fs.readFile(harness.filePath, "utf8"));
  assert.equal(persisted.accounts[0].accessToken, "admin-winner");
});

test("the v1 edge token endpoint patches only credentials and auth state durably", async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
    await fs.rm(harness.directory, { recursive: true, force: true });
  });

  await harness.store.patchAccount("openai-account", {
    email: "admin-change@example.test",
    priority: 9,
  });
  const response = await persistToken(harness.url, {
    expectedAccessToken: "access-before",
    accessToken: "access-after",
    refreshToken: "refresh-after",
    expiresAt: 9_999,
    chatgptAccountId: "workspace-after",
    email: "refreshed@example.test",
    needsTokenRefresh: false,
    authBlockedUntil: null,
    enabled: false,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");

  const persisted = JSON.parse(await fs.readFile(harness.filePath, "utf8"));
  assert.equal(persisted.accounts[0].accessToken, "access-after");
  assert.equal(persisted.accounts[0].refreshToken, "refresh-after");
  assert.equal(persisted.accounts[0].expiresAt, 9_999);
  assert.equal(persisted.accounts[0].chatgptAccountId, "workspace-after");
  assert.equal(persisted.accounts[0].email, "refreshed@example.test");
  assert.equal(persisted.accounts[0].priority, 9);
  assert.equal(persisted.accounts[0].enabled, true);
  assert.equal(persisted.accounts[0].state.needsTokenRefresh, false);
  assert.equal(persisted.accounts[0].state.authBlockedUntil, undefined);
  assert.equal(persisted.accounts[0].state.lastError, "unrelated error");
  assert.equal((await fs.stat(harness.filePath)).mode & 0o777, 0o600);
});
