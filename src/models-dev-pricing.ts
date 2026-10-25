/** Public models.dev prices are USD per million tokens. Keep this parser shared
 * by the catalog, estimator and durable cache (including context tiers). */
export type ModelsDevRates = { input: number; output: number; cache_read?: number; cache_write?: number };
export type ModelsDevCost = ModelsDevRates & {
  tiers?: Array<ModelsDevRates & { tier: { type: "context"; size: number } }>;
};

function rates(value: unknown): ModelsDevRates | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!valid(source.input) || !valid(source.output)) return;
  return { input: source.input, output: source.output,
    ...(valid(source.cache_read) ? { cache_read: source.cache_read } : {}),
    ...(valid(source.cache_write) ? { cache_write: source.cache_write } : {}) };
}

export function normalizeModelsDevCost(value: unknown): ModelsDevCost | undefined {
  const base = rates(value);
  if (!base) return;
  const raw = value as { tiers?: unknown };
  const tiers: NonNullable<ModelsDevCost["tiers"]> = [];
  if (Array.isArray(raw.tiers)) for (const item of raw.tiers) {
    const rate = rates(item);
    if (rate && item.tier?.type === "context" && Number.isFinite(item.tier.size) && item.tier.size > 0)
      tiers.push({ ...rate, tier: { type: "context", size: item.tier.size } });
  }
  tiers.sort((a, b) => a.tier.size - b.tier.size);
  return { ...base, ...(tiers.length ? { tiers } : {}) };
}
