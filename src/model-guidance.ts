export type GuidanceRoute = { source: 'provider' | 'local' | 'cloud'; label: string; modelId: string; ready: boolean; accountId?: string };
export type GuidanceEntry = { id: string; name: string; routes: GuidanceRoute[] };

export const GUIDANCE_VERSION = '2026-09-14.1';
export const MODEL_VIEW_KEY = 'multivibe.models.view.v1';
export type ModelView = 'guided' | 'compare' | 'expert';
export type ModelNeed = 'writing' | 'coding' | 'documents';
export const modelNeeds: { id: ModelNeed; label: string }[] = [
  { id: 'writing', label: 'Chat and write' },
  { id: 'coding', label: 'Code' },
  { id: 'documents', label: 'Work with documents' },
];
export function modelView(value: unknown): ModelView {
  return value === 'compare' || value === 'expert' ? value : 'guided';
}
// Exact reviewed identities only. Never infer capabilities from a family substring,
// a publisher, a public catalog's availability flag, or a speed measurement.
const selections: { ids: string[]; needs: ModelNeed[]; source: string; reason: Partial<Record<ModelNeed, string>> }[] = [
  { ids: ['gpt-5', 'openai/gpt-5', 'openrouter/openai/gpt-5'], needs: ['writing', 'coding', 'documents'],
    source: 'https://developers.openai.com/api/docs/models/gpt-5', reason: {
      writing: 'A versatile option for writing and rewording.', coding: 'Documented coding capabilities.', documents: 'Analyze and summarize text from your documents.',
    } },
  { ids: ['claude-sonnet-4-20250514', 'anthropic/claude-sonnet-4', 'openrouter/anthropic/claude-sonnet-4'], needs: ['coding'],
    source: 'https://www.anthropic.com/news/claude-4', reason: { coding: 'Documented coding capabilities.' } },
  { ids: ['qwen2.5:0.5b', 'hf:qwen/qwen2.5-0.5b-instruct', 'Qwen/Qwen2.5-0.5B-Instruct'], needs: ['writing'],
    source: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct', reason: { writing: 'A small option for simple conversations; check its answers.' } },
];
export type GuidedChoice = {
  model: GuidanceEntry; route: GuidanceRoute; need: ModelNeed; access: 'usable'; reason: string;
  cost: { label: string; amount: number | null; unit: string | null };
  data: string; speed: { label: string; kind: 'unknown'; measuredAt: null };
  dependency: string; evidence: { source: string; reviewedAt: string; version: string };
};
export function relevantChoices(catalog: GuidanceEntry[], need: ModelNeed): GuidedChoice[] {
  return catalog.flatMap(model => {
    const selection = selections.find(item => item.needs.includes(need) && (item.ids.includes(model.id) || model.routes.some(route => item.ids.includes(route.modelId))));
    if (!selection) return [];
    // Chat currently accepts a model ID, not an account pin. Do not promise a
    // data destination when that same ID can route to multiple accounts.
    if (new Set(model.routes.filter(route => route.ready).map(route => route.accountId)).size > 1) return [];
    // Keep each route: a public reference cannot unlock a connected route.
    return model.routes.filter(route => route.ready && Boolean(route.accountId) && selection.ids.includes(route.modelId)).map(route => ({
      model, route, need, access: 'usable' as const, reason: selection.reason[need]!,
      cost: { label: route.source === 'local' ? 'Hardware and electricity' : 'Price needs checking', amount: null, unit: null },
      data: route.source === 'local' ? 'Processed on the Host computer' : `Data sent to ${route.label}`,
      speed: { label: 'Speed needs checking', kind: 'unknown' as const, measuredAt: null },
      dependency: route.source === 'local' ? 'Host computer required' : 'Internet and remote service required',
      evidence: { source: selection.source, reviewedAt: '2026-09-14', version: GUIDANCE_VERSION },
    }));
  }).sort((a, b) => a.model.name.localeCompare(b.model.name) || a.route.label.localeCompare(b.route.label));
}
export function recommendedChoices(choices: GuidedChoice[]): GuidedChoice[] {
  if (!choices.length) return [];
  const first = choices[0];
  const otherMode = choices.find(choice => (choice.route.source === 'local') !== (first.route.source === 'local'));
  const result = [first];
  if (otherMode) result.push(otherMode);
  for (const choice of choices) {
    if (result.length === 3) break;
    if (!result.includes(choice) && !result.some(item => item.model.id === choice.model.id && item.route.source === choice.route.source)) result.push(choice);
  }
  return result;
}

export type CloudAccess = { status: 'available' | 'disconnected' | 'access_denied' | 'unavailable'; modelIds: string[]; checkedAt: string };
export function verifiedCloudCatalog<T extends GuidanceEntry>(catalog: T[], access: CloudAccess | undefined, connected: boolean): T[] {
  return catalog.map(model => ({ ...model, routes: model.routes.map(route => ({ ...route,
    ready: route.ready && (route.source !== 'cloud' || (connected && access?.status === 'available' && access.modelIds.includes(route.modelId))),
  })) }));
}
