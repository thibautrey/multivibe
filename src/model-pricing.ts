import { normalizeModelsDevCost, type ModelsDevCost, type ModelsDevRates } from "./models-dev-pricing.js";
import { isOffPeakAt } from "./off-peak.js";
import type { ModelBillingRate } from "./types.js";

export type ModelPricing = {
  inputPer1M: number;
  cachedInputPer1M?: number;
  cacheWriteInputPer1M?: number;
  outputPer1M: number;
  contextTiers?: Array<ModelPricing & { thresholdTokens: number }>;
  longContext?: {
    thresholdTokens: number;
    inputPer1M: number;
    cachedInputPer1M?: number;
    cacheWriteInputPer1M?: number;
    outputPer1M: number;
  };
};

export let MODEL_PRICING_VERSION = "2026-10-27";
let runtimePricing = new Map<string, ModelPricing>();
/**
 * Operator-set billed rates, keyed by exposed model id. They are kept apart
 * from the upstream catalog so a catalog refresh never erases them, and they
 * take precedence when a trace is priced. Off-peak sits beside the standard
 * rate so the weekly calendar only changes which entry is selected.
 */
type BilledEntry = { standard: ModelPricing; offPeak?: ModelPricing };
let billedPricing = new Map<string, BilledEntry>();

function billingRate(rate: {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
}): ModelPricing {
  return {
    inputPer1M: rate.inputPer1M,
    outputPer1M: rate.outputPer1M,
    ...(rate.cachedInputPer1M !== undefined
      ? { cachedInputPer1M: rate.cachedInputPer1M }
      : {}),
  };
}

function validBillingRate(rate: ModelBillingRate | undefined): boolean {
  if (!rate) return false;
  const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!valid(rate.inputPer1M) || !valid(rate.outputPer1M)) return false;
  if (rate.cachedInputPer1M !== undefined && !valid(rate.cachedInputPer1M)) return false;
  if (rate.offPeak) {
    if (!valid(rate.offPeak.inputPer1M) || !valid(rate.offPeak.outputPer1M)) return false;
    if (rate.offPeak.cachedInputPer1M !== undefined && !valid(rate.offPeak.cachedInputPer1M)) return false;
  }
  return true;
}

export function setModelBillingOverrides(
  overrides: Record<string, ModelBillingRate> | undefined,
): void {
  const next = new Map<string, BilledEntry>();
  for (const [model, rate] of Object.entries(overrides ?? {})) {
    const key = model.trim();
    if (!key || !validBillingRate(rate)) continue;
    next.set(key, {
      standard: billingRate(rate),
      ...(rate.offPeak ? { offPeak: billingRate(rate.offPeak) } : {}),
    });
  }
  billedPricing = next;
}

/**
 * Dated snapshots and `:variant` tags belong to the same billable model, so
 * they inherit its rate. A sibling such as `gpt-5.4-mini` does not: charging it
 * the `gpt-5.4` rate would silently overbill smaller models.
 */
const BILLING_VARIANT_SUFFIX =
  /^(?:-(?:\d{4}(?:-\d{2}(?:-\d{2})?)?|latest)|:[a-z0-9][a-z0-9._-]*)$/i;

function billedEntryFor(model: string): BilledEntry | undefined {
  const exact = billedPricing.get(model);
  if (exact) return exact;
  // A provider-qualified request may use a rate configured on the bare id.
  const slash = model.indexOf("/");
  if (slash !== -1) {
    const bare = billedPricing.get(model.slice(slash + 1));
    if (bare) return bare;
  }
  let match: { key: string; entry: BilledEntry } | undefined;
  for (const [key, entry] of billedPricing) {
    if (!model.startsWith(key)) continue;
    if (!BILLING_VARIANT_SUFFIX.test(model.slice(key.length))) continue;
    if (!match || key.length > match.key.length) match = { key, entry };
  }
  return match?.entry;
}
// Only origin providers may supply bare model IDs. Gateway prices must retain
// their provider prefix; otherwise the same model could inherit a reseller rate.
const ORIGIN_PROVIDERS = new Set(["openai", "anthropic", "google", "deepseek", "xai", "mistral", "cohere", "groq", "cerebras", "perplexity", "z-ai", "zai", "moonshotai", "minimax"]);

function convertRates(cost: ModelsDevRates): ModelPricing {
  return { inputPer1M: cost.input, outputPer1M: cost.output,
    ...(cost.cache_read !== undefined ? { cachedInputPer1M: cost.cache_read } : {}),
    ...(cost.cache_write !== undefined ? { cacheWriteInputPer1M: cost.cache_write } : {}) };
}

export function installModelsDevPricing(providers: Record<string, Array<{ id: string; cost?: ModelsDevCost }>>, fetchedAt: number, providerAliases: Record<string, string> = {}): void {
  const next = new Map<string, ModelPricing>();
  const bare = new Map<string, ModelPricing | null>();
  for (const [provider, models] of Object.entries(providers)) for (const model of models) {
    const cost = normalizeModelsDevCost(model.cost);
    if (!cost) continue;
    const tiers = cost.tiers?.map(tier => ({ ...convertRates(tier), thresholdTokens: tier.tier.size }));
    const pricing = { ...convertRates(cost), ...(tiers?.length ? { contextTiers: tiers } : {}) };
    next.set(`${provider}/${model.id}`, pricing);
    if (ORIGIN_PROVIDERS.has(provider)) bare.set(model.id, bare.has(model.id) ? null : pricing);
  }
  for (const [alias, provider] of Object.entries(providerAliases)) {
    for (const model of providers[provider] ?? []) {
      const pricing = next.get(`${provider}/${model.id}`);
      if (pricing) next.set(`${alias}/${model.id}`, pricing);
    }
  }
  for (const [id, pricing] of bare) if (pricing) next.set(id, pricing);
  runtimePricing = next;
  MODEL_PRICING_VERSION = next.size ? `models.dev:${new Date(fetchedAt).toISOString()}` : "2026-10-27";
}


const UNPRICED_MODELS = new Set([
  // ChatGPT/Codex plan models without a published per-token API price.
  "gpt-5.3-codex-spark",
  "codex-auto-review",
]);

const EXACT_PRICING: Record<string, ModelPricing> = {
  // Image input is priced separately by estimateImageCostUsd.
  // https://developers.openai.com/api/docs/pricing#image-generation
  "gpt-image-2": { inputPer1M: 5, cachedInputPer1M: 1.25, outputPer1M: 30 },
  "gpt-image-2-2026-04-21": { inputPer1M: 5, cachedInputPer1M: 1.25, outputPer1M: 30 },
  "gpt-image-2.5-flare": { inputPer1M: 5, cachedInputPer1M: 1.25, outputPer1M: 30 },
  "gpt-image-2.5-flare-2026-09-08": { inputPer1M: 5, cachedInputPer1M: 1.25, outputPer1M: 30 },
  // Standard API token rates: https://developers.openai.com/api/docs/pricing
  "gpt-4o": { inputPer1M: 5.0, outputPer1M: 15.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1": { inputPer1M: 5.0, outputPer1M: 15.0 },
  "gpt-4.1-mini": { inputPer1M: 0.3, outputPer1M: 1.2 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-5": { inputPer1M: 5.0, outputPer1M: 15.0 },
  "codex-mini-latest": { inputPer1M: 1.5, outputPer1M: 6.0 },
  "gpt-5-codex": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gpt-5.1-codex": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gpt-5.1-codex-max": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gpt-5.1-codex-mini": { inputPer1M: 0.25, outputPer1M: 2.0 },
  "gpt-5.2": { inputPer1M: 1.75, cachedInputPer1M: 0.175, outputPer1M: 14.0 },
  "gpt-5.2-codex": { inputPer1M: 1.75, cachedInputPer1M: 0.175, outputPer1M: 14.0 },
  "gpt-5.3-codex": { inputPer1M: 1.75, cachedInputPer1M: 0.175, outputPer1M: 14.0 },
  "gpt-5.4": {
    inputPer1M: 2.5,
    cachedInputPer1M: 0.25,
    outputPer1M: 15.0,
    longContext: { thresholdTokens: 272_000, inputPer1M: 5.0, cachedInputPer1M: 0.5, outputPer1M: 22.5 },
  },
  "gpt-5.4-mini": { inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 4.5 },
  "gpt-5.5": {
    inputPer1M: 5.0,
    cachedInputPer1M: 0.5,
    outputPer1M: 30.0,
    longContext: { thresholdTokens: 272_000, inputPer1M: 10.0, cachedInputPer1M: 1.0, outputPer1M: 45.0 },
  },
  "gpt-6.1-sol": {
    inputPer1M: 2, cachedInputPer1M: 0.1, cacheWriteInputPer1M: 2.5, outputPer1M: 10,
    longContext: { thresholdTokens: 272_000, inputPer1M: 4, cachedInputPer1M: 0.2, cacheWriteInputPer1M: 5, outputPer1M: 15 },
  },
  "gpt-6-astra": {
    inputPer1M: 10.0,
    cachedInputPer1M: 1.0,
    cacheWriteInputPer1M: 12.5,
    outputPer1M: 50.0,
    longContext: { thresholdTokens: 272_000, inputPer1M: 20.0, cachedInputPer1M: 2.0, cacheWriteInputPer1M: 25.0, outputPer1M: 75.0 },
  },
  "gpt-5.6-sol": { inputPer1M: 5.0, cachedInputPer1M: 0.5, cacheWriteInputPer1M: 6.25, outputPer1M: 30.0 },
  "gpt-5.6-terra": { inputPer1M: 2.0, cachedInputPer1M: 0.2, cacheWriteInputPer1M: 2.5, outputPer1M: 12.0 },
  "gpt-5.6-luna": { inputPer1M: 0.2, cachedInputPer1M: 0.02, cacheWriteInputPer1M: 0.25, outputPer1M: 1.2 },
  "gpt-5.6-cyber": { inputPer1M: 12.5, cachedInputPer1M: 1.25, cacheWriteInputPer1M: 15.625, outputPer1M: 75.0 },
  // OpenAI's daybreak-blue-latest alias currently points to gpt-5.6-sol.
  "daybreak-blue-latest": { inputPer1M: 4.0, cachedInputPer1M: 0.4, cacheWriteInputPer1M: 5.0, outputPer1M: 20.0 },
  "gpt-daybreak-blue-latest": { inputPer1M: 4.0, cachedInputPer1M: 0.4, cacheWriteInputPer1M: 5.0, outputPer1M: 20.0 },
  "gpt-daybreak-red-latest": { inputPer1M: 12.5, cachedInputPer1M: 1.25, cacheWriteInputPer1M: 15.625, outputPer1M: 75.0 },
  // Legacy names retained for historical trace estimates.
  "gpt-5.6": { inputPer1M: 5.0, cachedInputPer1M: 0.5, cacheWriteInputPer1M: 6.25, outputPer1M: 30.0 },
  "gpt-5.6-mini": { inputPer1M: 2.5, cachedInputPer1M: 0.25, cacheWriteInputPer1M: 3.125, outputPer1M: 15.0 },
  "gpt-5.6-nano": { inputPer1M: 1.0, cachedInputPer1M: 0.1, cacheWriteInputPer1M: 1.25, outputPer1M: 6.0 },
  "deepseek-v4-flash": { inputPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-v4-pro": { inputPer1M: 0.435, outputPer1M: 0.87 },
  "deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-reasoner": { inputPer1M: 0.14, outputPer1M: 0.28 }
};

const PREFIX_PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  { prefix: "gpt-4o-mini", pricing: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { prefix: "gpt-4o", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { prefix: "gpt-4.1-mini", pricing: { inputPer1M: 0.3, outputPer1M: 1.2 } },
  { prefix: "gpt-4.1-nano", pricing: { inputPer1M: 0.1, outputPer1M: 0.4 } },
  { prefix: "gpt-4.1", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { prefix: "gpt-5.1-codex-max", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "gpt-5.1-codex-mini", pricing: { inputPer1M: 0.25, outputPer1M: 2.0 } },
  { prefix: "gpt-5.6-sol", pricing: EXACT_PRICING["gpt-5.6-sol"] },
  { prefix: "gpt-5.6-terra", pricing: EXACT_PRICING["gpt-5.6-terra"] },
  { prefix: "gpt-5.6-luna", pricing: EXACT_PRICING["gpt-5.6-luna"] },
  { prefix: "gpt-5.6-cyber", pricing: EXACT_PRICING["gpt-5.6-cyber"] },
  { prefix: "gpt-6.1-sol", pricing: EXACT_PRICING["gpt-6.1-sol"] },
  { prefix: "gpt-6-astra", pricing: EXACT_PRICING["gpt-6-astra"] },
  { prefix: "daybreak-blue", pricing: EXACT_PRICING["daybreak-blue-latest"] },
  { prefix: "gpt-daybreak-blue", pricing: EXACT_PRICING["gpt-daybreak-blue-latest"] },
  { prefix: "gpt-daybreak-red", pricing: EXACT_PRICING["gpt-daybreak-red-latest"] },
  { prefix: "gpt-5.6-mini", pricing: EXACT_PRICING["gpt-5.6-mini"] },
  { prefix: "gpt-5.6-nano", pricing: EXACT_PRICING["gpt-5.6-nano"] },
  { prefix: "gpt-5.6", pricing: EXACT_PRICING["gpt-5.6"] },
  { prefix: "gpt-5.4-mini", pricing: EXACT_PRICING["gpt-5.4-mini"] },
  { prefix: "gpt-5.7", pricing: EXACT_PRICING["gpt-5.7"] },
  { prefix: "gpt-5.3-codex", pricing: EXACT_PRICING["gpt-5.3-codex"] },
  { prefix: "gpt-5.2-codex", pricing: EXACT_PRICING["gpt-5.2-codex"] },
  { prefix: "gpt-5.1-codex", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "gpt-5-codex", pricing: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "codex-mini-latest", pricing: { inputPer1M: 1.5, outputPer1M: 6.0 } },
  { prefix: "gpt-5", pricing: { inputPer1M: 5.0, outputPer1M: 15.0 } },
  { prefix: "deepseek-v4-flash", pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } },
  { prefix: "deepseek-v4-pro", pricing: { inputPer1M: 0.435, outputPer1M: 0.87 } },
  { prefix: "deepseek-chat", pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } },
  { prefix: "deepseek-reasoner", pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } }
];

export function getModelPricing(model?: string, at: number | Date = Date.now()): ModelPricing | undefined {
  if (!model || typeof model !== "string") return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  let m = trimmed;
  const billed = billedEntryFor(m);
  if (billed) return billed.offPeak && isOffPeakAt(at) ? billed.offPeak : billed.standard;
  if (UNPRICED_MODELS.has(m) || (m.startsWith("openai/") && UNPRICED_MODELS.has(m.slice(7)))) return undefined;
  if (runtimePricing.has(m)) return runtimePricing.get(m);
  // Qualified IDs must never fall through to another provider's price.
  let bare = m;
  if (m.startsWith("openai/")) { bare = m.slice(7); if (UNPRICED_MODELS.has(bare)) return undefined; }
  else if (m.includes("/")) return undefined;
  m = bare;
  if (EXACT_PRICING[m]) return EXACT_PRICING[m];
  for (const entry of PREFIX_PRICING) {
    if (entry.prefix === "gpt-6.1-sol") {
      if (/^gpt-6\.1-sol-\d{4}-\d{2}-\d{2}$/.test(m)) return entry.pricing;
    } else if (m.startsWith(entry.prefix)) return entry.pricing;
  }
  return undefined;
}

export function estimateCostUsd(
  model: string | undefined,
  tokensInput = 0,
  tokensOutput = 0,
  tokensInputCached = 0,
  tokensInputCacheWrite = 0,
  at: number | Date = Date.now(),
): number | undefined {
  const pricing = getModelPricing(model, at);
  if (!pricing) return undefined;
  const input = Math.max(0, tokensInput);
  let rate: ModelPricing = pricing;
  if (pricing.contextTiers?.length) {
    for (const tier of pricing.contextTiers) if (input > tier.thresholdTokens) rate = tier;
  } else if (pricing.longContext && input > pricing.longContext.thresholdTokens) rate = pricing.longContext;
  const cachedInput = Math.min(input, Math.max(0, tokensInputCached));
  const cacheWriteInput = Math.min(
    input - cachedInput,
    Math.max(0, tokensInputCacheWrite),
  );
  const uncachedInput = input - cachedInput - cacheWriteInput;
  const cachedInputRate = rate.cachedInputPer1M ?? rate.inputPer1M;
  const cacheWriteInputRate =
    rate.cacheWriteInputPer1M ?? rate.inputPer1M;
  const inCost =
    (uncachedInput / 1_000_000) * rate.inputPer1M +
    (cachedInput / 1_000_000) * cachedInputRate +
    (cacheWriteInput / 1_000_000) * cacheWriteInputRate;
  const outCost = (Math.max(0, tokensOutput) / 1_000_000) * rate.outputPer1M;
  return inCost + outCost;
}

export function estimateCostUsdWithoutCache(
  model: string | undefined,
  tokensInput = 0,
  tokensOutput = 0,
  tokensInputCacheWrite = 0,
  at: number | Date = Date.now(),
): number | undefined {
  return estimateCostUsd(
    model,
    tokensInput,
    tokensOutput,
    0,
    tokensInputCacheWrite,
    at,
  );
}

/** Direct Images API rates; cached discounts only apply to Responses API tools.
 * https://developers.openai.com/api/docs/guides/image-generation#cached-input-pricing
 */
export function estimateImageCostUsd(model: string | undefined, usage: any): number | undefined {
  const id = model?.trim().replace(/^openai\//, "");
  if (!id || !/^gpt-image-(?:2(?:-2026-04-21)?|2\.5-flare(?:-2026-09-08)?)$/.test(id)) return undefined;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const image = usage?.input_tokens_details?.image_tokens ?? 0;
  if (![input, output, image].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) || image > input) return undefined;
  return ((input - image) * 5 + image * 8 + output * 30) / 1_000_000;
}

/** Estimate only measured usage, preserving upstream/previously recorded costs. */
export function estimateTraceCostUsd(trace: {
  model?: string; resolvedModel?: string; usageStatus?: string; costStatus?: string; costUsd?: number;
  usage?: unknown; route?: string;
  at?: number; startedAt?: number; completedAt?: number;
  tokensInput?: number; tokensOutput?: number; tokensInputCached?: number; tokensInputCacheWrite?: number;
}): number | undefined {
  if (typeof trace.costUsd === "number" && Number.isFinite(trace.costUsd)) return trace.costUsd;
  if (trace.usageStatus === "missing" || trace.costStatus === "unpriced") return undefined;
  if (trace.route?.includes("/images/")) return estimateImageCostUsd(trace.resolvedModel ?? trace.model, trace.usage);
  return estimateCostUsd(trace.resolvedModel ?? trace.model, trace.tokensInput ?? 0, trace.tokensOutput ?? 0,
    trace.tokensInputCached ?? 0, trace.tokensInputCacheWrite ?? 0,
    trace.startedAt ?? trace.completedAt ?? trace.at);
}
