import assert from "node:assert/strict";
import test from "node:test";
import { fetchCopilotUsage, parseCopilotUsage } from "./copilot-quota.js";
import type { Account } from "./types.js";

const account: Account = {
  id: "copilot", provider: "github-copilot", enabled: true,
  accessToken: "short-lived-inference-token", refreshToken: "github-oauth-token",
};

test("maps documented Copilot quota snapshots without guessing limits", () => {
  const before = Date.now();
  const usage = parseCopilotUsage({
    quota_reset_date: "2026-10-01",
    quota_snapshots: {
      premium_interactions: { entitlement: 300, remaining: 225, percent_remaining: 75, quota_id: "premium_interactions" },
      chat: { entitlement: 1000, remaining: 400, percent_remaining: 40, quota_id: "chat" },
    },
  });
  assert.deepEqual(usage.credits, { usedPercent: 25, resetAt: Date.UTC(2026, 9, 1), label: "Copilot premium requests" });
  assert.deepEqual(usage.monthly, { usedPercent: 60, resetAt: Date.UTC(2026, 9, 1), label: "Copilot chat requests" });
  assert.equal(usage.quotaStatus, "available");
  assert.ok(usage.fetchedAt >= before);
});

test("does not turn unlimited and token-billing placeholders into fake quota", () => {
  const usage = parseCopilotUsage({ quota_snapshots: {
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0 },
    chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 0 },
  } });
  assert.equal(usage.credits, undefined);
  assert.equal(usage.monthly, undefined);
  assert.equal(usage.quotaStatus, "available");
});

test("rejects malformed or unrecognized quota payloads", () => {
  assert.throws(() => parseCopilotUsage({ quota_snapshots: {} }), /no recognized/);
  assert.throws(() => parseCopilotUsage({ quota_snapshots: { chat: { percent_remaining: "50" } } }), /snapshot is invalid/);
  assert.throws(() => parseCopilotUsage({ quota_reset_date: "2026-02-30", quota_snapshots: { chat: { percent_remaining: 50 } } }), /reset date is invalid/);
});

test("fetches quota with the long-lived GitHub token and forwards cancellation", async () => {
  const controller = new AbortController();
  const usage = await fetchCopilotUsage(account, controller.signal, async (input, init) => {
    assert.equal(input, "https://api.github.com/copilot_internal/user");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "token github-oauth-token");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(init?.signal, controller.signal);
    assert.equal(init?.redirect, "error");
    return Response.json({ quota_snapshots: { chat: { percent_remaining: 80 } } });
  });
  assert.equal(usage.monthly?.usedPercent, 20);
});

test("reports HTTP failures without trying to parse them", async () => {
  await assert.rejects(
    fetchCopilotUsage(account, undefined, async () => new Response("denied", { status: 403 })),
    /probe failed 403/,
  );
});
