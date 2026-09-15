import { promises as fs } from "node:fs";
import path from "node:path";
import { BENCHMARK_CACHE_TTL_MS, type ModelBenchmarkClient } from "./model-benchmarks.js";

const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

type CacheEntry = { storedAt: string; value: any };
type CacheFile = { version: 1; entries: Record<string, CacheEntry> };
type CacheOptions = { path: string; ttlMs?: number; now?: () => number };

function validEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as CacheEntry;
  return typeof entry.storedAt === "string" && Number.isFinite(Date.parse(entry.storedAt)) && entry.value && typeof entry.value === "object";
}

export function createCachedModelBenchmarkClient(upstream: ModelBenchmarkClient, options: CacheOptions) {
  const ttl = options.ttlMs ?? BENCHMARK_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let entries: Record<string, CacheEntry> = {};
  let hydration: Promise<void> | undefined;
  let writeQueue = Promise.resolve();
  const pending = new Map<string, Promise<any>>();

  async function hydrate() {
    if (!hydration) hydration = (async () => {
      try {
        const info = await fs.lstat(options.path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_BYTES) return;
        const parsed = JSON.parse(await fs.readFile(options.path, "utf8")) as CacheFile;
        if (parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) return;
        const safe = Object.entries(parsed.entries).filter(([, entry]) => validEntry(entry)).slice(-MAX_ENTRIES);
        entries = Object.fromEntries(safe);
      } catch { /* A missing or corrupt cache is equivalent to an empty cache. */ }
    })();
    await hydration;
  }

  function persist() {
    writeQueue = writeQueue.then(async () => {
      await fs.mkdir(path.dirname(options.path), { recursive: true });
      const ordered = Object.entries(entries).sort((a, b) => Date.parse(a[1].storedAt) - Date.parse(b[1].storedAt)).slice(-MAX_ENTRIES);
      entries = Object.fromEntries(ordered);
      let retained = ordered;
      let body = JSON.stringify({ version: CACHE_VERSION, entries });
      while (Buffer.byteLength(body) > MAX_CACHE_BYTES && retained.length > 1) {
        retained = retained.slice(Math.max(1, Math.floor(retained.length / 4)));
        entries = Object.fromEntries(retained); body = JSON.stringify({ version: CACHE_VERSION, entries });
      }
      const temporary = `${options.path}.${process.pid}.tmp`;
      await fs.writeFile(temporary, body, { mode: 0o600 });
      await fs.rename(temporary, options.path);
    }).catch(() => {});
    return writeQueue;
  }

  function decorated(entry: CacheEntry, hit: boolean, stale: boolean) {
    return { ...entry.value, cache: { hit, stale, storedAt: entry.storedAt, ttlMs: ttl } };
  }

  async function cached(key: string, loader: () => Promise<any>, refresh = false) {
    await hydrate();
    const found = entries[key];
    const stale = Boolean(found && now() - Date.parse(found.storedAt) >= ttl);
    if (found && !refresh) {
      if (stale && !pending.has(key)) void refreshKey(key, loader).catch(() => {});
      return decorated(found, true, stale);
    }
    try { return await refreshKey(key, loader); }
    catch (error) { if (found) return decorated(found, true, true); throw error; }
  }

  function refreshKey(key: string, loader: () => Promise<any>) {
    const existing = pending.get(key); if (existing) return existing;
    const promise = loader().then(async value => {
      const entry = { storedAt: new Date(now()).toISOString(), value }; entries[key] = entry; await persist();
      return decorated(entry, false, false);
    }).finally(() => pending.delete(key));
    pending.set(key, promise); return promise;
  }

  return {
    sources() { return { ...upstream.sources(), cache: { persistence: "local", ttlMs: ttl, path: options.path } }; },
    model(modelId: string, request: { refresh?: boolean } = {}) { return cached(`hf:model:${modelId}`, () => upstream.model(modelId), request.refresh); },
    leaderboard(datasetId: string, limit = 100, request: { refresh?: boolean } = {}) {
      return cached(`hf:leaderboard:${datasetId}:${limit}`, () => upstream.leaderboard(datasetId, limit), request.refresh);
    },
    artificialAnalysisModels(page = 1, access: "free" | "full" = "free", request: { refresh?: boolean } = {}) {
      return cached(`aa:models:${access}:${page}`, () => upstream.artificialAnalysisModels(page, access), request.refresh);
    },
    artificialAnalysisModel(slug: string, promptType = "long", request: { refresh?: boolean } = {}) {
      return cached(`aa:model:${slug}:${promptType}`, () => upstream.artificialAnalysisModel(slug, promptType), request.refresh);
    },
    async cacheInventory() {
      await hydrate();
      const groups = { models: 0, leaderboards: 0, artificialAnalysisPages: 0, artificialAnalysisModels: 0 };
      let oldest: string | null = null; let newest: string | null = null;
      for (const [key, entry] of Object.entries(entries)) {
        if (key.startsWith("hf:model:")) groups.models++; else if (key.startsWith("hf:leaderboard:")) groups.leaderboards++;
        else if (key.startsWith("aa:models:")) groups.artificialAnalysisPages++; else if (key.startsWith("aa:model:")) groups.artificialAnalysisModels++;
        if (!oldest || entry.storedAt < oldest) oldest = entry.storedAt; if (!newest || entry.storedAt > newest) newest = entry.storedAt;
      }
      return { entries: Object.keys(entries).length, groups, oldest, newest, ttlMs: ttl };
    },
    async cachedModels(source: "all" | "hugging-face" | "artificial-analysis" = "all") {
      await hydrate();
      const values = Object.entries(entries).filter(([key]) => source === "all" || (source === "hugging-face" ? key.startsWith("hf:model:") : key.startsWith("aa:model:")))
        .map(([key, entry]) => ({ key, storedAt: entry.storedAt, stale: now() - Date.parse(entry.storedAt) >= ttl, data: entry.value }));
      return { models: values, count: values.length, source: "local-cache" };
    },
  };
}

export type CachedModelBenchmarkClient = ReturnType<typeof createCachedModelBenchmarkClient>;
