import { isModelConversion } from './model-variants.js';
import { runtimeMemory, type RecommendationEvidence } from './model-recommendation-evidence.js';
/** Pure catalog projection. Source metadata is evidence, never execution permission. */
export const RANKING_VERSION = '2026-09-15.1';
export const catalogSorts = ['recommended', 'benchmark', 'trending', 'downloads', 'newest', 'established', 'community'] as const;
export type CatalogSort = typeof catalogSorts[number];
export type CatalogNeed = 'writing' | 'coding' | 'translation' | 'documents';
export type OpenModel = {
  metadataCheckedAt?: string;
  quantization?: string | null;
  lineageAmbiguous?: boolean;
  revision?: string | null;
  communityUsage?: import('./community-model-usage.js').CommunityUsage;
  id: string; url: string; license: string; createdAt: string | null; downloads: number | null;
  gated: boolean; needs: CatalogNeed[]; languages: string[]; parent: string | null;
  relation: string | null; formats: string[]; files: { name: string; bytes: number | null; sha256?: string | null }[];
  architecture: string | null; context: number | null; trendingRank: number | null;
};
export type OpenModelCatalog = { familyChecks?: Record<string,string>; failedFeeds?: number; models: OpenModel[]; checkedAt: string; stale: boolean; source: string; version: string; communityStatus?: 'available' | 'unavailable' };
export type RuntimeEstimate = { model_id: string; aliases: string[]; variant: string; state: 'compatible' | 'insufficient' | 'unknown'; reason: string; memory?: { device: string; model_mib: number; context_mib: number; compute_mib: number }[] };
export function groupModels(models: OpenModel[]) {
  const byId = new Map(models.map(m => [m.id, m]));
  const groups = new Map<string, { model: OpenModel; variants: OpenModel[]; familyStatus: 'model' | 'resolved' | 'unresolved' }>();
  for (const model of models) {
    let canonical = model;
    const seen = new Set<string>();
    let unresolved = false;
    while (isModelConversion(canonical)) {
      if (seen.has(canonical.id) || canonical.lineageAmbiguous || !canonical.parent || !['quantized','converted'].includes(canonical.relation ?? '') || !byId.has(canonical.parent)) { unresolved = true; break; }
      seen.add(canonical.id); canonical = byId.get(canonical.parent)!;
    }
    if (unresolved) canonical = model;
    const group = groups.get(canonical.id) ?? {model:canonical, variants:[], familyStatus:unresolved ? 'unresolved' : 'model'};
    if (canonical.id !== model.id) group.familyStatus = 'resolved';
    group.variants.push(model); groups.set(canonical.id,group);
  }
  return [...groups.values()].map(group => ({...group,variants:group.variants.sort((a,b)=>Number(b.id===group.model.id)-Number(a.id===group.model.id) || (b.downloads ?? -1)-(a.downloads ?? -1) || a.id.localeCompare(b.id))}));
}

export function rankOpenModels(catalog: OpenModelCatalog, need: CatalogNeed, sort: CatalogSort, estimates: RuntimeEstimate[] = [], now = Date.now(), evidence?: RecommendationEvidence) {
  let rows = groupModels(catalog.models).filter(g => g.model.needs.includes(need) || (g.familyStatus === 'resolved' && g.variants.some(v=>v.needs.includes(need)))).map(g => {
    const variants = g.variants.map(model => {
      const matches = estimates.filter(e => [e.model_id, ...(e.aliases ?? [])].includes(model.id));
      const estimate = matches.length === 1 ? matches[0] : undefined;
      const memory = runtimeMemory(estimate, evidence?.memory);
      return { model, memory, estimateVariant: estimate?.variant ?? null, compatibility: memory.state, reason: estimate?.reason ?? 'Host has no memory estimate for this variant. Discovery alone cannot confirm that it fits or can be installed.' };
    });
    const fit = !g.model.gated && [...variants].sort((a,b) => (a.memory.requiredMiB ?? Infinity)-(b.memory.requiredMiB ?? Infinity)).find(v => !v.model.gated && v.compatibility === 'compatible');
    const measured = fit || variants.find(v => v.memory.requiredMiB !== null);
    const benchmark = evidence?.scores.get(g.model.id) ?? null;
    return { ...g, variants, benchmark, memory: measured ? { ...measured.memory, variant: measured.model.id } : null, selectedVariant: fit ? fit.model.id : null,
      compatibility: fit ? 'compatible' : variants.every(v => v.compatibility === 'insufficient') ? 'insufficient' : 'unknown',
      access: g.model.gated ? 'restricted' : 'reference',
      reason: `Publisher metadata supports ${need === 'documents' ? 'text summarization or analysis' : need}. ${fit ? 'A runtime estimate fits the available memory.' : variants.every(v => v.compatibility === 'insufficient') ? 'Runtime estimates exceed the memory limit.' : 'Compatibility is not verified.'}` };
  });
  const downloads = (m: OpenModel) => m.downloads ?? -1;
  if (sort === 'community') rows = rows.filter(r => r.model.communityUsage);
  if (sort === 'established') {
    const counts = rows.map(r => r.model.downloads).filter((n): n is number => n !== null).sort((a,b) => b-a);
    const threshold = counts[Math.max(0, Math.ceil(counts.length / 4)-1)] ?? Infinity;
    rows = rows.filter(r => r.model.relation !== 'quantized' && (!r.model.parent || catalog.models.some(m => m.id === r.model.parent)) && r.model.createdAt && now-Date.parse(r.model.createdAt) >= 90*86400000 && downloads(r.model) >= threshold);
  }
  return rows.sort((a,b) => {
    if (sort === 'recommended' || sort === 'benchmark') {
      const eligible = (r: typeof a) => r.access !== 'restricted' && r.compatibility === 'compatible' ? 2 : r.access !== 'restricted' && r.compatibility !== 'insufficient' ? 1 : 0;
      const delta = eligible(b)-eligible(a); if (delta) return delta;
      const scored = Number(Boolean(b.benchmark))-Number(Boolean(a.benchmark)); if (scored) return scored;
      if (a.benchmark && b.benchmark) {
        const score = b.benchmark.score-a.benchmark.score; if (score) return score;
        const memory = (a.memory?.requiredMiB ?? Infinity)-(b.memory?.requiredMiB ?? Infinity); if (memory) return memory;
      }
    }
    if (sort === 'community') return (a.model.communityUsage!.rank - b.model.communityUsage!.rank) || a.model.id.localeCompare(b.model.id);
    if (sort === 'trending') return (a.model.trendingRank ?? Infinity)-(b.model.trendingRank ?? Infinity) || a.model.id.localeCompare(b.model.id);
    if (sort === 'newest') return (b.model.createdAt ?? '').localeCompare(a.model.createdAt ?? '') || a.model.id.localeCompare(b.model.id);
    return downloads(b.model)-downloads(a.model) || a.model.id.localeCompare(b.model.id);
  });
}
