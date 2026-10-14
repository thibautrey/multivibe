import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostMenuProviderActivityTracker,
  buildHostMenuBarAccountsSummary,
  buildHostMenuBarGitHubStarPrompt,
  recordHostMenuProviderUsage,
  getHostMenuProviderActivity,
} from "./menu-bar.js";
import type { Account } from "../types.js";

test("buildHostMenuBarAccountsSummary preserves SwiftBar quota aggregation", () => {
  const now = 1_800_000_000_000;
  const accounts: Account[] = [
    {
      id: "first-secret-id",
      provider: "openai",
      email: "first@example.com",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      enabled: true,
      usage: {
        fetchedAt: now - 1_000,
        primary: { usedPercent: 20, resetAt: now + 60_000 },
        secondary: { usedPercent: 40, resetAt: now + 120_000 },
      },
    },
    {
      id: "second-secret-id",
      provider: "openai",
      accessToken: "another-secret-token",
      enabled: true,
      usage: {
        fetchedAt: now - 2_000,
        primary: { usedPercent: 60 },
        secondary: { usedPercent: 100 },
        monthly: { usedPercent: 10 },
      },
      state: {
        modelBlocks: { "gpt-5.5": { until: now + 30_000, reason: "rate_limit" } },
        lastError: "sensitive upstream error",
      },
    },
    {
      id: "not-openai",
      provider: "mistral",
      accessToken: "mistral-secret",
      enabled: true,
      usage: { fetchedAt: now, primary: { usedPercent: 5 } },
    },
  ];

  const summary = buildHostMenuBarAccountsSummary(accounts, now);

  assert.equal(summary.accounts.length, 2);
  assert.deepEqual(summary.quota, {
    fiveHourRemainingPercent: 60,
    fiveHourAccountCount: 2,
    weeklyRemainingPercent: 30,
    weeklyAccountCount: 2,
  });
  assert.equal(summary.accounts[0].displayName, "first@example.com");
  assert.equal(summary.accounts[0].fiveHour?.remainingPercent, 80);
  assert.equal(summary.accounts[1].displayName, "OpenAI account 2");
  assert.equal(summary.accounts[1].status, "limited");
  assert.equal(summary.accounts[1].monthly?.remainingPercent, 90);

  const serialized = JSON.stringify(summary);
  for (const secret of [
    "secret-access-token",
    "secret-refresh-token",
    "another-secret-token",
    "first-secret-id",
    "second-secret-id",
    "sensitive upstream error",
    "mistral-secret",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("buildHostMenuBarAccountsSummary reports unavailable and attention states safely", () => {
  const now = 1_800_000_000_000;
  const summary = buildHostMenuBarAccountsSummary([
    {
      id: "paused",
      provider: "openai",
      accessToken: "secret",
      enabled: false,
      usage: { fetchedAt: now, quotaStatus: "unsupported" },
    },
    {
      id: "reauth",
      provider: "openai",
      accessToken: "secret",
      enabled: true,
      state: { needsTokenRefresh: true },
      usage: {
        fetchedAt: Number.NaN,
        primary: { usedPercent: Number.POSITIVE_INFINITY, resetAt: Number.NaN },
      },
    },
  ], now);

  assert.deepEqual(summary.quota, {
    fiveHourAccountCount: 0,
    weeklyAccountCount: 0,
  });
  assert.equal(summary.accounts[0].status, "paused");
  assert.equal(summary.accounts[0].usageStatus, "unsupported");
  assert.equal(summary.accounts[1].status, "attention");
  assert.equal(summary.accounts[1].usageStatus, "pending");
  assert.equal(summary.accounts[1].fetchedAt, undefined);
});

test("buildHostMenuBarGitHubStarPrompt becomes eligible at five million output tokens", () => {
  assert.deepEqual(
    buildHostMenuBarGitHubStarPrompt(4_999_999),
    {
      generatedOutputTokens: 4_999_999,
      threshold: 5_000_000,
      eligible: false,
    },
  );
  assert.equal(buildHostMenuBarGitHubStarPrompt(5_000_000).eligible, true);
  assert.equal(buildHostMenuBarGitHubStarPrompt("5,000,000").generatedOutputTokens, 0);
  assert.equal(buildHostMenuBarGitHubStarPrompt(Number.POSITIVE_INFINITY).generatedOutputTokens, 0);
});

test("non-OpenAI accounts supply menu quotas when OpenAI is absent", () => {
  const summary = buildHostMenuBarAccountsSummary([
    {
      id: "zai-secret-id", provider: "zai", accessToken: "zai-secret", enabled: true,
      usage: { fetchedAt: 123, primary: { usedPercent: 20, resetAt: 456 } },
    },
    {
      id: "opencode-secret-id", provider: "opencode", accessToken: "opencode-secret", enabled: true,
      email: "person@example.com",
      usage: { fetchedAt: 123, primary: { usedPercent: 60 }, secondary: { usedPercent: 30 }, monthly: { usedPercent: 10 } },
    },
    {
      id: "mistral-secret-id", provider: "mistral", accessToken: "mistral-secret", enabled: false,
      usage: { quotaStatus: "unsupported", fetchedAt: 123 },
    },
  ]);
  assert.equal(summary.providers.length, 3);
  assert.deepEqual(summary.providers[0].windows, [{ label: "5h", remainingPercent: 80, accountCount: 1 }]);
  assert.deepEqual(summary.providers[1].windows, [
    { label: "5h", remainingPercent: 40, accountCount: 1 },
    { label: "Weekly", remainingPercent: 70, accountCount: 1 },
    { label: "Monthly", remainingPercent: 90, accountCount: 1 },
  ]);
  assert.equal(summary.providers[0].accounts[0].displayName, "z.ai account 1");
  assert.equal(summary.providers[1].accounts[0].displayName, "OpenCode · person@example.com");
  assert.equal(summary.providers[2].accounts[0].status, "paused");
  assert.equal(summary.providers[2].accounts[0].usageStatus, "unsupported");
  assert.deepEqual(summary.providers[2].windows, []);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

test("legacy OpenAI accounts retain priority and empty inventories have no quota", () => {
  const summary = buildHostMenuBarAccountsSummary([
    { id: "legacy", accessToken: "secret", enabled: true },
    { id: "zai", provider: "zai", accessToken: "secret", enabled: true },
  ]);
  assert.equal(summary.accounts.length, 1);
  assert.equal(summary.accounts[0].displayName, "OpenAI account 1");
  assert.deepEqual(buildHostMenuBarAccountsSummary([]), {
    providers: [], accounts: [], quota: { fiveHourAccountCount: 0, weeklyAccountCount: 0 },
  });
});

test("provider groups separate SDK providers and incompatible quota periods", () => {
  const accounts: Account[] = [
    { id: "a", provider: "openai", enabled: true, accessToken: "secret", usage: { fetchedAt: 1, primary: { usedPercent: 20 } } },
    { id: "b", provider: "openai", enabled: true, accessToken: "secret", usage: { fetchedAt: 1, primary: { usedPercent: 60 } } },
    { id: "c", provider: "ai-sdk", sdkProvider: "anthropic", enabled: true, accessToken: "secret", usage: { fetchedAt: 1, primary: { usedPercent: 5, windowSeconds: 3600 } } },
    { id: "d", provider: "ai-sdk", sdkProvider: "google", enabled: true, accessToken: "secret", usage: { fetchedAt: 1, credits: { usedPercent: 25 } } },
  ];
  const summary = buildHostMenuBarAccountsSummary(accounts);
  assert.equal(summary.providers.length, 3);
  assert.deepEqual(summary.providers[0].windows, [{ label: "5h", remainingPercent: 60, accountCount: 2 }]);
  assert.equal(summary.providers[1].windows[0].label, "1h");
  assert.equal(summary.providers[2].windows[0].label, "Credits");
  recordHostMenuProviderUsage(accounts[0], 100);
  recordHostMenuProviderUsage(accounts[2], 200);
  assert.deepEqual(getHostMenuProviderActivity(200), { providerId: "ai-sdk:anthropic", usedAt: 200 });
});

test("buildHostMenuBarAccountsSummary reports spendable credit for pay-as-you-go providers", () => {
  const now = 1_800_000_000_000;
  const summary = buildHostMenuBarAccountsSummary([
    {
      id: "deepseek-one",
      provider: "ai-sdk",
      sdkProvider: "deepseek",
      accessToken: "deepseek-secret",
      enabled: true,
      usage: {
        fetchedAt: now,
        quotaStatus: "available",
        balance: { remaining: 87.5, unit: "USD" },
      },
    },
    {
      id: "deepseek-two",
      provider: "ai-sdk",
      sdkProvider: "deepseek",
      accessToken: "deepseek-secret",
      enabled: true,
      usage: {
        fetchedAt: now,
        quotaStatus: "available",
        balance: { remaining: 12.25, unit: "USD" },
      },
    },
  ], now);

  const provider = summary.providers.find((entry) => entry.id === "ai-sdk:deepseek");
  assert.ok(provider, "credit provider is missing from the summary");
  assert.deepEqual(provider.windows, []);
  assert.deepEqual(provider.balance, { remaining: 99.75, unit: "USD", accountCount: 2 });
  assert.equal(summary.accounts[0].balance?.remaining, 87.5);
  assert.equal(summary.accounts[0].usageStatus, "available");
  assert.equal(summary.quota.fiveHourAccountCount, 0);
  assert.equal(JSON.stringify(summary).includes("deepseek-secret"), false);
});

test("buildHostMenuBarAccountsSummary never sums credit balances in mixed units", () => {
  const now = 1_800_000_000_000;
  const summary = buildHostMenuBarAccountsSummary([
    {
      id: "deepseek-usd",
      provider: "ai-sdk",
      sdkProvider: "deepseek",
      accessToken: "secret",
      enabled: true,
      usage: { fetchedAt: now, quotaStatus: "available", balance: { remaining: 5, unit: "USD" } },
    },
    {
      id: "deepseek-cny",
      provider: "ai-sdk",
      sdkProvider: "deepseek",
      accessToken: "secret",
      enabled: true,
      usage: { fetchedAt: now, quotaStatus: "available", balance: { remaining: 30, unit: "CNY" } },
    },
  ], now);

  const provider = summary.providers.find((entry) => entry.id === "ai-sdk:deepseek");
  assert.equal(provider?.balance, undefined);
  assert.equal(summary.accounts.length, 2);
  assert.equal(summary.accounts[0].balance?.unit, "USD");
  assert.equal(summary.accounts[1].balance?.unit, "CNY");
});

test("buildHostMenuBarAccountsSummary ignores blank or non-finite balances", () => {
  const now = 1_800_000_000_000;
  const summary = buildHostMenuBarAccountsSummary([
    {
      id: "poe-blank-unit",
      provider: "ai-sdk",
      sdkProvider: "poe",
      accessToken: "secret",
      enabled: true,
      usage: { fetchedAt: now, quotaStatus: "available", balance: { remaining: 10, unit: "  " } },
    },
    {
      id: "poe-nan",
      provider: "ai-sdk",
      sdkProvider: "poe",
      accessToken: "secret",
      enabled: true,
      usage: { fetchedAt: now, quotaStatus: "available", balance: { remaining: Number.NaN, unit: "points" } },
    },
  ], now);

  const provider = summary.providers.find((entry) => entry.id === "ai-sdk:poe");
  assert.equal(provider?.balance, undefined);
  assert.equal(summary.accounts[0].balance, undefined);
  assert.equal(summary.accounts[0].usageStatus, "pending");
});


test("menu activity favors recent request frequency, then recency, and expires idle traffic", () => {
  const activity = createHostMenuProviderActivityTracker();
  const openai = { provider: "openai" as const };
  const zai = { provider: "zai" as const };
  activity.record(openai, 1000);
  activity.record(openai, 2000);
  activity.record(zai, 3000);
  assert.deepEqual(activity.get(3000), { providerId: "openai", usedAt: 3000 });
  activity.record(zai, 4000);
  assert.deepEqual(activity.get(4000), { providerId: "zai", usedAt: 4000 });
  activity.record(openai, 5000);
  assert.deepEqual(activity.get(5000), { providerId: "openai", usedAt: 5000 });
  assert.equal(activity.get(5000, ["zai"])?.providerId, "zai");
  assert.equal(activity.get(5000, []) , undefined);
  assert.equal(activity.get(15 * 60 * 1000 + 6000), undefined);
});

test("rolling activity changes recommendation when old traffic expires without a new request", () => {
  const activity = createHostMenuProviderActivityTracker();
  activity.record({ provider: "openai" }, 1000);
  activity.record({ provider: "openai" }, 1001);
  activity.record({ provider: "zai" }, 5000);
  assert.equal(activity.get(5000)?.providerId, "openai");
  assert.deepEqual(activity.get(902000), { providerId: "zai", usedAt: 5000 });
});

test("completed upstream traces resolve exact SDK accounts and exclude failed or duplicate client traces", () => {
  const activity = createHostMenuProviderActivityTracker();
  const accounts: Account[] = [{ id: "sdk", provider: "ai-sdk", sdkProvider: "anthropic", enabled: true, accessToken: "private" }];
  const trace = { id: "trace", at: 1000, route: "/v1/responses", traceKind: "upstream-attempt" as const,
    accountId: "sdk", status: 200, isError: false, stream: true, latencyMs: 100 };
  for (const invalid of [
    { ...trace, traceKind: "client-request" as const },
    { ...trace, traceKind: "diagnostic" as const },
    { ...trace, isError: true }, { ...trace, status: 429 },
    { ...trace, lifecycleState: "started" as const },
    { ...trace, lifecycleState: "interrupted" as const },
    { ...trace, accountId: "removed" },
  ]) activity.recordTrace(invalid, accounts, 1000);
  assert.equal(activity.get(1000), undefined);
  activity.recordTrace(trace, accounts, 1000);
  assert.deepEqual(activity.get(1000), { providerId: "ai-sdk:anthropic", usedAt: 1000 });
  // Client summary must not count as an additional request for its provider.
  activity.recordTrace({ ...trace, traceKind: "client-request" }, accounts, 2000);
  activity.record({ provider: "openai" }, 3000);
  assert.equal(activity.get(3000)?.providerId, "openai");
});
