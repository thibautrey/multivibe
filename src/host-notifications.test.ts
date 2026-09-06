import assert from "node:assert/strict";
import test from "node:test";
import { buildHostNotifications, outputTokenMilestone, workerEarningsMilestone } from "./host-notifications.js";
import type { Account } from "./types.js";

function openAi(overrides: Partial<Account> = {}): Account {
  return {
    id: "openai-account",
    provider: "openai",
    accessToken: "secret",
    enabled: true,
    usage: {
      fetchedAt: 1_800_000_000_000,
      secondary: { usedPercent: 91, resetAt: 1_900_000_000_000 },
    },
    ...overrides,
  };
}

test("forecast notification requires a strict below-90 to above-90 crossing", () => {
  const base = { accounts: [openAi()], workerConfigured: false, generatedOutputTokens: 0 };
  assert.equal(buildHostNotifications({ ...base, previousForecastScore: 89, forecast: { score: 91, state: "high" } })[0]?.kind, "will-codex-reset");
  assert.equal(buildHostNotifications({ ...base, previousForecastScore: 90, forecast: { score: 91, state: "high" } }).some((item) => item.kind === "will-codex-reset"), false);
  assert.equal(buildHostNotifications({ ...base, previousForecastScore: 89, forecast: { score: 90, state: "high" } }).some((item) => item.kind === "will-codex-reset"), false);
  assert.equal(buildHostNotifications({ ...base, forecast: { score: 95, state: "high" } }).some((item) => item.kind === "will-codex-reset"), false);
});

test("weekly warning is offered once per quota cycle only below an 80 percent forecast", () => {
  const input = {
    accounts: [openAi()],
    forecast: { score: 79, state: "low" },
    workerConfigured: false,
    generatedOutputTokens: 0,
  };
  const notification = buildHostNotifications(input).find((item) => item.kind === "weekly-quota");
  assert.equal(notification?.id, "weekly-quota:1900000000000");
  assert.equal(notification?.actionPath, "/admin/host/weekly-auto-reset");
  assert.equal(buildHostNotifications({ ...input, forecast: { score: 80, state: "medium" } }).some((item) => item.kind === "weekly-quota"), false);
  assert.equal(buildHostNotifications({ ...input, accounts: [openAi({ state: { scheduledWeeklyReset: { scheduledAt: 1, idempotencyKey: "key", thresholdRemainingPercent: 0.5 } } })] }).some((item) => item.kind === "weekly-quota"), false);
  assert.equal(buildHostNotifications({
    ...input,
    accounts: [
      openAi({ id: "eligible" }),
      openAi({ id: "scheduled", usage: undefined, state: { scheduledWeeklyReset: { scheduledAt: 1, idempotencyKey: "key", thresholdRemainingPercent: 0.5 } } }),
    ],
  }).some((item) => item.kind === "weekly-quota"), false);
});

test("Cloud notifications distinguish low balance from active auto top-up", () => {
  const base = { accounts: [], workerConfigured: false, generatedOutputTokens: 0 };
  const low = buildHostNotifications({ ...base, cloud: { status: "connected", balanceUsd: "2.10", topupUrl: "https://app.example/billing" } })[0];
  assert.equal(low?.kind, "cloud-balance");
  assert.equal(low?.actionTitle, "Top up credits");
  const automatic = buildHostNotifications({ ...base, cloud: { status: "connected", balanceUsd: "5.40", topupUrl: "https://app.example/billing", autoTopup: { enabled: true, thresholdUsd: "5", rechargeUsd: "20" } } })[0];
  assert.equal(automatic?.kind, "cloud-auto-topup");
  assert.equal(automatic?.actionTitle, undefined);
  assert.equal(buildHostNotifications({ ...base, cloud: { status: "connected", balanceUsd: "0", topupUrl: "https://app.example/billing" } }).length, 0);
  assert.equal(buildHostNotifications({ ...base, cloud: { status: "connected", balanceUsd: "2.26", topupUrl: "https://app.example/billing" } }).length, 0);
  const shadow = buildHostNotifications({ ...base, cloud: { status: "connected", balanceUsd: "5.40", topupUrl: "https://app.example/billing" } });
  assert.equal(shadow.some((item) => item.kind === "cloud-auto-topup"), false);
});

test("worker milestones scale with average monthly earnings", () => {
  assert.equal(workerEarningsMilestone("9.99", "20"), undefined);
  assert.equal(workerEarningsMilestone("10", "20"), 10);
  assert.equal(workerEarningsMilestone("999", "999"), 900);
  assert.equal(workerEarningsMilestone("5999", "1000"), 5000);
  assert.equal(workerEarningsMilestone("29999", "10000"), 20000);
});

test("output-token milestones stay sparse and avoid the existing five-million prompt", () => {
  assert.equal(outputTokenMilestone(99_999), undefined);
  assert.equal(outputTokenMilestone(100_000), 100_000);
  assert.equal(outputTokenMilestone(5_000_000), 1_000_000);
  assert.equal(outputTokenMilestone(10_000_000), 10_000_000);
});
