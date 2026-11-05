import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SDK_PROVIDERS, sdkProvider } from "../ai-sdk/providers.js";
import type { ModelsDevModel, ModelsDevCatalogState, ModelsDevProviderModels } from "../ai-sdk/models-dev-catalog.js";
import { fetchSource, providerId, SOURCE_URLS } from "./sources.js";
import { consolidate, object, modelId, type CatalogSource, type Contribution, type UnifiedModel } from "./types.js";

const SOURCES = Object.keys(SOURCE_URLS) as CatalogSource[];
export const UNIFIED_CATALOG_MAX_BYTES = 96 * 1024 * 1024;
type SourceSnapshot = { fetchedAt: number; records: Contribution[]; lastError?: string };
type Options = {
  fetch?: typeof fetch; cachePath?: string; ttlMs?: number; timeoutMs?: number; now?: () => number;
  onUpdate?: (providers: Record<string, ModelsDevModel[]>, fetchedAt: number, aliases: Record<string, string>) => void;
};
export type ModelMetadataCatalog = {
  ensure(): Promise<void>;
  catalogFor(provider: string): ModelsDevProviderModels | undefined;
  state(): ModelsDevCatalogState;
};

/** One materialized database, one refresh lifecycle and one cache shared by every consumer. */
export class UnifiedModelCatalog implements ModelMetadataCatalog {
  private snapshots = new Map<CatalogSource, SourceSnapshot>();
  private providers: Record<string, UnifiedModel[]> = Object.create(null);
  private loaded?: Promise<void>;
  private flight?: Promise<boolean>;
  private nextRefresh = 0;
  private fetchedAt = 0;
  private readonly now: () => number;
  constructor(private options: Options = {}) { this.now = options.now ?? Date.now; }

  catalogFor(provider: string): ModelsDevProviderModels | undefined {
    const id = providerId(sdkProvider(provider)?.modelsDevId ?? provider);
    const models = this.providers[id];
    return models?.length ? { source: "multivibe:unified-model-catalog", fetchedAt: new Date(this.fetchedAt).toISOString(), models } : undefined;
  }
  state(): ModelsDevCatalogState & { sources: Record<string, { fetchedAt?: string; modelCount: number; lastError?: string }> } {
    return { source: "multivibe:unified-model-catalog", fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : undefined,
      stale: this.now() >= this.nextRefresh || SOURCES.some(s => !this.snapshots.has(s) || this.snapshots.get(s)?.lastError),
      providerCount: Object.keys(this.providers).length,
      sources: Object.fromEntries(SOURCES.map(s => { const snapshot = this.snapshots.get(s); return [s, { fetchedAt: snapshot?.fetchedAt ? new Date(snapshot.fetchedAt).toISOString() : undefined, modelCount: snapshot?.records.length ?? 0, lastError: snapshot?.lastError }]; })) };
  }
  async ensure(): Promise<void> { await this.loadOnce(); if (this.now() >= this.nextRefresh) void this.refresh(); }
  async refresh(): Promise<boolean> {
    await this.loadOnce();
    if (this.flight) return this.flight;
    const run = this.refreshAll().finally(() => { if (this.flight === run) this.flight = undefined; });
    this.flight = run; return run;
  }
  private async refreshAll(): Promise<boolean> {
    const results = await Promise.allSettled(SOURCES.map(s => fetchSource(s, this.options.fetch ?? fetch, this.options.timeoutMs ?? 30_000, this.now())));
    let updated = false;
    results.forEach((result, i) => {
      const source = SOURCES[i], old = this.snapshots.get(source);
      if (result.status === "fulfilled") { this.snapshots.set(source, { fetchedAt: this.now(), records: result.value }); updated = true; }
      else this.snapshots.set(source, { fetchedAt: old?.fetchedAt ?? 0, records: old?.records ?? [], lastError: `Could not refresh ${source}` });
    });
    if (updated) { this.fetchedAt = this.now(); this.materialize(); await this.persist(); }
    this.nextRefresh = this.now() + (results.some(r => r.status === "rejected") ? 60_000 : this.options.ttlMs ?? 86_400_000);
    return updated;
  }
  private materialize() {
    const groups = new Map<string, Contribution[]>();
    for (const snapshot of this.snapshots.values()) for (const record of snapshot.records) {
      const key = `${record.provider}\0${record.id}`; const group = groups.get(key) ?? []; group.push(record); groups.set(key, group);
    }
    const providers: Record<string, UnifiedModel[]> = Object.create(null);
    for (const records of groups.values()) (providers[records[0].provider] ??= []).push(consolidate(records));
    for (const models of Object.values(providers)) models.sort((a, b) => a.id.localeCompare(b.id));
    this.providers = providers;
    const aliases = Object.fromEntries(SDK_PROVIDERS.filter(p => p.modelsDevId && p.modelsDevId !== p.id).map(p => [p.id, p.modelsDevId!]));
    this.options.onUpdate?.(providers, this.fetchedAt, aliases);
  }
  private async loadOnce() { this.loaded ??= this.load(); await this.loaded; }
  private async load() {
    if (!this.options.cachePath) return;
    try {
      const data = await readFile(this.options.cachePath); if (data.byteLength > UNIFIED_CATALOG_MAX_BYTES) return;
      const cache = JSON.parse(data.toString()); if (cache.version !== 2 || cache.unifiedVersion !== 1) return;
      const grouped = new Map<CatalogSource, Contribution[]>();
      for (const models of Object.values(object(cache.providers))) for (const model of Array.isArray(models) ? models : []) for (const record of object(model.knowledge).sources ?? []) {
        if (!SOURCES.includes(record.source) || !modelId(record.id) || !modelId(record.provider) || !Number.isFinite(record.fetchedAt)) continue;
        if (typeof record.url !== "string" || ![...Object.values(SOURCE_URLS), "https://raw.githubusercontent.com/langchain-ai/langchain/"].some(url => record.url === url || (record.source === "langchain" && record.url.startsWith(url)))) continue;
        const records = grouped.get(record.source) ?? []; records.push(record); grouped.set(record.source, records);
      }
      for (const [source, records] of grouped) this.snapshots.set(source, { records, fetchedAt: Math.max(...records.map(r => r.fetchedAt)) });
      if (!this.snapshots.size) return;
      this.fetchedAt = Number(cache.fetchedAt) || 0; this.materialize();
    } catch { /* Corrupt cache never prevents startup; the next refresh repairs it. */ }
  }
  private async persist() {
    if (!this.options.cachePath) return;
    const aliases = Object.fromEntries(SDK_PROVIDERS.filter(p => p.modelsDevId && p.modelsDevId !== p.id).map(p => [p.id, p.modelsDevId!]));
    const payload = JSON.stringify({ version: 2, unifiedVersion: 1, source: "multivibe:unified-model-catalog", fetchedAt: this.fetchedAt, providerAliases: aliases, sources: this.state().sources, providers: this.providers });
    if (Buffer.byteLength(payload) > UNIFIED_CATALOG_MAX_BYTES) return;
    const temporary = `${this.options.cachePath}.${randomUUID()}.tmp`;
    try { await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 }); await writeFile(temporary, payload, { mode: 0o600 }); await rename(temporary, this.options.cachePath); }
    catch { await unlink(temporary).catch(() => undefined); }
  }
}
