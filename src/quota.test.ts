import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAccountSelectionTelemetry,
  commitAccountSelection,
  chooseAccount,
  isUsageRefreshNeeded,
  parseOpenCodeUsage,
  refreshUsageIfNeeded,
  selectAccountForProvider,
  tracksSubscriptionQuota,
} from "./quota.js";
import type { Account } from "./types.js";

function account(
  id: string,
  primaryUsedPercent: number | undefined,
  secondaryUsedPercent: number | undefined,
): Account {
  return {
    id,
    accessToken: `token-${id}`,
    enabled: true,
    usage: {
      fetchedAt: Date.now(),
      primary:
        primaryUsedPercent === undefined
          ? undefined
          : { usedPercent: primaryUsedPercent },
      secondary:
        secondaryUsedPercent === undefined
          ? undefined
          : { usedPercent: secondaryUsedPercent },
    },
  };
}

test("does not treat a missing quota window as untouched usage", () => {
  const withoutFiveHourQuota = account("without-five-hour", undefined, 0);
  const untouchedOnBothWindows = account("with-five-hour", 0, 0);

  assert.equal(
    chooseAccount([withoutFiveHourQuota, untouchedOnBothWindows])?.id,
    "with-five-hour",
  );
});

test("does not treat a missing usage snapshot as untouched usage", () => {
  const unknownUsage: Account = {
    id: "unknown-usage",
    accessToken: "token-unknown",
    enabled: true,
  };
  const untouchedOnBothWindows = account("known-untouched", 0, 0);

  assert.equal(
    chooseAccount([unknownUsage, untouchedOnBothWindows])?.id,
    "known-untouched",
  );
});

test("local runtimes do not track or route by subscription quota", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("unexpected quota request");
  };
  const local: Account = {
    ...account("local-runtime-omlx", 100, 100),
    provider: "openai-compatible",
    location: "local",
    localRuntime: {
      source: "multivibe-local-discovery",
      adapter: "omlx",
      endpoint: "http://127.0.0.1:8000",
      confirmedModelIds: ["test/model"],
      authentication: "none",
    },
  };

  assert.equal(tracksSubscriptionQuota(local), false);
  assert.equal(isUsageRefreshNeeded(local), false);
  assert.equal((await import("./quota.js")).accountHeadroom(local), undefined);
  await refreshUsageIfNeeded(local, local.localRuntime!.endpoint, true);
  assert.equal(fetches, 0);
  assert.equal(local.usage, undefined);
});

test("the synthetic MultiVibe Cloud account does not track provider quota", () => {
  const cloud: Account = {
    id: "multivibe-cloud",
    provider: "openai-compatible",
    accessToken: "",
    enabled: true,
    multivibeCloud: true,
  };

  assert.equal(tracksSubscriptionQuota(cloud), false);
  assert.equal(isUsageRefreshNeeded(cloud), false);
});

test("balances equal weekly usage between accounts with different quota windows", () => {
  const withFiveHourQuota = account("with-five-hour-balanced", 0, 0);
  const withoutFiveHourQuota = account("without-five-hour-balanced", undefined, 0);

  const selected = [
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
  ];

  assert.deepEqual(selected, [
    "with-five-hour-balanced",
    "without-five-hour-balanced",
    "with-five-hour-balanced",
    "without-five-hour-balanced",
  ]);
});

test("stops using a five-hour account near its limit when a weekly-only account exists", () => {
  const withFiveHourQuota = account("with-five-hour-near-limit", 90, 0);
  const withoutFiveHourQuota = account("without-five-hour-near-limit", undefined, 0);

  assert.equal(
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    "without-five-hour-near-limit",
  );
});

test("does not use an exhausted five-hour account to equalize weekly usage", () => {
  const withFiveHourQuota = account("with-five-hour-exhausted", 100, 0);
  const otherFiveHourQuota = account("other-five-hour-available", 10, 50);

  assert.equal(
    chooseAccount([withFiveHourQuota, otherFiveHourQuota])?.id,
    "other-five-hour-available",
  );
});

test("keeps a five-hour account in rotation below the near-limit threshold", () => {
  const withFiveHourQuota = account("with-five-hour-below-limit", 89, 0);
  const withoutFiveHourQuota = account("without-five-hour-below-limit", undefined, 0);

  const first = chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id;
  const second = chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id;

  assert.notEqual(first, second);
});

test("prefers the account with the greatest quota headroom across windows", () => {
  const fiveHourConstrained = account("five-hour-constrained", 98, 10);
  const weeklyConstrained = account("weekly-constrained", 90, 60);

  const decision = selectAccountForProvider(
    [fiveHourConstrained, weeklyConstrained],
    "openai",
  );

  assert.equal(decision.account?.id, "weekly-constrained");
  assert.equal(decision.selectedHeadroomPercent, 10);
  assert.equal(decision.selectedWeeklyRemainingPercent, 40);
  assert.equal(decision.selectedFiveHourRemainingPercent, 10);
  assert.equal(decision.candidateCount, 2);
  assert.equal(decision.eligibleCount, 2);
});

test("keeps provider selection isolated when no account matches", () => {
  const decision = selectAccountForProvider(
    [account("openai-only", 10, 10)],
    "mistral",
  );

  assert.equal(decision.provider, "mistral");
  assert.equal(decision.account, null);
  assert.equal(decision.candidateCount, 0);
  assert.equal(decision.eligibleCount, 0);
});

test("does not consume the round-robin cursor for an overridden selection", () => {
  const first = account("cursor-a", 0, 0);
  const second = account("cursor-b", 0, 0);
  commitAccountSelection("openai", first.id);

  const quotaSelection = selectAccountForProvider(
    [first, second],
    "openai",
    { advanceCursor: false },
  );
  assert.equal(quotaSelection.account?.id, second.id);

  // A sticky/policy override uses the first account, so the quota choice must
  // not advance the cursor. The next quota-only selection remains second.
  const nextQuotaSelection = selectAccountForProvider(
    [first, second],
    "openai",
    { advanceCursor: false },
  );
  assert.equal(nextQuotaSelection.account?.id, second.id);

  // Once the quota-selected account is actually used, committing it advances
  // the cursor and restores the normal alternation for the following choice.
  commitAccountSelection("openai", quotaSelection.account!.id);
  const afterQuotaCommit = selectAccountForProvider(
    [first, second],
    "openai",
    { advanceCursor: false },
  );
  assert.equal(afterQuotaCommit.account?.id, first.id);
});

test("builds account-selection telemetry from the final selected account", () => {
  const quotaAccount = account("telemetry-quota", 10, 10);
  const stickyAccount = account("telemetry-sticky", 20, 20);
  const decision = selectAccountForProvider(
    [quotaAccount, stickyAccount],
    "openai",
    { advanceCursor: false },
  );

  const telemetry = buildAccountSelectionTelemetry(
    decision,
    stickyAccount,
    "sticky",
    true,
  );
  assert.deepEqual(telemetry, {
    reason: "sticky",
    provider: "openai",
    candidateCount: 2,
    eligibleCount: 2,
    nearLimitCount: 0,
    rotated: true,
    selectedHeadroomPercent: 80,
    selectedWeeklyRemainingPercent: 80,
    selectedFiveHourRemainingPercent: 80,
  });
});

test("normalizes OpenCode Go rolling, weekly, and monthly quotas", () => {
  const usage = parseOpenCodeUsage({
    usage: {
      rolling: {
        status: "ok",
        percent: 12.5,
        resetsAt: "2026-08-29T16:00:00.000Z",
      },
      weekly: {
        status: "ok",
        percent: 34,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
      monthly: {
        status: "rate-limited",
        percent: 100,
        resetsAt: "2026-09-15T00:00:00.000Z",
      },
    },
  });

  assert.equal(usage.primary?.usedPercent, 12.5);
  assert.equal(usage.primary?.windowSeconds, 5 * 60 * 60);
  assert.equal(usage.secondary?.usedPercent, 34);
  assert.equal(usage.secondary?.windowSeconds, 7 * 24 * 60 * 60);
  assert.equal(usage.monthly?.usedPercent, 100);
  assert.equal(
    usage.monthly?.resetAt,
    Date.parse("2026-09-15T00:00:00.000Z"),
  );
});

test("refreshes OpenCode quotas from the account's Go usage endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://opencode.ai/zen/go/v1/usage");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer opencode-key",
    );
    return Response.json({
      usage: {
        rolling: { percent: 8, resetsAt: "2026-08-30T00:00:00Z" },
        weekly: { percent: 21, resetsAt: "2026-09-01T00:00:00Z" },
        monthly: { percent: 55, resetsAt: "2026-09-15T00:00:00Z" },
      },
    });
  };
  const opencode: Account = {
    id: "opencode",
    provider: "opencode",
    accessToken: "opencode-key",
    baseUrl: "https://opencode.ai/zen/go",
    enabled: true,
  };

  try {
    const refreshed = await refreshUsageIfNeeded(
      opencode,
      opencode.baseUrl!,
      true,
    );
    assert.equal(refreshed.usage?.primary?.usedPercent, 8);
    assert.equal(refreshed.usage?.secondary?.usedPercent, 21);
    assert.equal(refreshed.usage?.monthly?.usedPercent, 55);
    assert.equal(refreshed.state?.lastError, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshes a fresh snapshot after a quota window reset has passed", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (input) => {
    fetches += 1;
    assert.equal(String(input), "https://chatgpt.example/backend-api/wham/usage");
    return Response.json({
      rate_limit: {
        primary_window: {
          used_percent: 0,
          reset_at: Math.floor((Date.now() + 5 * 60 * 60_000) / 1000),
          limit_window_seconds: 5 * 60 * 60,
        },
      },
    });
  };
  const accountWithExpiredWindow: Account = {
    id: "expired-window",
    provider: "openai",
    accessToken: "token-expired-window",
    enabled: true,
    usage: {
      fetchedAt: Date.now(),
      primary: {
        usedPercent: 100,
        resetAt: Date.now() - 1_000,
        windowSeconds: 5 * 60 * 60,
      },
    },
  };

  try {
    const refreshed = await refreshUsageIfNeeded(
      accountWithExpiredWindow,
      "https://chatgpt.example",
    );
    assert.equal(fetches, 1);
    assert.equal(refreshed.usage?.primary?.usedPercent, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats unavailable OpenCode Go quotas as unsupported instead of an account error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } },
      { status: 403 },
    );
  const opencode: Account = {
    id: "opencode-zen",
    provider: "opencode",
    accessToken: "opencode-key",
    baseUrl: "https://opencode.ai/zen",
    enabled: true,
    state: {
      lastError: "OpenCode usage probe failed 404",
      recentErrors: [
        { at: Date.now(), message: "OpenCode usage probe failed 404" },
        { at: Date.now(), message: "other error" },
      ],
    },
  };

  try {
    const refreshed = await refreshUsageIfNeeded(
      opencode,
      opencode.baseUrl!,
      true,
    );
    assert.equal(refreshed.usage?.quotaStatus, "unsupported");
    assert.equal(refreshed.state?.lastError, undefined);
    assert.deepEqual(
      refreshed.state?.recentErrors?.map((error) => error.message),
      ["other error"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps OpenCode authentication failures visible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: { message: "unauthorized" } }, { status: 401 });
  const opencode: Account = {
    id: "opencode-invalid",
    provider: "opencode",
    accessToken: "invalid-key",
    baseUrl: "https://opencode.ai/zen/go",
    enabled: true,
  };

  try {
    const refreshed = await refreshUsageIfNeeded(
      opencode,
      opencode.baseUrl!,
      true,
    );
    assert.match(refreshed.state?.lastError ?? "", /failed 401/);
    assert.notEqual(refreshed.usage?.quotaStatus, "unsupported");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Console quota refresh avoids nonexistent inference usage routes and clears stale windows", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected fetch"); };
  const a: Account = {
    id: "console", provider: "opencode", accessToken: "session", enabled: true,
    baseUrl: "https://opencode.ai/inference/openai",
    usage: { fetchedAt: 0, monthly: { usedPercent: 100, resetAt: Date.now() - 1000 } },
    state: { lastError: "upstream 403: Workspace selection is required" },
  };
  await refreshUsageIfNeeded(a, a.baseUrl!, true);
  assert.equal(calls, 0);
  assert.equal(a.usage?.quotaStatus, "unsupported");
  assert.match(a.usage?.quotaMessage ?? "", /Console.*Go API key/);
  assert.equal(a.usage?.monthly, undefined);
  assert.match(a.state?.lastError ?? "", /Workspace selection/);
});

test("Go quota requests use the configured inference key and workspace", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://opencode.ai/zen/go/v1/usage");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer inference-key");
    assert.equal(headers.get("x-org-id"), "org_selected");
    return Response.json({ usage: { rolling: { percent: 0 }, weekly: { percent: 12 }, monthly: { percent: 34 } } });
  };
  const a: Account = {
    id: "go", provider: "opencode", enabled: true, accessToken: "oauth-session",
    opencodeApiKey: "inference-key", opencodeOrgId: "org_selected",
    opencodeHeaders: { Authorization: "Bearer stale" },
    state: { lastError: "upstream inference failed" },
  };
  await refreshUsageIfNeeded(a, "https://opencode.ai/zen", true);
  assert.equal(a.usage?.quotaStatus, "available");
  assert.equal(a.usage?.monthly?.usedPercent, 34);
  assert.equal(a.state?.lastError, "upstream inference failed");
});

test("OpenCode quota errors are visible instead of being classified as unsupported", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const [status, body] of [
    [403, { error: { message: "Workspace selection is required" } }],
    [403, { cloudflare_error: true }],
    [404, { error: { message: "not found" } }],
    [401, { error: { type: "AuthError" } }],
    [200, { usage: {} }],
  ] as const) {
    globalThis.fetch = async () => Response.json(body, { status });
    const a: Account = {
      id: "go", provider: "opencode", enabled: true, accessToken: "key",
      usage: { quotaStatus: "unsupported", fetchedAt: 0 },
    };
    await refreshUsageIfNeeded(a, "https://opencode.ai/zen/go", true);
    assert.equal(a.usage?.quotaStatus, "error");
    assert.ok(a.usage?.quotaMessage);
    assert.ok(a.state?.lastError);
  }
  for (const data of [null, {}, { usage: {} }, { usage: { monthly: { percent: "bad" } } }]) {
    assert.throws(() => parseOpenCodeUsage(data), /no recognized quota windows/);
  }
});

test("Z.ai parses legacy, weekly credit and MCP quotas without mixing model and tool limits", async () => {
  const { parseZaiUsage, accountHeadroom } = await import("./quota.js");
  const reset = Date.now() + 3600000;
  const usage = parseZaiUsage({ success: true, code: 200, data: { limits: [
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 42, nextResetTime: reset },
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 12 },
    { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 100 },
  ] } });
  assert.equal(usage.primary?.usedPercent, 12);
  assert.equal(usage.secondary?.usedPercent, 42);
  assert.equal(usage.secondary?.resetAt, reset);
  assert.equal(usage.tools?.usedPercent, 100);
  assert.equal(usage.monthly, undefined);
  assert.equal(accountHeadroom({ ...account("zai-tools", 0, 0), usage }), 58);
  assert.equal(parseZaiUsage({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 23 }] } }).primary?.usedPercent, 23);
  assert.equal(parseZaiUsage({ data: { weekly: { used: 1, total: 4 } } }).secondary?.usedPercent, 25);
  assert.equal(parseZaiUsage({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, currentValue: 2, usage: 8 }] } }).primary?.usedPercent, 25);
  for (const body of [{}, { success: false }, { code: 401, data: { weekly: { percent: 2 } } },
    { data: { limits: [{ type: "TOKENS_LIMIT", unit: 99, number: 1, percentage: 10 }] } }]) {
    assert.throws(() => parseZaiUsage(body));
  }
});

test("Grok credits retain unknown usage and do not confuse paid on-demand spend with subscription usage", async () => {
  const { parseXaiUsage, accountHeadroom, nextResetAt } = await import("./quota.js");
  const end = "2026-10-01T00:00:00Z";
  const usage = parseXaiUsage({ config: { creditUsagePercent: 25, currentPeriod: { end } } });
  assert.equal(usage.credits?.usedPercent, 25);
  assert.equal(usage.primary, undefined);
  assert.equal(usage.monthly, undefined);
  assert.equal(nextResetAt(usage), Date.parse(end));
  assert.equal(accountHeadroom({ ...account("grok-credits", 0, 0), usage }), 75);
  const unknown = parseXaiUsage({ config: { currentPeriod: { end }, onDemandCap: { val: 100 }, onDemandUsed: { val: 20 } } });
  assert.equal(unknown.credits?.usedPercent, undefined);
  assert.match(unknown.quotaMessage!, /no subscription usage percentage/);
  assert.equal(parseXaiUsage({ config: { creditUsagePercent: 0 } }).credits?.usedPercent, 0);
  assert.throws(() => parseXaiUsage({ config: {} }));
});

test("quota refresh dispatches credentials to each supported provider endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const [provider, base, endpoint, body] of [
    ["zai", "https://api.z.ai/api/coding/paas/v4", "https://api.z.ai/api/monitor/usage/quota/limit", { data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10 }] } }],
    ["openai-compatible", "https://dev.bigmodel.cn/api/anthropic", "https://dev.bigmodel.cn/api/monitor/usage/quota/limit", { data: { weekly: { percent: 20 } } }],
    ["xai", "https://cli-chat-proxy.grok.com/v1/", "https://cli-chat-proxy.grok.com/v1/billing?format=credits", { config: { creditUsagePercent: 30 } }],
    ["openai", "https://chatgpt.example/", "https://chatgpt.example/backend-api/wham/usage", { rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604800 } } }],
  ] as const) {
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), endpoint);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-key");
      if (provider === "xai") assert.equal(headers.get("x-xai-token-auth"), "xai-grok-cli");
      if (provider === "openai") assert.equal(headers.get("chatgpt-account-id"), "workspace");
      return Response.json(body);
    };
    const a: Account = { id: provider, provider, accessToken: "test-key", enabled: true, chatgptAccountId: "workspace", state: { lastError: "inference failure" } };
    await refreshUsageIfNeeded(a, base, true);
    assert.equal(calls, 1);
    assert.equal(a.usage?.quotaStatus, "available");
    assert.equal(a.state?.lastError, "inference failure");
    if (provider === "openai") {
      assert.equal(a.usage?.primary, undefined);
      assert.equal(a.usage?.secondary?.usedPercent, 40);
    }
  }
});

test("all supported quota probes retain stale data on failure and back off even after reset", async (t) => {
  const { isUsageRefreshNeeded } = await import("./quota.js");
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const provider of ["openai", "opencode", "zai", "xai"] as const) {
    for (const status of [200, 401, 403, 429, 500]) {
      globalThis.fetch = async () => Response.json({ error: "failed" }, { status });
      const a: Account = { ...account(provider, 75, 25), provider };
      a.usage!.primary!.resetAt = Date.now() - 1000;
      await refreshUsageIfNeeded(a, "https://opencode.ai/zen/go", true);
      assert.equal(a.usage?.quotaStatus, "error", `${provider}: ${status}`);
      assert.equal(a.usage?.primary?.usedPercent, 75);
      assert.ok(a.usage?.quotaMessage);
      assert.equal(isUsageRefreshNeeded(a), false);
      assert.equal(isUsageRefreshNeeded(a, Date.now() + 60001), true);
    }
  }
});

test("unsupported connections clear stale quotas without making subscription requests", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected call"); };
  for (const provider of ["mistral", "ai-sdk", "openai-compatible"] as const) {
    const a = { ...account(provider, 100, 100), provider };
    await refreshUsageIfNeeded(a, "https://api.example", true);
    assert.equal(a.usage?.quotaStatus, "unsupported");
    assert.equal(a.usage?.primary, undefined);
    assert.ok(a.usage?.quotaMessage);
  }
  assert.equal(calls, 0);
});

test("selection avoids exhausted monthly quotas and balances credit-only accounts by headroom", () => {
  const exhausted = account("monthly-exhausted", 0, 0);
  exhausted.usage!.monthly = { usedPercent: 100 };
  const available = account("monthly-available", 20, 30);
  assert.equal(chooseAccount([exhausted, available])?.id, available.id);
  const high = account("credit-high", undefined, undefined);
  high.usage!.credits = { usedPercent: 10 };
  const low = account("credit-low", undefined, undefined);
  low.usage!.credits = { usedPercent: 90 };
  for (let i = 0; i < 3; i++) assert.equal(chooseAccount([high, low])?.id, high.id);
});
