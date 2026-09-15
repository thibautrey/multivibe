const HUGGING_FACE_ORIGIN = "https://huggingface.co";
const ARTIFICIAL_ANALYSIS_ORIGIN = "https://artificialanalysis.ai";
const MODEL_ID = /^[\w.-]+\/[\w.-]+$/u;
const DATASET_ID = /^[\w.-]+\/[\w.-]+$/u;
const AA_SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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

export class ModelBenchmarkError extends Error {
  constructor(public readonly code: "invalid_request" | "not_configured" | "not_found" | "rate_limited" | "forbidden" | "upstream_unavailable") {
    super(code);
  }
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown, max = 2_000): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new ModelBenchmarkError("upstream_unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new ModelBenchmarkError("upstream_unavailable");
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ModelBenchmarkError("upstream_unavailable"); }
}

function upstreamError(response: Response): never {
  if (response.status === 404) throw new ModelBenchmarkError("not_found");
  if (response.status === 403) throw new ModelBenchmarkError("forbidden");
  if (response.status === 429) throw new ModelBenchmarkError("rate_limited");
  throw new ModelBenchmarkError("upstream_unavailable");
}

function sourceType(sourceUrl: string | null, modelId: string): BenchmarkObservation["sourceType"] {
  if (sourceUrl === `${HUGGING_FACE_ORIGIN}/${modelId}`) return "provider";
  if (sourceUrl?.startsWith(`${HUGGING_FACE_ORIGIN}/datasets/`)) return "independent";
  return "community";
}

export function parseHuggingFaceModelResults(modelId: string, value: unknown): BenchmarkObservation[] {
  const root = record(value);
  if (!root || root.id !== modelId || !Array.isArray(root.evalResults)) throw new ModelBenchmarkError("upstream_unavailable");
  return root.evalResults.flatMap((entry: unknown) => {
    const row = record(entry); const data = record(row?.data); const dataset = record(data?.dataset); const source = record(data?.source);
    const benchmarkId = string(dataset?.id, 256); const score = finite(data?.value);
    if (!benchmarkId || !DATASET_ID.test(benchmarkId) || score === null) return [];
    const sourceUrl = string(source?.url);
    return [{
      modelId, benchmarkId, taskId: string(dataset?.task_id, 256), score,
      metric: string(data?.metric, 128), source: "hugging-face" as const,
      sourceType: sourceType(sourceUrl, modelId), verified: row?.verified === true,
      sourceUrl, sourceName: string(source?.name, 256), date: string(data?.date, 64),
      notes: string(data?.notes), filename: string(row?.filename, 1_024),
      pullRequest: Number.isSafeInteger(row?.pullRequest) && row.pullRequest > 0 ? row.pullRequest : null,
    }];
  });
}

export function parseHuggingFaceLeaderboard(datasetId: string, value: unknown, limit: number) {
  if (!Array.isArray(value)) throw new ModelBenchmarkError("upstream_unavailable");
  return value.slice(0, limit).flatMap((entry: unknown) => {
    const row = record(entry); const modelId = string(row?.model_id, 256); const score = finite(row?.value);
    if (!row || !modelId || score === null) return [];
    return [{ datasetId, rank: Number.isSafeInteger(row.rank) && row.rank > 0 ? row.rank : null, modelId, score,
      verified: row.verified === true, source: string(row.source), filename: string(row.filename, 1_024),
      pullRequest: Number.isSafeInteger(row.pull_request) && row.pull_request > 0 ? row.pull_request : null,
      notes: string(row.notes) }];
  });
}

export function createModelBenchmarkClient(options: { fetcher?: typeof fetch; artificialAnalysisApiKey?: string } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const aaKey = options.artificialAnalysisApiKey?.trim() || "";
  const request = async (url: string, headers?: Record<string, string>) => {
    let response: Response;
    try { response = await fetcher(url, { headers, redirect: "error", signal: AbortSignal.timeout(12_000) }); }
    catch { throw new ModelBenchmarkError("upstream_unavailable"); }
    if (!response.ok) upstreamError(response);
    return { value: await boundedJson(response), response };
  };
  return {
    sources() {
      return { sources: [
        { id: "hugging-face", configured: true, access: "public", modelResults: true, leaderboards: true, attributionRequired: true },
        { id: "artificial-analysis", configured: Boolean(aaKey), access: aaKey ? "key-dependent" : "not-configured", modelResults: aaKey ? "tier-dependent" : false, leaderboards: false, attributionRequired: true },
      ] };
    },
    async model(modelId: string) {
      if (!MODEL_ID.test(modelId)) throw new ModelBenchmarkError("invalid_request");
      const url = new URL(`/api/models/${modelId}`, HUGGING_FACE_ORIGIN); url.searchParams.set("expand", "evalResults");
      const { value } = await request(url.href);
      return { modelId, observations: parseHuggingFaceModelResults(modelId, value), source: "hugging-face", fetchedAt: new Date().toISOString() };
    },
    async leaderboard(datasetId: string, limit = 100) {
      if (!DATASET_ID.test(datasetId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ModelBenchmarkError("invalid_request");
      const { value } = await request(new URL(`/api/datasets/${datasetId}/leaderboard`, HUGGING_FACE_ORIGIN).href);
      return { datasetId, entries: parseHuggingFaceLeaderboard(datasetId, value, limit), source: "hugging-face", fetchedAt: new Date().toISOString() };
    },
    async artificialAnalysisModels(page = 1, access: "free" | "full" = "free") {
      if (!aaKey) throw new ModelBenchmarkError("not_configured");
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000 || !["free", "full"].includes(access)) throw new ModelBenchmarkError("invalid_request");
      const pathname = access === "free" ? "/api/v2/language/models/free" : "/api/v2/language/models";
      const url = new URL(pathname, ARTIFICIAL_ANALYSIS_ORIGIN); url.searchParams.set("page", String(page));
      const { value, response } = await request(url.href, { "x-api-key": aaKey });
      const root = record(value);
      if (!root || !Array.isArray(root.data) || !record(root.pagination)) throw new ModelBenchmarkError("upstream_unavailable");
      return { tier: string(root.tier, 32), intelligenceIndexVersion: finite(root.intelligence_index_version), pagination: root.pagination,
        models: root.data, source: "artificial-analysis", attribution: "Artificial Analysis", fetchedAt: new Date().toISOString(),
        rateLimit: { limit: response.headers.get("x-ratelimit-limit"), remaining: response.headers.get("x-ratelimit-remaining"), reset: response.headers.get("x-ratelimit-reset") } };
    },
    async artificialAnalysisModel(slug: string, promptType = "long") {
      if (!aaKey) throw new ModelBenchmarkError("not_configured");
      if (!AA_SLUG.test(slug) || !["medium", "long", "100k", "vision_single_image", "medium_coding", "medium_parallel"].includes(promptType)) throw new ModelBenchmarkError("invalid_request");
      const url = new URL(`/api/v2/language/models/${slug}`, ARTIFICIAL_ANALYSIS_ORIGIN); url.searchParams.set("prompt_type", promptType);
      const { value } = await request(url.href, { "x-api-key": aaKey }); const root = record(value);
      if (!root || !record(root.data)) throw new ModelBenchmarkError("upstream_unavailable");
      return { tier: string(root.tier, 32), intelligenceIndexVersion: finite(root.intelligence_index_version), model: root.data,
        source: "artificial-analysis", attribution: "Artificial Analysis", fetchedAt: new Date().toISOString() };
    },
  };
}

export type ModelBenchmarkClient = ReturnType<typeof createModelBenchmarkClient>;
