import assert from "node:assert/strict";
import test from "node:test";
import { createUsageRefreshMonitor } from "./usage-refresh-monitor.js";
import { UsageRefreshCoordinator } from "./usage-refresh.js";
import type { Account } from "./types.js";
import type { AccountStore } from "./store.js";
import type { OAuthConfig } from "./oauth.js";

const oauthConfig = {} as OAuthConfig;

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "account-1",
    provider: "openai",
    accessToken: "access-token",
    enabled: true,
    ...overrides,
  };
}

function storeFor(accounts: Account[]) {
  return {
    listAccounts: async () => accounts,
    getCachedAccounts: () => accounts,
    patchAccount: async (id: string, patch: Partial<Account>) => {
      const index = accounts.findIndex((candidate) => candidate.id === id);
      if (index < 0) return null;
      accounts[index] = {
        ...accounts[index],
        ...patch,
        state: { ...accounts[index].state, ...patch.state },
      };
      return accounts[index];
    },
  } as unknown as AccountStore;
}

function monitorOptions(
  store: AccountStore,
  coordinator: UsageRefreshCoordinator,
) {
  return {
    store,
    oauthConfig,
    openaiBaseUrl: "https://chatgpt.example",
    mistralBaseUrl: "https://mistral.example",
    zaiBaseUrl: "https://zai.example",
    coordinator,
    logger: { warn() {}, error() {} },
  };
}

test("refreshes stale accounts without waiting for a request", async () => {
  const accounts = [
    account({ usage: { fetchedAt: Date.now() - 10 * 60_000 } }),
  ];
  const store = storeFor(accounts);
  let calls = 0;
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    calls += 1;
    value.usage = { fetchedAt: Date.now(), primary: { usedPercent: 12 } };
    return value;
  });
  const monitor = createUsageRefreshMonitor(
    monitorOptions(store, coordinator),
  );

  const result = await monitor.refreshNow();
  monitor.stop();

  assert.deepEqual(result, {
    checked: 1,
    refreshed: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(calls, 1);
  assert.equal(accounts[0].usage?.primary?.usedPercent, 12);
});

test("does not probe fresh or scheduled-reset accounts", async () => {
  const now = Date.now();
  const accounts = [
    account({ usage: { fetchedAt: now } }),
    account({
      id: "scheduled",
      usage: { fetchedAt: now - 10 * 60_000 },
      state: {
        scheduledWeeklyReset: {
          scheduledAt: now,
          idempotencyKey: "reset-1",
          thresholdRemainingPercent: 0.5,
        },
      },
    }),
  ];
  const store = storeFor(accounts);
  let calls = 0;
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    calls += 1;
    value.usage = { fetchedAt: Date.now() };
    return value;
  });
  const monitor = createUsageRefreshMonitor(
    monitorOptions(store, coordinator),
  );

  const result = await monitor.refreshNow();
  monitor.stop();

  assert.deepEqual(result, {
    checked: 0,
    refreshed: 0,
    failed: 0,
    skipped: 0,
  });
  assert.equal(calls, 0);
});

test("coalesces overlapping monitor cycles", async () => {
  const accounts = [
    account({ usage: { fetchedAt: Date.now() - 10 * 60_000 } }),
  ];
  const store = storeFor(accounts);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    calls += 1;
    await gate;
    value.usage = { fetchedAt: Date.now() };
    return value;
  });
  const monitor = createUsageRefreshMonitor(
    monitorOptions(store, coordinator),
  );

  const first = monitor.refreshNow();
  const second = monitor.refreshNow();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  monitor.stop();

  assert.equal(calls, 1);
});
