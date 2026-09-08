import type { CatalogEntry } from './modelCatalog';

export type CompatibilityState = 'compatible' | 'insufficient' | 'unknown';
export type CompatibilityEstimate = {
  model_id: string; aliases: string[]; variant: string; state: CompatibilityState; reason: string;
  runtime?: string; runtime_version?: string; budget_mib?: number; host_budget_mib?: number;
  memory?: { device: string; model_mib: number; context_mib: number; compute_mib: number }[];
};
export type CompatibilityReport = { schema_version: 'provider-model-compatibility-v1'; context_tokens: number; checked_at: string; models: CompatibilityEstimate[] };

// Exact identities only. Conflicting variants must not produce a positive badge.
export function compatibilityFor(model: CatalogEntry, report?: CompatibilityReport): CompatibilityEstimate | undefined {
  const ids = new Set([model.id, ...model.routes.map(route => route.modelId)]);
  const matches = report?.models.filter(estimate => [estimate.model_id, ...estimate.aliases].some(id => ids.has(id))) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

export const compatibilityLabels: Record<CompatibilityState, string> = {
  compatible: 'Estimated to fit', insufficient: 'Exceeds memory budget', unknown: 'Estimate unavailable',
};
export function compatibilityDetail(estimate?: CompatibilityEstimate): string {
  if (!estimate) return 'No runtime estimate for this exact model variant.';
  const reasons: Record<string, string> = {
    estimator_unavailable: 'The diagnostic runtime is unavailable. Automatic installation requires Host download permission.',
    storage_not_configured: 'Configure Host model storage to enable estimates.',
    model_metadata_unavailable: 'This exact managed variant must already be downloaded. No model is downloaded for this check.',
    device_unavailable: 'The runtime could not identify a supported device.',
    runtime_estimate_unavailable: 'The runtime could not estimate this model at the selected context.',
    memory_budget_unavailable: 'The machine memory budget is unavailable.',
    host_memory_budget_unavailable: 'The RAM budget is unavailable; VRAM alone is insufficient to confirm compatibility.',
    host_memory_budget_exceeded: 'The runtime reports more RAM than the host budget allows.',
    memory_budget_exceeded: 'The runtime reports more memory than the configured budget allows.',
    runtime_memory_estimate: 'Runtime memory estimate within the configured budget.',
  };
  const memory = estimate.memory?.map(row => `${row.device}: ${row.model_mib + row.context_mib + row.compute_mib} MiB (model ${row.model_mib}, context ${row.context_mib}, compute ${row.compute_mib})`).join('; ');
  return [reasons[estimate.reason] ?? 'Estimate unavailable.', estimate.runtime && `${estimate.runtime} ${estimate.runtime_version ?? ''} · ${estimate.variant}`, memory,
    estimate.budget_mib && `Device budget: ${estimate.budget_mib} MiB`].filter(Boolean).join(' ');
}
