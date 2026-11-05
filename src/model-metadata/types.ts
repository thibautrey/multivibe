import type { ModelsDevCost } from "../models-dev-pricing.js";

/** Public metadata only. Catalog identity is provider + exact model id. */
export type CatalogSource = "models.dev" | "langchain" | "litellm" | "pi";
export type ModelFacts = {
  name?: string;
  context?: number;
  inputLimit?: number;
  output?: number;
  input?: string[];
  outputModalities?: string[];
  tools?: boolean;
  reasoning?: boolean;
  efforts?: string[];
  defaultEffort?: string;
  toggle?: boolean;
  budget?: { min?: number; max?: number };
  structuredOutput?: boolean;
  temperature?: boolean;
  cost?: ModelsDevCost;
};
export type Contribution = {
  source: CatalogSource;
  url: string;
  fetchedAt: number;
  provider: string;
  id: string;
  canonicalId?: string;
  facts: ModelFacts;
  /** Original public record: fields we do not understand are not discarded. */
  data: Record<string, unknown>;
};
export type UnifiedModel = ModelFacts & {
  id: string;
  name: string;
  input: string[];
  knowledge: {
    canonicalId?: string;
    sources: Contribution[];
    conflicts: Record<string, Array<{ source: CatalogSource; value: unknown }>>;
  };
};
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default"];
export const object = (v: unknown): Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
export const positive = (v: unknown): number | undefined => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
export const strings = (v: unknown): string[] | undefined => Array.isArray(v) && v.every(x => typeof x === "string") ? [...new Set(v)] : undefined;
export const effortList = (v: unknown): string[] | undefined => strings(v)?.filter(x => EFFORTS.includes(x));
export const modelId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(v);

/** Source priority breaks scalar ties; disagreements remain in the database.
 * Arrays describing accepted efforts/modalities intersect rather than invent support.
 */
export function consolidate(records: Contribution[]): UnifiedModel {
  const rank: Record<CatalogSource, number> = { "models.dev": 0, langchain: 1, litellm: 2, pi: 3 };
  const sources = [...records].sort((a, b) => rank[a.source] - rank[b.source] || a.url.localeCompare(b.url));
  const facts: Record<string, unknown> = {};
  const conflicts: UnifiedModel["knowledge"]["conflicts"] = {};
  const fields = new Set(sources.flatMap(s => Object.keys(s.facts)));
  for (const field of fields) {
    const values = sources.filter(s => s.facts[field as keyof ModelFacts] !== undefined)
      .map(s => ({ source: s.source, value: s.facts[field as keyof ModelFacts] }));
    const unique = new Set(values.map(v => JSON.stringify(v.value)));
    if (unique.size > 1) conflicts[field] = values;
    let value = values[0]?.value;
    if (["efforts", "input", "outputModalities"].includes(field)) {
      const arrays = values.map(v => v.value as string[]);
      value = arrays[0]?.filter(v => arrays.every(a => a.includes(v)));
    } else if (["context", "inputLimit", "output"].includes(field)) {
      value = Math.min(...values.map(v => v.value as number));
    } else if (typeof value === "boolean") {
      // An explicit denial wins over a speculative capability on the same host.
      value = values.every(v => v.value === true);
    }
    if (value !== undefined) facts[field] = value;
  }
  const canonicalIds = [...new Set(sources.map(s => s.canonicalId).filter(Boolean))];
  const result = { ...facts, id: sources[0].id, name: facts.name ?? sources[0].id, input: facts.input ?? [],
    knowledge: { ...(canonicalIds.length === 1 ? { canonicalId: canonicalIds[0] } : {}), sources, conflicts } } as UnifiedModel;
  if (result.defaultEffort && result.efforts && !result.efforts.includes(result.defaultEffort)) delete result.defaultEffort;
  if (result.reasoning === false) { delete result.efforts; delete result.defaultEffort; delete result.toggle; delete result.budget; }
  return result;
}
