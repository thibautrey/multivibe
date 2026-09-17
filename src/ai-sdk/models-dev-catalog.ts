import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SDK_PROVIDERS, sdkProvider } from "./providers.js";

/** Runtime models.dev metadata for reviewed SDK providers.
 *
 * The generated `catalog.generated.ts` snapshot stays the offline fallback, but
 * at runtime the Host refreshes provider metadata from the public models.dev
 * catalog so a newly released model gets context, pricing, tool and modality
 * metadata without shipping a new build. The snapshot is cached on disk and
 * refreshed with a stale-while-revalidate window; failures keep the last good
 * snapshot and never block model listing.
 */

export const MODELS_DEV_SOURCE_URL = "https://models.dev/api.json";

function envMilliseconds(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

export const SDK_MODELS_DEV_TTL_MS = envMilliseconds(
  process.env.SDK_MODELS_DEV_TTL_MS,
  24 * 60 * 60_000,
  10 * 60_000,
);
export const SDK_MODELS_DEV_TIMEOUT_MS = envMilliseconds(
  process.env.SDK_MODELS_DEV_TIMEOUT_MS,
  30_000,
  1_000,
);
const SDK_MODELS_DEV_MAX_BYTES = 20_000_000;
const SDK_MODELS_DEV_MAX_MODELS_PER_PROVIDER = 5_000;
const SDK_MODELS_DEV_CACHE_VERSION = 1;
const SDK_MODELS_DEV_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
/** Only reviewed providers are cached; models.dev lists hundreds more. */
const REVIEWED_MODELS_DEV_IDS = new Set(SDK_PROVIDERS.map((provider) => provider.modelsDevId ?? provider.id));

export type ModelsDevModel = {
  id: string;
  name: string;
  context?: number;
  output?: number;
  tools?: boolean;
  reasoning?: boolean;
  input: string[];
  cost?: Record<string, number>;
};

export type ModelsDevProviderModels = {
  source: string;
  fetchedAt: string;
  models: ModelsDevModel[];
};

export type ModelsDevCatalogState = {
  source: string;
  fetchedAt?: string;
  stale: boolean;
  lastError?: string;
  providerCount: number;
};

type ModelsDevCatalogOptions = {
  fetch?: typeof fetch;
  cachePath?: string;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

type ModelsDevCache = {
  version: number;
  source: string;
  fetchedAt: number;
  providers: Record<string, ModelsDevModel[]>;
};

function normalizeModel(value: unknown): ModelsDevModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = value as {
    id?: unknown;
    name?: unknown;
    status?: unknown;
    tool_call?: unknown;
    reasoning?: unknown;
    modalities?: { input?: unknown; output?: unknown };
    limit?: { context?: unknown; output?: unknown };
    cost?: unknown;
  };
  if (model.status === "deprecated") return undefined;
  if (typeof model.id !== "string" || !MODEL_ID_PATTERN.test(model.id)) return undefined;
  const output = model.modalities?.output;
  if (!Array.isArray(output) || !output.some((modality) => modality === "text")) return undefined;
  const input = Array.isArray(model.modalities?.input)
    ? model.modalities.input.filter((modality): modality is string => typeof modality === "string").slice(0, 16)
    : ["text"];
  const context = Number(model.limit?.context);
  const maximumOutput = Number(model.limit?.output);
  const cost = model.cost && typeof model.cost === "object" && !Array.isArray(model.cost)
    ? Object.fromEntries(Object.entries(model.cost).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0))
    : undefined;
  return {
    id: model.id,
    name: String(model.name ?? model.id).slice(0, 200),
    ...(Number.isFinite(context) && context > 0 ? { context } : {}),
    ...(Number.isFinite(maximumOutput) && maximumOutput > 0 ? { output: maximumOutput } : {}),
    tools: model.tool_call === true,
    reasoning: model.reasoning === true,
    input: input.length ? input : ["text"],
    ...(cost && Object.keys(cost).length ? { cost } : {}),
  };
}

function normalizeStoredModel(value: unknown): ModelsDevModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = value as Partial<ModelsDevModel>;
  if (typeof model.id !== "string" || !MODEL_ID_PATTERN.test(model.id)) return undefined;
  if (typeof model.name !== "string" || !Array.isArray(model.input) || !model.input.every((item) => typeof item === "string")) return undefined;
  const cost = model.cost && typeof model.cost === "object" && !Array.isArray(model.cost)
    ? Object.fromEntries(Object.entries(model.cost).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0))
    : undefined;
  return {
    id: model.id,
    name: model.name.slice(0, 200),
    ...(typeof model.context === "number" && Number.isFinite(model.context) && model.context > 0 ? { context: model.context } : {}),
    ...(typeof model.output === "number" && Number.isFinite(model.output) && model.output > 0 ? { output: model.output } : {}),
    tools: model.tools === true,
    reasoning: model.reasoning === true,
    input: model.input.slice(0, 16),
    ...(cost && Object.keys(cost).length ? { cost } : {}),
  };
}

export class ModelsDevCatalog {
  private readonly fetchImpl: typeof fetch;
  private readonly cachePath?: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private providers = new Map<string, ModelsDevModel[]>();
  private fetchedAt = 0;
  private nextRefreshAt = 0;
  private lastError?: string;
  private inFlight?: Promise<boolean>;
  private loaded = false;
  private loadPromise?: Promise<void>;

  constructor(options: ModelsDevCatalogOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.cachePath = options.cachePath;
    this.ttlMs = options.ttlMs ?? SDK_MODELS_DEV_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? SDK_MODELS_DEV_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Runtime metadata for one reviewed provider, when models.dev covers it. */
  catalogFor(providerId: string): ModelsDevProviderModels | undefined {
    const modelsDevId = sdkProvider(providerId)?.modelsDevId ?? providerId;
    const models = this.providers.get(modelsDevId);
    if (!models?.length) return undefined;
    return {
      source: MODELS_DEV_SOURCE_URL,
      fetchedAt: new Date(this.fetchedAt).toISOString(),
      models,
    };
  }

  state(): ModelsDevCatalogState {
    return {
      source: MODELS_DEV_SOURCE_URL,
      ...(this.fetchedAt ? { fetchedAt: new Date(this.fetchedAt).toISOString() } : {}),
      stale: this.fetchedAt === 0 || this.now() >= this.nextRefreshAt,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      providerCount: this.providers.size,
    };
  }

  /** Load the disk cache once and refresh in the background when it is due. */
  async ensure(): Promise<void> {
    await this.ensureLoaded();
    if (this.now() >= this.nextRefreshAt) void this.refresh();
  }

  /** Fetch and replace the snapshot; returns true when new metadata was stored. */
  async refresh(): Promise<boolean> {
    await this.ensureLoaded();
    if (this.inFlight) return this.inFlight;
    const started = this.fetchSnapshot()
      .then(async (cache) => {
        this.providers = new Map(Object.entries(cache.providers));
        this.fetchedAt = cache.fetchedAt;
        this.nextRefreshAt = this.fetchedAt + this.ttlMs;
        this.lastError = undefined;
        await this.persist();
        return true;
      })
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message.slice(0, 200) : "models.dev refresh failed";
        this.nextRefreshAt = this.now() + Math.min(this.ttlMs, 60_000);
        return false;
      })
      .finally(() => {
        if (this.inFlight === started) this.inFlight = undefined;
      });
    this.inFlight = started;
    return started;
  }

  private async fetchSnapshot(): Promise<ModelsDevCache> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(MODELS_DEV_SOURCE_URL, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > SDK_MODELS_DEV_MAX_BYTES) throw new Error("models.dev catalog exceeded the size limit");
    let parsed: Record<string, { models?: Record<string, unknown> }>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("models.dev catalog is invalid");
    }
    const fetchedAt = this.now();
    const providers: Record<string, ModelsDevModel[]> = {};
    for (const [providerId, provider] of Object.entries(parsed)) {
      if (!REVIEWED_MODELS_DEV_IDS.has(providerId)) continue;
      if (!provider || typeof provider !== "object" || !provider.models || typeof provider.models !== "object") continue;
      const models = Object.values(provider.models)
        .map(normalizeModel)
        .filter((model): model is ModelsDevModel => model !== undefined)
        .slice(0, SDK_MODELS_DEV_MAX_MODELS_PER_PROVIDER);
      if (models.length) providers[providerId] = models;
    }
    if (!Object.keys(providers).length) throw new Error("models.dev returned no text models");
    return { version: SDK_MODELS_DEV_CACHE_VERSION, source: MODELS_DEV_SOURCE_URL, fetchedAt, providers };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (!this.cachePath) return;
    let raw: string;
    try {
      const buffer = await readFile(this.cachePath);
      if (buffer.byteLength > SDK_MODELS_DEV_CACHE_MAX_BYTES) return;
      raw = buffer.toString("utf8");
    } catch {
      return;
    }
    let parsed: Partial<ModelsDevCache>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed?.version !== SDK_MODELS_DEV_CACHE_VERSION || !parsed.providers || typeof parsed.providers !== "object") return;
    const providers = new Map<string, ModelsDevModel[]>();
    for (const [providerId, models] of Object.entries(parsed.providers)) {
      if (!REVIEWED_MODELS_DEV_IDS.has(providerId) || !Array.isArray(models)) continue;
      const normalized = models.map(normalizeStoredModel).filter((model): model is ModelsDevModel => model !== undefined);
      if (normalized.length) providers.set(providerId, normalized);
    }
    if (!providers.size) return;
    this.providers = providers;
    this.fetchedAt = typeof parsed.fetchedAt === "number" && Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : 0;
    this.nextRefreshAt = 0;
  }

  private async persist(): Promise<void> {
    if (!this.cachePath) return;
    const payload: ModelsDevCache = {
      version: SDK_MODELS_DEV_CACHE_VERSION,
      source: MODELS_DEV_SOURCE_URL,
      fetchedAt: this.fetchedAt,
      providers: Object.fromEntries(this.providers),
    };
    try {
      await mkdir(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      await rename(temporary, this.cachePath);
    } catch {
      // Persistence is best effort; metadata still works from memory.
    }
  }
}
