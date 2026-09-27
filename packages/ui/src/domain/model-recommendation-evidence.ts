import type {RuntimeEstimate, CatalogNeed} from './open-model-ranking.js';
import type {MemoryEstimateReport, DiscoveryMemory} from './model-discovery-memory.js';
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
export type BenchmarkObservation = {
  modelId: string;
  benchmarkId: string;
  taskId: string | null;
  score: number;
  metric: string | null;
  source: "hugging-face" | "artificial-analysis";
  sourceType: "independent" | "provider" | "community";
  verified: boolean;
  sourceUrl: string | null;
  sourceName: string | null;
  date: string | null;
  notes: string | null;
  filename: string | null;
  pullRequest: number | null;
};

export type ScoredBenchmark = BenchmarkObservation & {label:string;stale:boolean;storedAt:string};
export type MemoryAvailability = { totalHostMiB?: number; accelerator?: string; freeHostMiB?: number | null; freeDeviceMiB?: number | null; budgetMiB?: number | null; observedAt?: string };
export type RecommendationEvidence = { profile?: BenchmarkProfile; scores: Map<string, ScoredBenchmark>; discoveryMemory?: Map<string, DiscoveryMemory>; artifactMemory?: Map<string, DiscoveryMemory[]>; memoryReports?: Record<string,MemoryEstimateReport>; memory?: MemoryAvailability };

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

