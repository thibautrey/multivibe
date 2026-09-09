import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHostMenuBarAccountsSummary,
  buildHostMenuBarGitHubStarPrompt,
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
      usage: { primary: { usedPercent: 60 }, secondary: { usedPercent: 30 }, monthly: { usedPercent: 10 } },
    },
    {
      id: "mistral-secret-id", provider: "mistral", accessToken: "mistral-secret", enabled: false,
      usage: { quotaStatus: "unsupported", fetchedAt: 123 },
    },
  ]);
  assert.deepEqual(summary.quota, {
    fiveHourRemainingPercent: 60, fiveHourAccountCount: 2,
    weeklyRemainingPercent: 70, weeklyAccountCount: 1,
  });
  assert.equal(summary.accounts[0].displayName, "z.ai account 1");
  assert.deepEqual(summary.accounts[0].fiveHour, { remainingPercent: 80, resetAt: 456 });
  assert.equal(summary.accounts[1].displayName, "OpenCode · person@example.com");
  assert.equal(summary.accounts[1].monthly?.remainingPercent, 90);
  assert.equal(summary.accounts[2].status, "paused");
  assert.equal(summary.accounts[2].usageStatus, "unsupported");
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
    accounts: [], quota: { fiveHourAccountCount: 0, weeklyAccountCount: 0 },
  });
});
