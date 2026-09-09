import type { Account, UsageSnapshot, UsageWindow } from "../../types.js";

export type ExpansionModel = { id: string; name: string; input: string[]; contextWindow?: number };
export type ExpansionCatalog = { source: string; fetchedAt: string; models: ExpansionModel[] };

export const PROVIDERS = [
  { id: "chutes", name: "Chutes.ai", adapter: "compatible", baseURL: "https://llm.chutes.ai/v1" },
  { id: "venice", name: "Venice AI", adapter: "compatible", baseURL: "https://api.venice.ai/api/v1" },
  { id: "kilo", name: "Kilo AI Gateway", adapter: "compatible", baseURL: "https://api.kilo.ai/api/gateway" },
  { id: "byteplus-coding", name: "BytePlus Coding Plan", adapter: "compatible", baseURL: "https://ark.ap-southeast.bytepluses.com/api/coding/v3" },
  { id: "xiaomi-token-plan", name: "Xiaomi MiMo Token Plan (China)", adapter: "compatible", baseURL: "https://token-plan-cn.xiaomimimo.com/v1" },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi MiMo Token Plan (Europe)", adapter: "compatible", baseURL: "https://token-plan-ams.xiaomimimo.com/v1" },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi MiMo Token Plan (Singapore)", adapter: "compatible", baseURL: "https://token-plan-sgp.xiaomimimo.com/v1" },
  { id: "ollama-cloud", name: "Ollama Cloud", adapter: "compatible", baseURL: "https://ollama.com/v1" },
  { id: "synthetic", name: "Synthetic", adapter: "compatible", baseURL: "https://api.synthetic.new/openai/v1" },
] as const satisfies ReadonlyArray<{ id: string; name: string; adapter: "compatible" | "anthropic"; baseURL: string }>;

const reviewed = "2026-09-09";
const text = (id: string, name = id): ExpansionModel => ({ id, name, input: ["text"] });
export const CATALOGS: Record<string, ExpansionCatalog> = {
  chutes: { source: "https://models.dev/api.json", fetchedAt: reviewed, models: [text("deepseek-ai/DeepSeek-V4-Flash-0731-TEE", "DeepSeek V4 Flash TEE"), text("Qwen/Qwen3.6-27B-TEE", "Qwen 3.6 27B TEE")] },
  venice: { source: "https://api.venice.ai/api/v1/models", fetchedAt: reviewed, models: [text("zai-org-glm-5-2", "GLM 5.2"), { ...text("gemini-3-6-flash", "Gemini 3.6 Flash"), input: ["text", "image", "audio", "video"] }] },
  kilo: { source: "https://api.kilo.ai/api/openrouter/models", fetchedAt: reviewed, models: [text("kilo-auto/frontier", "Auto Frontier"), text("kilo-auto/balanced", "Auto Balanced"), text("kilo-auto/efficient", "Auto Efficient"), text("kilo-auto/free", "Auto Free")] },
  "byteplus-coding": { source: "https://docs.byteplus.com/en/docs/ModelArk/1976647", fetchedAt: reviewed, models: [text("ark-code-latest", "ARK Code Latest")] },
  "xiaomi-token-plan": { source: "https://models.dev/api.json", fetchedAt: reviewed, models: [text("mimo-v2.5", "MiMo V2.5"), text("mimo-v2.5-pro", "MiMo V2.5 Pro")] },
  "xiaomi-token-plan-ams": { source: "https://models.dev/api.json", fetchedAt: reviewed, models: [text("mimo-v2.5", "MiMo V2.5"), text("mimo-v2.5-pro", "MiMo V2.5 Pro")] },
  "xiaomi-token-plan-sgp": { source: "https://models.dev/api.json", fetchedAt: reviewed, models: [text("mimo-v2.5", "MiMo V2.5"), text("mimo-v2.5-pro", "MiMo V2.5 Pro")] },
  "ollama-cloud": { source: "https://models.dev/api.json", fetchedAt: reviewed, models: [text("gpt-oss:120b", "GPT OSS 120B"), text("deepseek-v4-flash", "DeepSeek V4 Flash")] },
  synthetic: { source: "https://models.dev/api.json", fetchedAt: reviewed, models: [text("hf:MiniMaxAI/MiniMax-M3", "MiniMax M3"), text("hf:moonshotai/Kimi-K3", "Kimi K3")] },
};

export const ACCESS: Record<string, { paid: boolean; free: boolean; note: string; source: string }> = {
  chutes: { paid: true, free: false, note: "Subscription and pay-as-you-go are separate; this integration reads subscription windows when present.", source: "https://chutes.ai/pricing" },
  venice: { paid: true, free: true, note: "API inference can consume DIEM or USD; a balance is not a subscription quota.", source: "https://docs.venice.ai/api-reference/endpoint/billing/get_balance" },
  kilo: { paid: true, free: true, note: "Kilo Pass allowance is separate from gateway pay-as-you-go credits; Auto Free is also available.", source: "https://kilo.ai/docs/code-with-ai/agents/kilo-pass" },
  "byteplus-coding": { paid: true, free: false, note: "Coding Plan subscription; ordinary ModelArk pay-as-you-go balances are outside this quota surface.", source: "https://docs.byteplus.com/en/docs/ModelArk/1976647" },
  "xiaomi-token-plan": { paid: true, free: false, note: "Token Plan subscription; ordinary API billing is distinct.", source: "https://platform.xiaomimimo.com/#/docs/pricing" },
  "xiaomi-token-plan-ams": { paid: true, free: false, note: "European Token Plan subscription; ordinary API billing is distinct.", source: "https://platform.xiaomimimo.com/#/docs/pricing" },
  "xiaomi-token-plan-sgp": { paid: true, free: false, note: "Singapore Token Plan subscription; ordinary API billing is distinct.", source: "https://platform.xiaomimimo.com/#/docs/pricing" },
  "ollama-cloud": { paid: true, free: true, note: "Cloud plans include monthly usage; API keys do not expose the plan meter.", source: "https://ollama.com/pricing" },
  synthetic: { paid: true, free: false, note: "Subscription quota lanes are returned by the quota API.", source: "https://dev.synthetic.new/docs/synthetic/quotas" },
};

type Json = Record<string, unknown>;
const object = (v: unknown): Json | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
const firstNumber = (o: Json, keys: string[]) => keys.map(k => number(o[k])).find(v => v !== undefined);
const date = (v: unknown): number | undefined => { if (typeof v === "number") return v > 1e12 ? v : v * 1000; if (typeof v === "string") { const n = Date.parse(v); return Number.isNaN(n) ? undefined : n; } };
// Fields named `*_percent` are percentages. Never guess that a small value is a 0..1 fraction.
const pct = (used?: number, limit?: number, explicit?: number): number | undefined => explicit !== undefined ? Math.max(0, Math.min(100, explicit)) : used !== undefined && limit !== undefined && limit > 0 ? Math.max(0, Math.min(100, used / limit * 100)) : used !== undefined && limit === 0 ? 100 : undefined;

function windowFrom(value: unknown, label?: string): UsageWindow | undefined {
  const o = object(value); if (!o) return;
  const limit = firstNumber(o, ["limit", "total", "quota", "max", "allowance"]);
  const remaining = firstNumber(o, ["remaining", "left", "available"]);
  const used = firstNumber(o, ["used", "usage", "requests", "tokens", "consumed", "spent"]) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
  const usedPercent = pct(used, limit, firstNumber(o, ["usedPercent", "used_percent", "usagePercent", "usage_percent", "percent_used"]));
  if (usedPercent === undefined) return;
  const minutes = firstNumber(o, ["window_minutes", "windowMinutes", "period_minutes"]);
  const seconds = firstNumber(o, ["window_seconds", "windowSeconds", "period_seconds"]);
  return { label, usedPercent, windowSeconds: seconds ?? (minutes !== undefined ? minutes * 60 : undefined), resetAt: date(o.resets_at ?? o.reset_at ?? o.resetAt ?? o.nextBillingAt ?? o.nextRenewalAt) };
}

export function parseChutesUsage(payload: unknown, now = Date.now()): UsageSnapshot {
  const root = object(payload) ?? {}; const data = object(root.data) ?? root;
  const rolling = windowFrom(data.rolling ?? data.rolling_window ?? data.four_hour ?? data.four_hour_quota, "4-hour quota");
  const monthly = windowFrom(data.monthly ?? data.monthly_usage ?? data.monthly_quota ?? data.subscription, "Monthly subscription");
  const quotas = Array.isArray(data.quotas) ? data.quotas.map((q, i) => windowFrom(q, `Quota ${i + 1}`)).filter((q): q is UsageWindow => !!q) : [];
  const quotaMonthly = quotas.find(q => (q.windowSeconds ?? 0) >= 28 * 86400);
  const quotaRolling = quotas.find(q => q !== quotaMonthly);
  return { primary: rolling ?? quotaRolling, monthly: monthly ?? quotaMonthly, allowances: quotas.map((q, i) => ({ ...q, label: q.label ?? `Quota ${i + 1}` })), quotaStatus: rolling || monthly || quotas.length ? "available" : "unsupported", quotaMessage: rolling || monthly || quotas.length ? undefined : "Chutes returned no recognized subscription quota windows.", fetchedAt: now };
}

export function parseVeniceBalance(payload: unknown, now = Date.now()): UsageSnapshot {
  const root = object(payload) ?? {}; const balances = object(root.balances) ?? {};
  const currency = typeof root.consumptionCurrency === "string" ? root.consumptionCurrency.toLowerCase() : undefined;
  const diem = number(balances.diem), usd = number(balances.usd); const remaining = currency === "usd" ? usd : currency === "diem" ? diem : diem ?? usd;
  return remaining === undefined ? { fetchedAt: now, quotaStatus: "unsupported", quotaMessage: "Venice returned no usable DIEM or USD balance." } : { balance: { remaining, unit: currency?.toUpperCase() ?? (diem !== undefined ? "DIEM" : "USD") }, fetchedAt: now, quotaStatus: "available" };
}

function walk(value: unknown, key: string): unknown[] { const out: unknown[] = []; if (Array.isArray(value)) for (const item of value) out.push(...walk(item, key)); else { const o = object(value); if (o) for (const [k, v] of Object.entries(o)) { if (k === key) out.push(v); out.push(...walk(v, key)); } } return out; }
export function parseKiloUsage(payload: unknown, now = Date.now()): UsageSnapshot {
  const pass = walk(payload, "subscription").map(object).find(Boolean); const blocks = walk(payload, "creditBlocks").find(Array.isArray) as unknown[] | undefined;
  let balance = 0, total = 0; for (const raw of blocks ?? []) { const b = object(raw) ?? {}; balance += (number(b.balance_mUsd) ?? 0) / 1e6; total += (number(b.amount_mUsd) ?? 0) / 1e6; }
  const passUsed = pass ? number(pass.currentPeriodUsageUsd) : undefined; const passTotal = pass ? (number(pass.currentPeriodBaseCreditsUsd) ?? 0) + (number(pass.currentPeriodBonusCreditsUsd) ?? 0) : undefined;
  const passWindow = pass ? { label: "Kilo Pass", usedPercent: pct(passUsed, passTotal), resetAt: date(pass.nextBillingAt ?? pass.nextRenewalAt) } : undefined;
  if (!blocks && !pass) return { fetchedAt: now, quotaStatus: "unsupported", quotaMessage: "Kilo returned no gateway credits or Kilo Pass subscription." };
  return { balance: blocks ? { remaining: Math.max(0, balance), unit: "USD" } : undefined, spend: blocks && total ? { amount: Math.max(0, total - balance), unit: "USD" } : undefined, allowances: passWindow ? [passWindow] : undefined, fetchedAt: now, quotaStatus: "available" };
}

export function parseSyntheticUsage(payload: unknown, now = Date.now()): UsageSnapshot {
  const root = object(payload) ?? {}; const data = object(root.data) ?? root;
  const primary = windowFrom(data.rollingFiveHourLimit, "Five-hour quota"); const secondary = windowFrom(data.weeklyTokenLimit, "Weekly tokens"); const tools = windowFrom(object(data.search)?.hourly, "Search hourly");
  return primary || secondary || tools ? { primary, secondary, tools, fetchedAt: now, quotaStatus: "available" } : { fetchedAt: now, quotaStatus: "unsupported", quotaMessage: "Synthetic returned no recognized quota lanes." };
}

async function getJSON(url: string, account: Account, signal: AbortSignal): Promise<unknown> { const response = await fetch(url, { signal, redirect: "error", headers: { authorization: `Bearer ${account.accessToken}`, accept: "application/json" } }); if (!response.ok) throw new Error(`Quota request failed (${response.status})`); return response.json(); }
const unsupported = (message: string) => async (_account: Account, _signal: AbortSignal): Promise<UsageSnapshot> => ({ fetchedAt: Date.now(), quotaStatus: "unsupported", quotaMessage: message });

export const QUOTA_FETCHERS: Record<string, (account: Account, signal: AbortSignal) => Promise<UsageSnapshot>> = {
  chutes: async (a, s) => {
    const subscription = parseChutesUsage(await getJSON("https://api.chutes.ai/users/me/subscription_usage", a, s));
    if (subscription.primary && subscription.monthly) return subscription;
    let quotas: UsageSnapshot;
    try { quotas = parseChutesUsage(await getJSON("https://api.chutes.ai/users/me/quotas", a, s)); }
    catch { return subscription; }
    const available = subscription.quotaStatus === "available" || quotas.quotaStatus === "available";
    return { ...subscription, primary: subscription.primary ?? quotas.primary, monthly: subscription.monthly ?? quotas.monthly, allowances: quotas.allowances, quotaStatus: available ? "available" : "unsupported", quotaMessage: available ? undefined : "Chutes returned no recognized subscription quota windows." };
  },
  venice: async (a, s) => parseVeniceBalance(await getJSON("https://api.venice.ai/api/v1/billing/balance", a, s)),
  kilo: async (a, s) => { const procedures = "user.getCreditBlocks,kiloPass.getState"; const input = encodeURIComponent(JSON.stringify({ 0: { json: null }, 1: { json: null } })); return parseKiloUsage(await getJSON(`https://app.kilo.ai/api/trpc/${procedures}?batch=1&input=${input}`, a, s)); },
  "byteplus-coding": unsupported("BytePlus does not document a Coding Plan quota endpoint available to its inference API key. Check the Coding Plan console."),
  "xiaomi-token-plan": unsupported("Xiaomi does not document a Token Plan quota endpoint available to its inference API key. Check the MiMo platform console."),
  "xiaomi-token-plan-ams": unsupported("Xiaomi does not document a Token Plan quota endpoint available to its European inference API key. Check the MiMo platform console."),
  "xiaomi-token-plan-sgp": unsupported("Xiaomi does not document a Token Plan quota endpoint available to its Singapore inference API key. Check the MiMo platform console."),
  "ollama-cloud": unsupported("Ollama API keys can run cloud models but cannot read included-plan usage; that meter requires an ollama.com browser session cookie."),
  synthetic: async (a, s) => parseSyntheticUsage(await getJSON("https://api.synthetic.new/v2/quotas", a, s)),
};
