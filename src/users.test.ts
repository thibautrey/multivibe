import assert from "node:assert/strict";
import test from "node:test";
import type { User } from "./types.js";
import {
  adminSessionValue,
  hashPassword,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  normalizePlan,
  normalizeQuota,
  periodStartFor,
  publicUser,
  quotaState,
  quotaWindows,
  rollUsagePeriod,
  rollUserWindows,
  signSession,
  verifyPassword,
  verifySession,
} from "./users.js";

const NOW = Date.UTC(2026, 10, 27, 10, 30);

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "usr_test",
    email: "member@example.com",
    role: "member",
    status: "active",
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    quota: { period: "month" },
    usage: { periodStart: periodStartFor("month", new Date()), requests: 0, tokens: 0, costUsd: 0 },
    ...overrides,
  };
}

test("quota normalization accepts only known periods and finite limits", () => {
  assert.deepEqual(normalizeQuota({ period: "day" }), { period: "day" });
  assert.equal(normalizeQuota({ period: "week" }).period, "month");
  assert.deepEqual(normalizeQuota({ period: "month", creditUsd: "12.5", maxTokens: 10, maxRequests: 5 }), {
    period: "month",
    creditUsd: 12.5,
    maxTokens: 10,
    maxRequests: 5,
  });
  assert.equal(normalizeQuota({ creditUsd: -1 }).creditUsd, 0);
  assert.equal(normalizeQuota({ maxTokens: 0 }).maxTokens, undefined);
  assert.equal(normalizeQuota({ maxTokens: 12.7 }).maxTokens, 12);
  assert.equal(normalizeQuota(null).period, "month");
});

test("period boundaries are UTC and the total period never rolls", () => {
  const now = new Date(NOW);
  assert.equal(periodStartFor("day", now), "2026-11-27T00:00:00.000Z");
  assert.equal(periodStartFor("month", now), "2026-11-01T00:00:00.000Z");
  assert.equal(periodStartFor("total", now), "1970-01-01T00:00:00.000Z");
});

test("usage rolls over exactly once per quota period", () => {
  const user = makeUser();
  user.usage = {
    periodStart: "2026-10-01T00:00:00.000Z",
    requests: 4,
    tokens: 900,
    costUsd: 1.5,
    updatedAt: NOW,
  };
  assert.equal(rollUsagePeriod(user, new Date(NOW)), true);
  assert.equal(user.usage.periodStart, "2026-11-01T00:00:00.000Z");
  assert.equal(user.usage.requests, 0);
  assert.equal(rollUsagePeriod(user, new Date(NOW)), false);
});

test("quota state reports each exhausted dimension and clamps the remainder", () => {
  const user = makeUser({
    quota: { period: "month", creditUsd: 5, maxTokens: 1_000, maxRequests: 10 },
    usage: { periodStart: periodStartFor("month", new Date()), requests: 10, tokens: 400, costUsd: 2 },
  });
  const state = quotaState(user);
  assert.equal(state.blocked, true);
  assert.deepEqual(state.reasons, ["requests"]);
  assert.equal(state.remaining.creditUsd, 3);
  assert.equal(state.remaining.tokens, 600);
  assert.equal(state.remaining.requests, 0);

  const suspended = quotaState(makeUser({ status: "suspended" }));
  assert.deepEqual(suspended.reasons, ["suspended"]);
  assert.equal(suspended.suspended, true);

  const unlimited = quotaState(makeUser());
  assert.equal(unlimited.blocked, false);
  assert.equal(unlimited.remaining.creditUsd, undefined);
});

test("the prepaid wallet stacks on top of the period allowance", () => {
  const usage = {
    periodStart: periodStartFor("month", new Date()),
    requests: 1,
    tokens: 10,
    costUsd: 2,
    grantedCostUsd: 2,
  };
  // Allowance spent, wallet still positive: not blocked.
  const funded = quotaState(makeUser({ quota: { period: "month", creditUsd: 2 }, usage, walletUsd: 5 }));
  assert.equal(funded.blocked, false);
  assert.equal(funded.remaining.creditUsd, 5);

  // Both sources spent: blocked on credit.
  const empty = quotaState(makeUser({ quota: { period: "month", creditUsd: 2 }, usage, walletUsd: 0 }));
  assert.equal(empty.blocked, true);
  assert.deepEqual(empty.reasons, ["credit"]);
  assert.equal(empty.remaining.creditUsd, 0);

  // Wallet only: the sole credit source.
  const walletOnly = quotaState(makeUser({ usage, walletUsd: 0.4 }));
  assert.equal(walletOnly.blocked, false);
  assert.equal(walletOnly.remaining.creditUsd, 0.4);
  assert.equal(quotaState(makeUser({ usage, walletUsd: 0 })).blocked, true);

  // No allowance and no wallet: unlimited credit, as before.
  assert.equal(quotaState(makeUser({ usage })).blocked, false);

  // A negative balance is kept and blocks, it is never clamped to zero.
  const overdrawn = makeUser({
    quota: { period: "month", creditUsd: 2 },
    usage,
    walletUsd: -0.4,
  });
  const overdrawnState = quotaState(overdrawn);
  assert.equal(overdrawnState.blocked, true);
  assert.equal(overdrawnState.remaining.creditUsd, 0);
  assert.equal(publicUser(overdrawn).walletUsd, -0.4);
});

test("legacy usage without grantedCostUsd is read as allowance-first", () => {
  const usage = {
    periodStart: periodStartFor("month", new Date()),
    requests: 1,
    tokens: 10,
    costUsd: 2,
  };
  // No wallet: the allowance is billed from the total spend, like before.
  assert.equal(quotaState(makeUser({ quota: { period: "month", creditUsd: 2 }, usage })).blocked, true);
  assert.equal(quotaState(makeUser({ quota: { period: "month", creditUsd: 5 }, usage })).blocked, false);
  // A wallet bought afterwards unblocks the account.
  assert.equal(
    quotaState(makeUser({ quota: { period: "month", creditUsd: 2 }, usage, walletUsd: 1 })).blocked,
    false,
  );
});

test("counters from a finished period read as zero until the next write", () => {
  const user = makeUser({
    quota: { period: "month", creditUsd: 5 },
    usage: {
      periodStart: "2020-01-01T00:00:00.000Z",
      requests: 9,
      tokens: 900,
      costUsd: 9,
      grantedCostUsd: 5,
    },
    walletUsd: 0,
  });
  const state = quotaState(user);
  assert.equal(state.blocked, false);
  assert.equal(state.remaining.creditUsd, 5);
  const view = publicUser(user);
  assert.equal(view.usage.requests, 0);
  assert.equal(view.usage.costUsd, 0);
  assert.equal(view.usage.remainingCreditUsd, 5);
});

test("public user exposes quota, usage and the remaining credit without secrets", () => {
  const user = makeUser({
    password: { algo: "scrypt", salt: "s", hash: "h", updatedAt: NOW },
    quota: { period: "month", creditUsd: 10 },
    usage: { periodStart: periodStartFor("month", new Date()), requests: 2, tokens: 30, costUsd: 2.5 },
    walletUsd: 4,
  });
  const view = publicUser(user) as unknown as Record<string, unknown>;
  assert.equal(view.hasPassword, true);
  assert.equal(view.password, undefined);
  assert.equal((view.usage as Record<string, unknown>).remainingCreditUsd, 11.5);
  assert.equal((view.usage as Record<string, unknown>).grantedCostUsd, undefined);
  assert.equal(view.walletUsd, 4);
  assert.equal((view.quota as Record<string, unknown>).period, "month");
});

test("plans normalize rolling windows and ignore empty caps", () => {
  assert.equal(normalizePlan(undefined), undefined);
  assert.equal(normalizePlan({ mode: "usage" })?.windows, undefined);
  const plan = normalizePlan({
    mode: "subscription",
    name: "  Pro  ",
    priceUsd: 20.456,
    windows: [
      { id: "5h", period: "5h", maxRequests: 120, creditUsd: null, maxTokens: "" },
      { period: "week", maxTokens: "2000000", maxRequests: 0 },
      { id: "5h", period: "fortnight", label: "Second" },
    ],
  });
  assert.equal(plan?.mode, "subscription");
  assert.equal(plan?.name, "Pro");
  assert.equal(plan?.priceUsd, 20.46);
  assert.equal(plan?.windows?.length, 3);
  assert.equal(plan?.windows?.[0]?.creditUsd, undefined);
  assert.equal(plan?.windows?.[0]?.maxTokens, undefined);
  assert.equal(plan?.windows?.[1]?.period, "week");
  assert.equal(plan?.windows?.[1]?.maxRequests, undefined);
  assert.equal(plan?.windows?.[2]?.period, "week");
  assert.equal(plan?.windows?.[2]?.id, "5h-2");
});

test("subscription windows anchor at first use, roll over and block on exhaustion", () => {
  const user = makeUser({
    quota: { period: "month" },
    plan: {
      mode: "subscription",
      name: "Pro",
      windows: [
        { id: "5h", period: "5h", maxRequests: 2 },
        { id: "week", period: "week", maxRequests: 100 },
      ],
    },
    windowUsage: {
      "5h": { startedAt: NOW - 60_000, requests: 2, tokens: 0, costUsd: 0 },
      week: { startedAt: NOW - 86_400_000, requests: 3, tokens: 0, costUsd: 0 },
    },
  });
  const state = quotaState(user, new Date(NOW));
  assert.equal(state.mode, "subscription");
  assert.deepEqual(state.blockedWindows, ["5h"]);
  assert.deepEqual(state.reasons, ["requests"]);
  assert.equal(state.remaining.requests, 0);
  assert.equal(state.windows.length, 2);

  // Five hours later the short window has restarted at zero.
  const later = new Date(NOW + 6 * 60 * 60 * 1000);
  const next = quotaState(user, later);
  assert.equal(next.blocked, false);
  assert.equal(next.windows[0]?.startedAt, later.getTime());
  assert.equal(next.windows[0]?.usage.requests, 0);
  assert.equal(next.windows[1]?.usage.requests, 3);

  assert.equal(rollUserWindows(user, later), true);
  assert.equal(user.windowUsage?.["5h"]?.requests, 0);
  assert.equal(user.windowUsage?.["5h"]?.startedAt, later.getTime());
  assert.equal(rollUserWindows(user, later), false);

  // Switching back to pay-as-you-go drops the counters.
  user.plan = { mode: "usage" };
  assert.equal(rollUserWindows(user, later), true);
  assert.deepEqual(user.windowUsage, {});
});

test("subscription users expose their windows and the binding remainder", () => {
  const user = makeUser({
    plan: { mode: "subscription", windows: [{ id: "week", period: "week", maxRequests: 10, creditUsd: 5 }] },
    windowUsage: {
      week: { startedAt: Date.now() - 60_000, requests: 4, tokens: 0, costUsd: 1.5 },
    },
  });
  const view = publicUser(user);
  assert.equal(view.plan?.mode, "subscription");
  assert.equal(view.quotaWindows?.[0]?.usage.requests, 4);
  assert.equal(view.quotaWindows?.[0]?.remaining.requests, 6);
  assert.equal(view.usage.remainingCreditUsd, 3.5);
  assert.equal(quotaWindows(user).length, 1);
});

test("passwords use scrypt and reject the wrong secret", async () => {
  assert.equal(isValidPassword("secret12"), true);
  assert.equal(isValidPassword("short"), false);
  assert.equal(isValidEmail("member@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(normalizeEmail("  MEMBER@Example.com "), "member@example.com");

  const password = await hashPassword("secret12");
  assert.equal(password?.algo, "scrypt");
  assert.equal(await verifyPassword("secret12", password), true);
  assert.equal(await verifyPassword("secret13", password), false);
  assert.equal(await verifyPassword("secret12", undefined), false);
});

test("signed sessions round-trip and reject tampering or expiry", () => {
  const secret = "admin-secret";
  const expiresAt = Date.now() + 60_000;
  const value = signSession({ userId: "usr_test", role: "member", expiresAt }, secret);
  assert.deepEqual(verifySession(value, secret), {
    userId: "usr_test",
    role: "member",
    expiresAt,
  });
  assert.equal(verifySession(value, "other-secret"), null);
  assert.equal(verifySession(value.replace(/.$/, "A"), secret), null);
  const tampered = `${value.slice(0, 3)}${value[3] === "e" ? "f" : "e"}${value.slice(4)}`;
  assert.equal(verifySession(tampered, secret), null);
  assert.equal(verifySession(signSession({ role: "admin", expiresAt: NOW - 1 }, secret), secret), null);
  assert.deepEqual(verifySession(adminSessionValue(secret), secret), {
    role: "admin",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(verifySession(undefined, secret), null);
});
