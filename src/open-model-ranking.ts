/** Pure catalog projection. Source metadata is evidence, never execution permission. */
export const RANKING_VERSION = '2026-09-14.2';
export const catalogSorts = ['recommended', 'trending', 'downloads', 'newest', 'established', 'community'] as const;
export type CatalogSort = typeof catalogSorts[number];
export type CatalogNeed = 'writing' | 'coding' | 'translation' | 'documents';
export type OpenModel = {
  metadataCheckedAt?: string;
  communityUsage?: import('./community-model-usage.js').CommunityUsage;
  id: string; url: string; license: string; createdAt: string | null; downloads: number | null;
  gated: boolean; needs: CatalogNeed[]; languages: string[]; parent: string | null;
  relation: string | null; formats: string[]; files: { name: string; bytes: number | null }[];
  architecture: string | null; context: number | null; trendingRank: number | null;
};
export type OpenModelCatalog = { models: OpenModel[]; checkedAt: string; stale: boolean; source: string; version: string; communityStatus?: 'available' | 'unavailable' };
export type RuntimeEstimate = { model_id: string; aliases: string[]; variant: string; state: 'compatible' | 'insufficient' | 'unknown'; reason: string };
export function groupModels(models: OpenModel[]) {
  const byId = new Map(models.map(m => [m.id, m]));
  const groups = new Map<string, { model: OpenModel; variants: OpenModel[] }>();
  for (const m of models) {
    // Only explicit quantization relations; absent parents are not invented.
    const parent = m.relation === 'quantized' && m.parent && byId.get(m.parent);
    const canonical = parent && parent.relation !== 'quantized' ? parent : m;
    const group = groups.get(canonical.id) ?? { model: canonical, variants: [] };
    group.variants.push(m); groups.set(canonical.id, group);
  }
  return [...groups.values()];
}
export function rankOpenModels(catalog: OpenModelCatalog, need: CatalogNeed, sort: CatalogSort, estimates: RuntimeEstimate[] = [], now = Date.now()) {
  let rows = groupModels(catalog.models).filter(g => g.model.needs.includes(need)).map(g => {
    const variants = g.variants.map(model => {
      const matches = estimates.filter(e => [e.model_id, ...(e.aliases ?? [])].includes(model.id));
      const estimate = matches.length === 1 ? matches[0] : undefined;
      return { model, compatibility: estimate?.state ?? 'unknown', reason: estimate?.reason ?? 'No runtime estimate for this exact variant.' };
    });
    const fit = !g.model.gated && variants.find(v => !v.model.gated && v.compatibility === 'compatible');
    return { ...g, variants, selectedVariant: fit ? fit.model.id : null,
      compatibility: fit ? 'compatible' : variants.every(v => v.compatibility === 'insufficient') ? 'insufficient' : 'unknown',
      access: g.model.gated ? 'restricted' : 'reference',
      reason: `Publisher metadata supports ${need === 'documents' ? 'text summarization or analysis' : need}. ${fit ? 'A runtime estimate is available.' : 'Compatibility is not verified.'}` };
  });
  const downloads = (m: OpenModel) => m.downloads ?? -1;
  if (sort === 'community') rows = rows.filter(r => r.model.communityUsage);
  if (sort === 'established') {
    const counts = rows.map(r => r.model.downloads).filter((n): n is number => n !== null).sort((a,b) => b-a);
    const threshold = counts[Math.max(0, Math.ceil(counts.length / 4)-1)] ?? Infinity;
    rows = rows.filter(r => r.model.relation !== 'quantized' && (!r.model.parent || catalog.models.some(m => m.id === r.model.parent)) && r.model.createdAt && now-Date.parse(r.model.createdAt) >= 90*86400000 && downloads(r.model) >= threshold);
  }
  return rows.sort((a,b) => {
    if (sort === 'recommended') {
      const eligible = (r: typeof a) => r.access !== 'restricted' && r.compatibility === 'compatible' ? 2 : r.access !== 'restricted' && r.compatibility !== 'insufficient' ? 1 : 0;
      const delta = eligible(b)-eligible(a); if (delta) return delta;
    }
    if (sort === 'community') return (a.model.communityUsage!.rank - b.model.communityUsage!.rank) || a.model.id.localeCompare(b.model.id);
    if (sort === 'trending') return (a.model.trendingRank ?? Infinity)-(b.model.trendingRank ?? Infinity) || a.model.id.localeCompare(b.model.id);
    if (sort === 'newest') return (b.model.createdAt ?? '').localeCompare(a.model.createdAt ?? '') || a.model.id.localeCompare(b.model.id);
    return downloads(b.model)-downloads(a.model) || a.model.id.localeCompare(b.model.id);
  });
}
