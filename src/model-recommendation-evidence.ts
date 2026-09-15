import { createDiscoveryMemory, type DiscoveryMemory } from './model-discovery-memory.js';
import { groupModels } from './open-model-ranking.js';
import type { BenchmarkObservation } from './model-benchmarks.js';
import type { CachedModelBenchmarkClient } from './model-benchmark-cache.js';
import type { CatalogNeed, OpenModelCatalog, RuntimeEstimate } from './open-model-ranking.js';

// Compare one named evaluation at a time, never an average of unrelated scales.
export const benchmarkProfiles = [
  { id: 'swe-pro', label: 'SWE-bench Pro', dataset: 'ScaleAI/SWE-bench_Pro', task: 'SWE_Bench_Pro', needs: ['coding'] },
  { id: 'gpqa', label: 'GPQA Diamond', dataset: 'Idavidrein/gpqa', task: 'diamond', needs: ['documents', 'writing'] },
  { id: 'mmlu-pro', label: 'MMLU Pro (general knowledge)', dataset: 'TIGER-Lab/MMLU-Pro', task: 'mmlu_pro', needs: ['writing', 'translation', 'documents'] },
  { id: 'extractbench', label: 'ExtractBench · mean', dataset: 'llamaindex/ExtractBench', task: 'mean', needs: ['documents'] },
  { id: 'hle', label: 'Humanity’s Last Exam', dataset: 'cais/hle', task: 'hle', needs: ['writing', 'documents'] },
] as const;
export type BenchmarkProfile = typeof benchmarkProfiles[number];
// Prefer task relevance over the number of cached evaluations. Writing and
// translation use general knowledge only as a proxy until direct tests exist.
const taskBenchmarks: Record<CatalogNeed, readonly string[]> = {
  coding: ['swe-pro'],
  writing: ['mmlu-pro', 'gpqa', 'hle'],
  translation: ['mmlu-pro'],
  documents: ['extractbench', 'mmlu-pro', 'gpqa', 'hle'],
};
export function selectTaskBenchmark(need: CatalogNeed, options: readonly {id: string; count: number}[]) {
  const preferred = taskBenchmarks[need];
  return preferred.find(id => options.some(option => option.id === id && option.count > 0)) ?? preferred[0];
}
export type ScoredBenchmark = BenchmarkObservation & { label: string; stale: boolean; storedAt: string };
export type MemoryAvailability = { accelerator?: string; freeHostMiB?: number | null; freeDeviceMiB?: number | null; budgetMiB?: number | null; observedAt?: string };
export type RecommendationEvidence = { profile?: BenchmarkProfile; scores: Map<string, ScoredBenchmark>; discoveryMemory?: Map<string, DiscoveryMemory>; memory?: MemoryAvailability };

export function benchmarkScores(records: Awaited<ReturnType<CachedModelBenchmarkClient['cachedModels']>>['models'], profile: BenchmarkProfile) {
  const scores = new Map<string, ScoredBenchmark>();
  for (const record of records) {
    const observations: BenchmarkObservation[] = Array.isArray(record.data?.observations) ? record.data.observations : [];
    const matches = observations.filter(o => o.modelId === record.data.modelId && o.benchmarkId === profile.dataset && o.taskId === profile.task && o.metric === null && Number.isFinite(o.score) && o.score >= 0 && o.score <= 100);
    // Conflicting runs need human interpretation; do not cherry-pick a high score.
    if (!matches.length || new Set(matches.map(o => o.score)).size !== 1) continue;
    const observation = [...matches].sort((a,b) => Number(b.verified)-Number(a.verified) || (b.date ?? '').localeCompare(a.date ?? ''))[0];
    scores.set(observation.modelId, { ...observation, label: profile.label, stale: record.stale, storedAt: record.storedAt });
  }
  return scores;
}

export function runtimeMemory(estimate: RuntimeEstimate | undefined, availability?: MemoryAvailability) {
  if (!estimate?.memory?.length) return { requiredMiB: null, hostMiB: null, deviceMiB: null, state: availability ? 'unknown' as const : estimate?.state ?? 'unknown' };
  const rows = estimate.memory;
  if (rows.some(r => ![r.model_mib, r.context_mib, r.compute_mib].every(n => Number.isFinite(n) && n >= 0))) return { requiredMiB: null, hostMiB: null, deviceMiB: null, state: 'unknown' as const };
  const total = (r: typeof rows[number]) => r.model_mib + r.context_mib + r.compute_mib;
  const hostMiB = rows.filter(r => r.device === 'Host').reduce((n,r) => n + total(r),0);
  const deviceMiB = rows.filter(r => r.device !== 'Host').reduce((n,r) => n + total(r),0);
  const requiredMiB = hostMiB + deviceMiB;
  if (!requiredMiB) return { requiredMiB: null, hostMiB, deviceMiB, state: 'unknown' as const };
  let state = estimate.state;
  const shared = availability?.accelerator === 'metal' || availability?.accelerator === 'cpu';
  if (availability) {
    const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const over = (known(availability.budgetMiB) && requiredMiB >= availability.budgetMiB)
      || (shared ? known(availability.freeHostMiB) && requiredMiB >= availability.freeHostMiB
        : (known(availability.freeHostMiB) && hostMiB >= availability.freeHostMiB && hostMiB > 0) || (known(availability.freeDeviceMiB) && deviceMiB >= availability.freeDeviceMiB && deviceMiB > 0));
    if (over) state = 'insufficient';
    else if (state === 'compatible' && !(known(availability.freeHostMiB) && (shared || known(availability.freeDeviceMiB)))) state = 'unknown';
  }
  return { requiredMiB, hostMiB, deviceMiB, state };
}

export function createRecommendationEvidence(client: CachedModelBenchmarkClient, now = Date.now, estimateDiscovery = createDiscoveryMemory()) {
  const discoveryMemory = new Map<string, DiscoveryMemory>();
  let memoryWarming: Promise<void> | undefined;
  let warming: Promise<void> | undefined;
  const attempted = new Map<string, number>();
  return async (catalog: OpenModelCatalog, need: CatalogNeed, requested?: string) => {
    const snapshot = await client.cachedModels('hugging-face');
    const relevant = groupModels(catalog.models).filter(g=>g.model.needs.includes(need) || g.variants.some(v=>v.needs.includes(need))).flatMap(g=>g.variants);
    const cached = new Map(snapshot.models.map(r => [r.data.modelId, r]));
    if (!warming) {
      const queue = [...relevant].sort((a,b) => (b.downloads ?? 0)-(a.downloads ?? 0)).filter(m => (!cached.has(m.id) || cached.get(m.id)!.stale) && now()-(attempted.get(m.id) ?? -Infinity) >= 30 * 60_000).slice(0,40);
      if (queue.length) warming = (async () => {
        await Promise.all(Array.from({length:4}, async () => {
          while (queue.length) { const model = queue.shift()!; attempted.set(model.id,now()); try { await client.model(model.id); } catch { /* Existing cache stays usable. */ } }
        }));
      })().finally(() => { warming = undefined; });
    }
    const options = benchmarkProfiles.map(profile => {
      const scores = benchmarkScores(snapshot.models,profile);
      return {...profile, count: relevant.filter(m => scores.has(m.id)).length};
    });
    const profile = benchmarkProfiles.find(p => p.id === requested) ?? benchmarkProfiles.find(p => p.id === selectTaskBenchmark(need, options));
    const scores = profile ? benchmarkScores(snapshot.models,profile) : new Map<string, ScoredBenchmark>();
    if (!memoryWarming) {
      const groups = groupModels(catalog.models).filter(g=>g.model.needs.includes(need) || g.variants.some(v=>v.needs.includes(need)))
        .sort((a,b)=>Number(scores.has(b.model.id))-Number(scores.has(a.model.id)) || (b.model.downloads ?? 0)-(a.model.downloads ?? 0));
      const queue = groups.slice(0,24).flatMap(g=>[...g.variants].sort((a,b)=>Number(b.formats.includes('gguf'))-Number(a.formats.includes('gguf'))).slice(0,2).map(model=>({model,original:g.model})));
      memoryWarming = Promise.all(Array.from({length:4},async()=>{
        while(queue.length){const item=queue.shift()!;const value=await estimateDiscovery(item.model,item.original);if(value)discoveryMemory.set(item.model.id,value);else discoveryMemory.delete(item.model.id);}
      })).then(()=>{}).finally(()=>{memoryWarming=undefined;});
    }
    return { profile, scores, discoveryMemory: new Map(discoveryMemory), options,
      coverage: { cachedModels: relevant.filter(m => cached.has(m.id)).length, totalModels: relevant.length, warming: Boolean(warming) } };
  };
}
