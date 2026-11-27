import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "./store.js";
import type { Account, ModelAlias } from "./types.js";

test("a mutation arriving during a flush is included before the flush resolves", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  store.markAccountModified("one", {
    id: "one",
    accessToken: "token-one",
    enabled: true,
  });
  const flushing = store.flushIfDirty();
  store.markAccountModified("two", {
    id: "two",
    accessToken: "token-two",
    enabled: true,
  });
  await flushing;

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(
    persisted.accounts.map((account: { id: string }) => account.id).sort(),
    ["one", "two"],
  );
  assert.equal(store.getPersistenceStatus().dirty, false);

  await fs.rm(directory, { recursive: true, force: true });
});

test("token CAS rejects stale writers and preserves unrelated account fields", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();
  await store.addOrUpdate({
    id: "account",
    provider: "openai",
    accessToken: "access-before",
    refreshToken: "refresh-before",
    enabled: true,
    priority: 5,
    state: { lastError: "keep-me", needsTokenRefresh: true },
  });

  const revision = store.getRevision();
  assert.deepEqual(
    store.patchAccountTokenIfCurrent("account", "stale-access", {
      accessToken: "must-not-be-written",
      refreshToken: "must-not-be-written",
    }),
    { status: "conflict" },
  );
  assert.equal(store.getRevision(), revision);

  const result = store.patchAccountTokenIfCurrent("account", "access-before", {
    accessToken: "access-after",
    refreshToken: "refresh-after",
    expiresAt: 9_999,
    state: { needsTokenRefresh: false },
  });
  assert.equal(result.status, "updated");
  await store.flushIfDirty();

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.accounts[0].accessToken, "access-after");
  assert.equal(persisted.accounts[0].refreshToken, "refresh-after");
  assert.equal(persisted.accounts[0].priority, 5);
  assert.equal(persisted.accounts[0].enabled, true);
  assert.equal(persisted.accounts[0].state.lastError, "keep-me");
  assert.equal(persisted.accounts[0].state.needsTokenRefresh, false);
});

test("dashboard API keys are persisted and can be revoked", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  await store.addProxyApiKey({
    id: "key-one",
    application: "staging-worker",
    key: "mv_secret",
    createdAt: 1_700_000_000_000,
  });

  const reloaded = new AccountStore(filePath);
  await reloaded.init();
  assert.deepEqual(await reloaded.listProxyApiKeys(), [
    {
      id: "key-one",
      application: "staging-worker",
      key: "mv_secret",
      createdAt: 1_700_000_000_000,
    },
  ]);

  assert.equal(await reloaded.deleteProxyApiKey("key-one"), true);
  assert.equal(await reloaded.deleteProxyApiKey("missing"), false);
  assert.deepEqual(await reloaded.listProxyApiKeys(), []);

  await fs.rm(directory, { recursive: true, force: true });
});

test("Cloudflare Access metadata survives a reload and is found before revocation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  const cloudflareAccess = {
    accountId: "0123456789abcdef0123456789abcdef",
    applicationId: "access-app-id",
    policyId: "policy-id",
    serviceTokenId: "token-id",
    clientId: "client-id.access",
    expiresAt: "2027-01-01T00:00:00Z",
  };
  await store.addProxyApiKey({
    id: "key-cf",
    application: "staging-worker",
    key: "mv_secret",
    createdAt: 1_700_000_000_000,
    cloudflareAccess,
  });

  const reloaded = new AccountStore(filePath);
  await reloaded.init();
  assert.deepEqual(await reloaded.findProxyApiKey("key-cf"), {
    id: "key-cf",
    application: "staging-worker",
    key: "mv_secret",
    createdAt: 1_700_000_000_000,
    cloudflareAccess,
  });
  assert.equal(await reloaded.findProxyApiKey("missing"), undefined);

  await fs.rm(directory, { recursive: true, force: true });
});

test("an admission share survives the round trip the edge reads", async () => {
  // The admin API writes these fields and the Rust edge reads them from the same
  // file. A silent drop on either side would leave the fair share at its default
  // while the dashboard showed the configured value.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  await store.upsertApplicationPolicy({
    application: "hermes-client",
    fairnessWeight: 1,
    maxConcurrentShare: 0.1,
    burst: 0,
    shareWindows: [
      { startHour: 22, endHour: 6, days: [5, 6], multiplier: 3 },
    ],
    webhooks: [],
  });

  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as {
    applicationPolicies: Array<Record<string, unknown>>;
  };
  const written = onDisk.applicationPolicies.find(
    (policy) => policy.application === "hermes-client",
  );
  assert.equal(written?.maxConcurrentShare, 0.1);
  assert.equal(written?.burst, 0);
  assert.deepEqual(written?.shareWindows, [
    { startHour: 22, endHour: 6, days: [5, 6], multiplier: 3 },
  ]);

  await fs.rm(directory, { recursive: true, force: true });
});

test("out-of-range share values are clamped rather than written through", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  await store.upsertApplicationPolicy({
    application: "wild",
    fairnessWeight: 1,
    maxConcurrentShare: 4,
    burst: 99,
    // An empty window is a no-op, not a period that matches nothing.
    shareWindows: [
      { startHour: 9, endHour: 9, multiplier: 2 },
      { startHour: 22, endHour: 6, multiplier: 40 },
    ],
    webhooks: [],
  });

  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as {
    applicationPolicies: Array<Record<string, unknown>>;
  };
  const written = onDisk.applicationPolicies.find((policy) => policy.application === "wild");
  assert.equal(written?.maxConcurrentShare, 1, "a share is a fraction");
  assert.equal(written?.burst, 8, "burst is bounded");
  assert.deepEqual(
    written?.shareWindows,
    [{ startHour: 22, endHour: 6, multiplier: 8 }],
    "the empty window is dropped and the multiplier is bounded",
  );

  await fs.rm(directory, { recursive: true, force: true });
});

test("new and upgraded stores materialize anonymous sharing as future-only and enabled", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  await fs.writeFile(filePath, JSON.stringify({ accounts: [], settings: {} }), { mode: 0o600 });
  const enabledAt = new Date("2026-09-01T12:34:56.000Z");
  const store = new AccountStore(filePath, () => enabledAt);
  await store.init();

  assert.deepEqual(await store.getSettings(), {
    anonymousUsageSharingEnabled: true,
    anonymousUsageSharingEnabledAt: enabledAt.toISOString(),
  });
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.settings.anonymousUsageSharingEnabled, true);
  assert.equal(persisted.settings.anonymousUsageSharingEnabledAt, enabledAt.toISOString());

  const reloaded = new AccountStore(filePath, () => new Date("2026-09-02T00:00:00.000Z"));
  await reloaded.init();
  assert.equal((await reloaded.getSettings()).anonymousUsageSharingEnabledAt, enabledAt.toISOString());
  await fs.rm(directory, { recursive: true, force: true });
});

test("disabling persists immediately and re-enabling starts a new future-only window", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  let now = new Date("2026-09-01T10:00:00.000Z");
  const store = new AccountStore(filePath, () => now);
  await store.init();
  const initialEnabledAt = (await store.getSettings()).anonymousUsageSharingEnabledAt;

  assert.equal((await store.patchSettings({ anonymousUsageSharingEnabled: false })).anonymousUsageSharingEnabled, false);
  now = new Date("2026-09-03T09:00:00.000Z");
  const reenabled = await store.patchSettings({ anonymousUsageSharingEnabled: true });
  assert.equal(reenabled.anonymousUsageSharingEnabled, true);
  assert.equal(reenabled.anonymousUsageSharingEnabledAt, now.toISOString());
  assert.notEqual(reenabled.anonymousUsageSharingEnabledAt, initialEnabledAt);

  now = new Date("2026-09-04T09:00:00.000Z");
  assert.equal(
    (await store.patchSettings({ anonymousUsageSharingEnabled: true })).anonymousUsageSharingEnabledAt,
    reenabled.anonymousUsageSharingEnabledAt,
  );
  await fs.rm(directory, { recursive: true, force: true });
});

test("an existing explicit sharing opt-out remains disabled on upgrade", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  await fs.writeFile(filePath, JSON.stringify({
    accounts: [],
    settings: {
      anonymousUsageSharingEnabled: false,
      anonymousUsageSharingEnabledAt: "2026-08-01T00:00:00.000Z",
    },
  }), { mode: 0o600 });
  const store = new AccountStore(filePath, () => new Date("2026-09-01T00:00:00.000Z"));
  await store.init();
  assert.equal((await store.getSettings()).anonymousUsageSharingEnabled, false);
  await fs.rm(directory, { recursive: true, force: true });
});

test("runtime account telemetry advances persistence without invalidating the catalog", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();

  await store.addOrUpdate({
    id: "openai-account",
    provider: "openai",
    accessToken: "token-one",
    enabled: true,
    location: "cloud",
  });
  const initialPersistenceRevision = store.getRevision();
  const initialCatalogRevision = store.getCatalogRevision();

  // Proxy routing mutates the cached account object in place before persisting
  // lastSelectedAt, so this also guards against reference aliasing.
  const selected = store.getCachedAccounts()[0];
  selected.state = {
    lastSelectedAt: 1_700_000_000_000,
    lastError: "temporary upstream error",
    recentErrors: [
      { at: 1_700_000_000_000, message: "temporary upstream error" },
    ],
  };
  selected.usage = {
    fetchedAt: 1_700_000_000_000,
    secondary: { usedPercent: 25 },
  };
  await store.upsertAccount(selected);

  assert.equal(store.getRevision(), initialPersistenceRevision + 1);
  assert.equal(store.getCatalogRevision(), initialCatalogRevision);

  await store.patchAccount(selected.id, {
    state: { modelBlocks: { "gpt-5.6-sol": { until: 1, reason: "quota" } } },
    usage: { fetchedAt: 1_700_000_000_001, secondary: { usedPercent: 26 } },
  });
  assert.equal(store.getRevision(), initialPersistenceRevision + 2);
  assert.equal(store.getCatalogRevision(), initialCatalogRevision);
});

test("account configuration, membership, and aliases advance the catalog revision", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();

  let account: Account = {
    id: "provider-account",
    provider: "openai",
    email: "before@example.test",
    accessToken: "token-one",
    baseUrl: "https://provider-one.example.test",
    enabled: true,
    priority: 1,
    location: "cloud",
  };
  await store.addOrUpdate(account);
  assert.equal(store.getCatalogRevision(), 1);

  const configurationChanges: Array<Partial<Account>> = [
    { email: "after@example.test" },
    { priority: 2 },
    { enabled: false },
    { provider: "openai-compatible" },
    { baseUrl: "https://provider-two.example.test" },
    { accessToken: "token-two" },
  ];
  for (const patch of configurationChanges) {
    const before = store.getCatalogRevision();
    account = { ...account, ...patch };
    await store.upsertAccount(account);
    assert.equal(store.getCatalogRevision(), before + 1);
  }

  await store.addOrUpdate({
    id: "second-account",
    provider: "mistral",
    accessToken: "token",
    enabled: true,
  });
  assert.equal(store.getCatalogRevision(), 8);
  await store.deleteAccount("second-account");
  assert.equal(store.getCatalogRevision(), 9);

  const alias: ModelAlias = {
    schemaVersion: 2,
    id: "coding",
    enabled: true,
    rules: [
      {
        id: "default",
        candidates: [{ model: "gpt-5.6-sol" }],
        onNoCapacity: "reject",
      },
    ],
  };
  await store.upsertModelAlias(alias);
  assert.equal(store.getCatalogRevision(), 10);

  // Re-saving an identical alias is a durability write, not a catalog change.
  await store.upsertModelAlias(structuredClone(alias));
  assert.equal(store.getCatalogRevision(), 10);
  await store.patchModelAlias(alias.id, { description: "Primary coding model" });
  assert.equal(store.getCatalogRevision(), 11);
  await store.deleteModelAlias(alias.id);
  assert.equal(store.getCatalogRevision(), 12);
});

test("a flush keeps an enrollment key written by the other process", async (t) => {
  // The shipped container runs Node and the Rust edge on the same store file.
  // Rust writes an enrolled application's key directly; Node must not erase it
  // on its next flush. Before the merge, this sequence lost the key in
  // production within seconds, which made enrollment impossible to complete.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  // Simulate the Rust writer: mutate the document on disk, as
  // `AccountStore::add_enrolled_application` does.
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  onDisk.proxyApiKeys = [
    {
      id: "rust-key-id",
      application: "hermes-pilot",
      key: "mvhb_from_rust",
      createdAt: 1,
    },
  ];
  onDisk.applicationPolicies = [
    {
      application: "hermes-pilot",
      fairnessWeight: 1,
      maxConcurrentShare: 0.25,
      burst: 1,
      webhooks: [],
    },
  ];
  await fs.writeFile(filePath, JSON.stringify(onDisk, null, 2));

  // A Node-side mutation triggers a flush that would previously rewrite the
  // document from stale memory and drop the Rust entries.
  await store.addProxyApiKey({
    id: "node-key-id",
    application: "codex-remote",
    key: "mv_node",
    createdAt: 2,
  });

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(
    persisted.proxyApiKeys.map((entry: { application: string }) => entry.application).sort(),
    ["codex-remote", "hermes-pilot"],
  );
  assert.deepEqual(
    persisted.applicationPolicies.map((policy: { application: string }) => policy.application),
    ["hermes-pilot"],
  );
  // The merged view is adopted, so later readers in this process see it too.
  assert.deepEqual(
    store.getCachedProxyApiKeys().map((entry) => entry.application).sort(),
    ["codex-remote", "hermes-pilot"],
  );
});

test("a deleted key is not resurrected by the read-before-write merge", async (t) => {
  // Revocation must stay durable: the merge adopts entries it has never seen,
  // which would otherwise re-adopt a key the operator just deleted from a
  // document the other process still holds.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();
  await store.addProxyApiKey({
    id: "revoke-me",
    application: "revoke-me",
    key: "mv_revoke",
    createdAt: 1,
  });
  assert.equal(await store.deleteProxyApiKey("revoke-me"), true);

  // The other process rewrites the document with its older copy still present.
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  onDisk.proxyApiKeys = [
    { id: "revoke-me", application: "revoke-me", key: "mv_revoke", createdAt: 1 },
  ];
  await fs.writeFile(filePath, JSON.stringify(onDisk, null, 2));

  await store.addProxyApiKey({
    id: "keep-me",
    application: "keep-me",
    key: "mv_keep",
    createdAt: 3,
  });

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(
    persisted.proxyApiKeys.map((entry: { application: string }) => entry.application),
    ["keep-me"],
  );
});

test("a key enrolled by the other process can be revoked", async (t) => {
  // Enrollment writes the key from the Rust edge, after this process loaded the
  // store. Deleting from memory alone reported 404 for a credential that was
  // still valid, so offboarding silently failed and the key kept authenticating.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  // The edge enrolls a machine: the document changes, this process does not know.
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  onDisk.proxyApiKeys = [
    { id: "enrolled-id", application: "hermes-client", key: "mvhb_x", createdAt: 1 },
  ];
  await fs.writeFile(filePath, JSON.stringify(onDisk, null, 2));

  // Revocation must find it, not claim it does not exist.
  assert.equal(await store.deleteProxyApiKey("enrolled-id"), true);

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(persisted.proxyApiKeys, []);
  // And a second delete is honestly a 404, not a silent success.
  assert.equal(await store.deleteProxyApiKey("enrolled-id"), false);
});

test("an application policy can be deleted, and stays deleted", async (t) => {
  // Revoking a key used to leave its policy behind with no way to remove it, so
  // an offboarded client kept a share reservation in every admission decision.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  // Enrollment writes the policy from the Rust edge, after this process started.
  const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
  onDisk.applicationPolicies = [
    { application: "offboarded", fairnessWeight: 1, maxConcurrentShare: 0.25, webhooks: [] },
    { application: "keep", fairnessWeight: 1, webhooks: [] },
  ];
  await fs.writeFile(filePath, JSON.stringify(onDisk, null, 2));

  assert.equal(await store.deleteApplicationPolicy("offboarded"), true);
  assert.deepEqual(
    store.getCachedApplicationPolicies().map((policy) => policy.application),
    ["keep"],
  );
  // A second delete is an honest 404, and the merge must not resurrect it.
  assert.equal(await store.deleteApplicationPolicy("offboarded"), false);
  await store.addProxyApiKey({ id: "x", application: "other", key: "mv_x", createdAt: 1 });
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(
    persisted.applicationPolicies.map((policy: { application: string }) => policy.application),
    ["keep"],
  );
});

test("usage spends the period allowance before the prepaid wallet", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();
  const periodStart = "2026-11-01T00:00:00.000Z";
  await store.addUser({
    id: "usr_wallet",
    email: "wallet@example.com",
    role: "member",
    status: "active",
    quota: { period: "month", creditUsd: 2 },
    usage: { periodStart, requests: 0, tokens: 0, costUsd: 0 },
    walletUsd: 10,
    createdAt: 1,
    updatedAt: 1,
  });

  // Covered by the allowance: the wallet is untouched.
  store.recordUserUsage("usr_wallet", { requests: 1, tokens: 100, costUsd: 1.25 });
  let user = await store.findUser("usr_wallet");
  assert.equal(user?.usage.grantedCostUsd, 1.25);
  assert.equal(user?.walletUsd, 10);

  // Crosses the allowance: the excess is debited from the wallet.
  store.recordUserUsage("usr_wallet", { requests: 1, tokens: 100, costUsd: 1 });
  user = await store.findUser("usr_wallet");
  assert.equal(user?.usage.grantedCostUsd, 2);
  assert.equal(user?.walletUsd, 9.75);
  assert.equal(user?.usage.costUsd, 2.25);

  // A rollover resets the allowance counters but never the wallet.
  await store.patchUser("usr_wallet", {
    usage: { periodStart: "2026-10-01T00:00:00.000Z", requests: 9, tokens: 900, costUsd: 9, grantedCostUsd: 2 },
  });
  store.recordUserUsage("usr_wallet", { requests: 1, tokens: 10, costUsd: 0.5 });
  user = await store.findUser("usr_wallet");
  assert.equal(user?.walletUsd, 9.75);
  assert.equal(user?.usage.grantedCostUsd, 0.5);
  assert.equal(user?.usage.costUsd, 0.5);
});

test("a wallet-only account consumes the wallet and stops at zero", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();
  await store.addUser({
    id: "usr_only",
    email: "only@example.com",
    role: "member",
    status: "active",
    quota: { period: "month" },
    usage: { periodStart: "2026-11-01T00:00:00.000Z", requests: 0, tokens: 0, costUsd: 0 },
    walletUsd: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  store.recordUserUsage("usr_only", { requests: 1, tokens: 10, costUsd: 1.4 });
  const user = await store.findUser("usr_only");
  // The small overshoot is kept as a negative balance, then blocks.
  assert.equal(user?.walletUsd, -0.4);
  assert.equal(user?.usage.grantedCostUsd, 0);

  const view = await store.findUser("usr_only");
  assert.equal(view?.walletUsd, -0.4);
});

test("a broker payment credits the wallet once and survives a ledger rotation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();
  await store.addUser({
    id: "usr_paid",
    email: "paid@example.com",
    role: "member",
    status: "active",
    quota: { period: "month" },
    usage: { periodStart: "2026-11-01T00:00:00.000Z", requests: 0, tokens: 0, costUsd: 0 },
    createdAt: 1,
    updatedAt: 1,
  });

  const first = await store.creditWalletFromPayment("usr_paid", {
    paymentId: "pay_1",
    creditUsd: 10,
  });
  assert.equal(first?.applied, true);
  assert.equal(first?.user.walletUsd, 10);

  // A replayed webhook or a return page refresh uses the same payment id.
  const replay = await store.creditWalletFromPayment("usr_paid", {
    paymentId: "pay_1",
    creditUsd: 10,
  });
  assert.equal(replay?.applied, false);

  // Even after 500 newer ledger entries rotate the payment out of the ledger,
  // the idempotency map still blocks a second credit.
  for (let index = 0; index < 520; index += 1) {
    await store.adjustUserWallet("usr_paid", 0.01, { kind: "adjust" });
  }
  const user = await store.findUser("usr_paid");
  assert.equal(user?.creditLedger?.length, 500);
  assert.equal(user?.creditLedger?.some((entry) => entry.paymentId === "pay_1"), false);
  const late = await store.creditWalletFromPayment("usr_paid", {
    paymentId: "pay_1",
    creditUsd: 10,
  });
  assert.equal(late?.applied, false);
  assert.equal((await store.findUser("usr_paid"))?.walletUsd, 15.2);
});

test("refunds are proportional, monotonic and can overdraw the wallet", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();
  await store.addUser({
    id: "usr_refund",
    email: "refund@example.com",
    role: "member",
    status: "active",
    quota: { period: "month" },
    usage: { periodStart: "2026-11-01T00:00:00.000Z", requests: 0, tokens: 0, costUsd: 0 },
    createdAt: 1,
    updatedAt: 1,
  });
  // A bonus makes credit (12) larger than the paid amount (10 EUR).
  await store.creditWalletFromPayment("usr_refund", { paymentId: "pay_2", creditUsd: 12 });
  await store.adjustUserWallet("usr_refund", -11, { kind: "debit" });
  assert.equal((await store.findUser("usr_refund"))?.walletUsd, 1);

  const partial = await store.refundWalletFromPayment("usr_refund", {
    paymentId: "pay_2",
    amountCents: 1000,
    refundedCents: 250,
  });
  assert.equal(partial?.amountUsd, 3);
  assert.equal((await store.findUser("usr_refund"))?.walletUsd, -2);

  // Replaying the same partial refund changes nothing.
  const replay = await store.refundWalletFromPayment("usr_refund", {
    paymentId: "pay_2",
    amountCents: 1000,
    refundedCents: 250,
  });
  assert.equal(replay?.applied, false);

  // A dispute returns the rest.
  const dispute = await store.refundWalletFromPayment("usr_refund", {
    paymentId: "pay_2",
    amountCents: 1000,
    refundedCents: 1000,
    disputed: true,
  });
  assert.equal(dispute?.amountUsd, 9);
  assert.equal((await store.findUser("usr_refund"))?.walletUsd, -11);
});
