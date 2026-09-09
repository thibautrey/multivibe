import type { UsageSnapshot, UsageWindow } from "../types.js";

const HOST = "https://modelstudio.console.alibabacloud.com";
export const QWEN_USAGE_URL = `${HOST}/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=ap-southeast-1`;

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Console RPC schema reviewed against CodexBar's public source and fixtures. */
export function parseQwenUsage(payload: unknown): UsageSnapshot {
  const root = payload as any;
  if (root?.code === "ConsoleNeedLogin") return {
    quotaStatus: "unsupported", fetchedAt: Date.now(),
    quotaMessage: "Alibaba requires a browser console session to read this account's Coding Plan quotas. Inference still uses your API key; check quota in the Alibaba console.",
  };
  if (!root || root.success === false || root.successResponse === false || root.error ||
      root.status_code !== undefined && Number(root.status_code) !== 0 ||
      root.code !== undefined && !["0", "200", "Success", "success"].includes(String(root.code))) {
    throw new Error("Qwen Coding Plan usage response failed");
  }
  const data = root.data ?? root.successResponse;
  const active = Array.isArray(data?.codingPlanInstanceInfos)
    ? data.codingPlanInstanceInfos.filter((item: any) => item?.status === "VALID" || item?.status === "ACTIVE") : [];
  const quota = data?.codingPlanQuotaInfo ?? (active.length === 1 ? active[0].codingPlanQuotaInfo : undefined);
  if (!quota) throw new Error("Qwen Coding Plan response contains no unambiguous quota data");
  const window = (prefix: string, windowSeconds?: number): UsageWindow | undefined => {
    const used = number(quota[`${prefix}UsedQuota`]), total = number(quota[`${prefix}TotalQuota`]);
    if (used === undefined || total === undefined || total <= 0) return undefined;
    const reset = number(quota[`${prefix}QuotaNextRefreshTime`]);
    return { usedPercent: Math.min(100, used / total * 100),
      ...(reset && reset > 0 ? { resetAt: reset < 10_000_000_000 ? reset * 1000 : reset } : {}),
      ...(windowSeconds ? { windowSeconds } : {}) };
  };
  const primary = window("per5Hour", 18_000), secondary = window("perWeek", 604_800), monthly = window("perBillMonth");
  if (!primary && !secondary && !monthly) throw new Error("Qwen Coding Plan response contains no measurable quota windows");
  return { primary, secondary, monthly, fetchedAt: Date.now(), quotaStatus: "available" };
}

export async function fetchQwenUsage(token: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<UsageSnapshot> {
  const response = await fetchImpl(QWEN_USAGE_URL, {
    method: "POST", redirect: "error", signal: signal ?? AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, "x-api-key": token, "X-DashScope-API-Key": token,
      "content-type": "application/json", accept: "application/json", origin: HOST,
      referer: `${HOST}/ap-southeast-1/?tab=globalset#/efm/coding_plan` },
    body: JSON.stringify({ queryCodingPlanInstanceInfoRequest: { commodityCode: "sfm_codingplan_public_intl" } }),
  });
  const payload = await response.json().catch(() => undefined);
  if (payload?.code === "ConsoleNeedLogin") return parseQwenUsage(payload);
  if (!response.ok) throw new Error(`Qwen Coding Plan usage probe failed ${response.status}`);
  return parseQwenUsage(payload);
}
