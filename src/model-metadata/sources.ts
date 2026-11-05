import { normalizeModelsDevCost } from "../models-dev-pricing.js";
import { parseProfiles } from "./python-literal.js";
import { object, positive, strings, effortList, modelId, EFFORTS, type CatalogSource, type Contribution, type ModelFacts } from "./types.js";

export const MODELS_DEV_V2_URL = "https://models.dev/_experimental_v2.0_api.json";
export const SOURCE_URLS = {
  "models.dev": "https://models.dev/api.json",
  litellm: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  pi: "https://pi.dev/api/models",
  langchain: "https://api.github.com/repos/langchain-ai/langchain/git/trees/master?recursive=1",
} as const;
const PROVIDERS: Record<string, string> = { "amazon-bedrock": "amazon-bedrock", bedrock: "amazon-bedrock", azure: "azure", azure_openai: "azure", "google-generative-ai": "google", gemini: "google", "google-vertex": "google-vertex", vertex_ai: "google-vertex", together_ai: "togetherai", fireworks_ai: "fireworks-ai", fireworks: "fireworks-ai", mistralai: "mistral", "x-ai": "xai", "z-ai": "zai", "openai-codex": "openai-codex", "opencode-go": "opencode-go" };
export const providerId = (id: string) => PROVIDERS[id] ?? id;
function compact(facts: ModelFacts): ModelFacts { return Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)); }
const boolean = (v: unknown) => typeof v === "boolean" ? v : undefined;
const modalities = (m: Record<string, any>, suffix: string) => ["text", "image", "audio", "video", "pdf"].filter(k => m[k + suffix] === true);

export function normalizeSource(source: Exclude<CatalogSource, "langchain">, payload: unknown, fetchedAt: number): Contribution[] {
  const out: Contribution[] = [];
  const add = (provider: string, id: string, raw: unknown, facts: ModelFacts, canonical?: unknown) => {
    const data = object(raw);
    if (!modelId(provider) || !modelId(id) || data.status === "deprecated") return;
    out.push({ source, url: SOURCE_URLS[source], fetchedAt, provider: providerId(provider), id,
      ...(modelId(canonical) ? { canonicalId: canonical } : {}), facts: compact(facts), data });
  };
  if (source === "models.dev") {
    for (const [provider, p] of Object.entries(object(payload))) for (const [id, raw] of Object.entries(object(object(p).models))) {
      const m = object(raw), options = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
      const effort = options.find(o => o.type === "effort"), budget = options.find(o => o.type === "budget_tokens");
      add(provider, id, m, { name: m.name, context: positive(m.limit?.context), inputLimit: positive(m.limit?.input), output: positive(m.limit?.output), input: strings(m.modalities?.input), outputModalities: strings(m.modalities?.output), tools: boolean(m.tool_call), reasoning: boolean(m.reasoning), efforts: effort ? effortList(effort.values) : undefined, toggle: options.some(o => o.type === "toggle") ? true : undefined, budget: budget ? { min: positive(budget.min), max: positive(budget.max) } : undefined, structuredOutput: boolean(m.structured_output), temperature: boolean(m.temperature), cost: normalizeModelsDevCost(m.cost) }, m.canonical_model_id);
    }
  } else if (source === "pi") {
    for (const [provider, entries] of Object.entries(object(payload))) for (const [id, raw] of Object.entries(object(entries))) {
      const m = object(raw), map = object(m.thinkingLevelMap);
      // Only explicit native mappings are evidence, not Pi's synthetic fallback levels.
      const native = Object.values(map).filter((v): v is string => typeof v === "string" && EFFORTS.includes(v));
      const cost = object(m.cost);
      add(provider, id, m, { name: m.name, context: positive(m.contextWindow), output: positive(m.maxTokens), input: strings(m.input), tools: boolean(m.tools), reasoning: boolean(m.reasoning), efforts: native.length && ["off", "minimal", "low", "medium", "high"].every(e => Object.hasOwn(map, e)) ? [...new Set(native)] : undefined, cost: Object.keys(cost).length ? normalizeModelsDevCost({ input: cost.input, output: cost.output, cache_read: cost.cacheRead, cache_write: cost.cacheWrite }) : undefined });
    }
  } else {
    for (const [key, raw] of Object.entries(object(payload))) {
      const m = object(raw); if (!m.litellm_provider || (m.mode && !["chat", "responses"].includes(m.mode))) continue;
      const provider = String(m.litellm_provider), prefix = provider + "/", id = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      const cost: Record<string, number> = {};
      for (const [a, b] of Object.entries({ input_cost_per_token: "input", output_cost_per_token: "output", cache_read_input_token_cost: "cache_read", cache_creation_input_token_cost: "cache_write" })) if (typeof m[a] === "number" && m[a] >= 0) cost[b] = m[a] * 1_000_000;
      // Isolated supports_xhigh flags are not a complete allowlist.
      add(provider, id, m, { context: positive(m.max_input_tokens ?? m.max_tokens), output: positive(m.max_output_tokens), input: strings(m.supported_input_modalities), outputModalities: strings(m.supported_output_modalities), tools: boolean(m.supports_function_calling), reasoning: boolean(m.supports_reasoning), efforts: effortList(m.reasoning_effort_levels), defaultEffort: EFFORTS.includes(m.default_reasoning_effort) ? m.default_reasoning_effort : undefined, structuredOutput: boolean(m.supports_response_schema), cost: normalizeModelsDevCost(cost) });
      // Individual capability flags remain available in the original source record.
    }
  }
  if (!out.length) throw Error(`${source} returned no usable models`);
  return out;
}

export function normalizeLangChain(provider: string, text: string, url: string, fetchedAt: number): Contribution[] {
  const profiles = parseProfiles(text), out: Contribution[] = [];
  for (const [id, raw] of Object.entries(profiles)) {
    const m = object(raw); if (!modelId(id) || m.status === "deprecated") continue;
    out.push({ source: "langchain", url, fetchedAt, provider: providerId(provider), id, data: m,
      facts: compact({ name: m.name, context: positive(m.max_input_tokens), output: positive(m.max_output_tokens), input: modalities(m, "_inputs"), outputModalities: modalities(m, "_outputs"), tools: boolean(m.tool_calling), reasoning: boolean(m.reasoning_output), efforts: effortList(m.reasoning_effort_levels), defaultEffort: EFFORTS.includes(m.reasoning_effort_default) ? m.reasoning_effort_default : undefined, structuredOutput: boolean(m.structured_output), temperature: boolean(m.temperature) }) });
  }
  return out;
}

/** Bounded streaming reads: catalog fetches never execute downloaded code. */
export async function fetchText(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<string> {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json, text/plain", "user-agent": "MultiVibe-model-catalog" } });
  if (!response.ok) throw Error(`Catalog returned HTTP ${response.status}`);
  if (!response.body) throw Error("Empty catalog body");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 24 * 1024 * 1024) throw Error("Catalog exceeds 24 MiB"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchSource(source: CatalogSource, fetcher: typeof fetch, timeoutMs: number, now: number): Promise<Contribution[]> {
  const text = await fetchText(fetcher, SOURCE_URLS[source], timeoutMs);
  const payload = JSON.parse(text);
  if (source === "models.dev") {
    const records = normalizeSource(source, payload, now);
    // The stable v1 feed remains usable if the optional experimental v2 feed fails.
    // v2 supplies defaults, MIME modalities and protocol metadata omitted by v1.
    try {
      const v2 = object(JSON.parse(await fetchText(fetcher, MODELS_DEV_V2_URL, timeoutMs)));
      for (const record of records) {
        const m = object(object(object(v2[record.provider]).models)[record.id]);
        if (!Object.keys(m).length) continue;
        record.data = { ...record.data, models_dev_v2: m };
        const reasoning = object(object(m.capabilities).reasoning), defaults = object(reasoning.default);
        if (defaults.type === "effort" && EFFORTS.includes(defaults.value)) record.facts.defaultEffort = defaults.value;
        if (modelId(m.canonical_id) && !record.canonicalId) record.canonicalId = m.canonical_id;
      }
    } catch { /* Preserve stable data; optional format is not a startup dependency. */ }
    return records;
  }
  if (source !== "langchain") return normalizeSource(source, payload, now);
  const tree = object(payload);
  if (tree.truncated || !Array.isArray(tree.tree)) throw Error("Incomplete LangChain tree");
  const paths = tree.tree.map((e: any) => e.path).filter((p: unknown): p is string => typeof p === "string" && /^libs\/partners\/[a-z0-9_]+\/langchain_[a-z0-9_]+\/data\/_profiles\.py$/.test(p));
  if (!paths.length || paths.length > 100) throw Error("Invalid LangChain profile index");
  const records: Contribution[] = [];
  // Four files at a time; failed files retain the entire last good LangChain snapshot.
  for (let i = 0; i < paths.length; i += 4) {
    const batches = await Promise.all(paths.slice(i, i + 4).map(async p => {
      const url = `https://raw.githubusercontent.com/langchain-ai/langchain/${tree.sha}/${p}`;
      return normalizeLangChain(p.split("/")[2], await fetchText(fetcher, url, timeoutMs), url, now);
    }));
    records.push(...batches.flat());
  }
  if (!records.length) throw Error("LangChain returned no profiles");
  return records;
}
