import assert from "node:assert/strict";
import test from "node:test";
import { fetchQwenUsage, parseQwenUsage, QWEN_USAGE_URL } from "./qwen-quota.js";

const quota = {
  per5HourUsedQuota: 52, per5HourTotalQuota: 1000, per5HourQuotaNextRefreshTime: 1_800_000_000_000,
  perWeekUsedQuota: 800, perWeekTotalQuota: 5000, perWeekQuotaNextRefreshTime: 1_800_010_000_000,
  perBillMonthUsedQuota: 1200, perBillMonthTotalQuota: 20000, perBillMonthQuotaNextRefreshTime: 1_800_100_000_000,
};

test("Qwen normalizes explicit five-hour, weekly and monthly quota counters", () => {
  const usage = parseQwenUsage({ status_code: 0, data: { codingPlanQuotaInfo: quota } });
  assert.equal(usage.primary?.usedPercent, 5.2);
  assert.equal(usage.secondary?.usedPercent, 16);
  assert.equal(usage.monthly?.usedPercent, 6);
  assert.equal(usage.primary?.resetAt, 1_800_000_000_000);
  assert.equal(usage.monthly?.resetAt, 1_800_100_000_000);
});

test("Qwen selects only an unambiguous active subscription", () => {
  const usage = parseQwenUsage({ status_code: 0, data: { codingPlanInstanceInfos: [
    { status: "EXPIRED", codingPlanQuotaInfo: { ...quota, per5HourUsedQuota: 999 } },
    { status: "VALID", codingPlanQuotaInfo: quota },
  ] } });
  assert.equal(usage.primary?.usedPercent, 5.2);
  assert.throws(() => parseQwenUsage({ data: { codingPlanInstanceInfos: [
    { status: "VALID", codingPlanQuotaInfo: quota }, { status: "VALID", codingPlanQuotaInfo: quota },
  ] } }), /unambiguous/);
  assert.throws(() => parseQwenUsage({ data: { codingPlanQuotaInfo: {} } }), /measurable/);
  assert.throws(() => parseQwenUsage({ status_code: 500, data: { codingPlanQuotaInfo: quota } }), /failed/);
});

test("Qwen sends the key to a fixed regional RPC and surfaces console-only accounts", async () => {
  const usage = await fetchQwenUsage("secret", undefined, async (url, init) => {
    assert.equal(url, QWEN_USAGE_URL);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    assert.deepEqual(JSON.parse(String(init?.body)), { queryCodingPlanInstanceInfoRequest: { commodityCode: "sfm_codingplan_public_intl" } });
    assert.equal(init?.redirect, "error");
    return Response.json({ code: "ConsoleNeedLogin", successResponse: false }, { status: 403 });
  });
  assert.equal(usage.quotaStatus, "unsupported");
  assert.match(usage.quotaMessage!, /browser console session/);
  await assert.rejects(fetchQwenUsage("secret", undefined, async () => new Response(null, { status: 401 })), /failed 401/);
});
