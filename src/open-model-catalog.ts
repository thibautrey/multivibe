import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OpenModel, OpenModelCatalog, CatalogNeed } from './open-model-ranking.js';
export type { OpenModel, OpenModelCatalog } from './open-model-ranking.js';
const source = 'https://huggingface.co';
const idPattern = /^[\w.-]+\/[\w.-]+$/;
export const CATALOG_TTL = 6 * 60 * 60 * 1000;
const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const positive = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function parseOpenModels(value: unknown): OpenModel[] {
  if (!Array.isArray(value)) throw new Error('Invalid public catalog');
  return value.flatMap(item => {
    if (!item || typeof item.id !== 'string' || !idPattern.test(item.id) || item.private !== false || item.pipeline_tag !== 'text-generation') return [];
    const card = item.cardData ?? {};
    const tags = [...strings(item.tags), ...strings(card.task_categories), ...strings(card.tags)];
    for (const entry of Array.isArray(card['model-index']) ? card['model-index'] : []) {
      for (const result of Array.isArray(entry?.results) ? entry.results : []) tags.push(...strings(result?.task?.type));
    }
    if (tags.some(t => t.startsWith('base_model:adapter:')) || card.base_model_relation === 'adapter') return [];
    const license = strings(card.license)[0] ?? tags.find(t => t.startsWith('license:'))?.slice(8);
    if (!license) return [];
    const needs: CatalogNeed[] = [];
    if (tags.includes('conversational') || item.config?.tokenizer_config?.chat_template) needs.push('writing');
    if (tags.some(t => ['code','code-generation','coding'].includes(t))) needs.push('coding');
    if (tags.includes('translation')) needs.push('translation');
    if (tags.some(t => ['summarization','text-analysis'].includes(t))) needs.push('documents');
    const quantized = tags.find(t => t.startsWith('base_model:quantized:'))?.slice('base_model:quantized:'.length);
    const parents = strings(card.base_model);
    const parent = quantized ?? (parents.length === 1 ? parents[0] : null);
    const files = Array.isArray(item.siblings) ? item.siblings.filter((f: any) => typeof f.rfilename === 'string').map((f: any) => ({name: f.rfilename, bytes: positive(f.size)})) : [];
    return [{ id: item.id, url: `${source}/${item.id}`, license,
      createdAt: typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : null,
      downloads: positive(item.downloads), gated: item.gated !== false, needs, languages: strings(card.language),
      parent: parent && idPattern.test(parent) ? parent : null, relation: quantized ? 'quantized' : typeof card.base_model_relation === 'string' ? card.base_model_relation : null,
      files, formats: [...new Set<string>(files.map((f: {name:string}) => f.name.split('.').pop()!).filter((x:string) => ['gguf','safetensors','bin'].includes(x)))],
      architecture: strings(item.config?.architectures)[0] ?? null, context: positive(item.config?.max_position_embeddings), trendingRank: null }];
  });
}
export function createOpenModelCatalog(fetcher: typeof fetch = fetch, now = Date.now, cachePath?: string) {
  let cache: OpenModelCatalog | undefined; let pending: Promise<OpenModelCatalog> | undefined; let hydration: Promise<void> | undefined;
  let enrichmentCursor = 0;
  async function hydrate() {
    if (!hydration) hydration = (async () => {
      if (cachePath) try {
        const saved = JSON.parse(await fs.readFile(cachePath, 'utf8'));
        if (saved.version === '2' && Array.isArray(saved.models) && Number.isFinite(Date.parse(saved.checkedAt)) && saved.models.every((m: OpenModel) => m && typeof m.id === 'string' && idPattern.test(m.id) && m.url === `${source}/${m.id}` && Array.isArray(m.needs) && Array.isArray(m.files) && Array.isArray(m.formats) && Array.isArray(m.languages))) cache = saved;
      } catch { /* First run or invalid cache. */ }
    })();
    await hydration;
  }
  async function refresh(): Promise<OpenModelCatalog> {
    if (pending) return pending;
    pending = (async () => {
      try {
        await hydrate();
        const lists = await Promise.all(['trendingScore','downloads','createdAt'].map(async sort => {
          let url: string | undefined = `${source}/api/models?pipeline_tag=text-generation&sort=${sort}&direction=-1&limit=100&full=true&config=true`;
          const rows: OpenModel[] = [];
          for (let page=0; page<2 && url; page++) {
            const response: Response = await fetcher(url, {signal: AbortSignal.timeout(12000), redirect:'error'});
            if (!response.ok) throw new Error('Public catalog unavailable');
            const raw = await response.json();
            const parsed = parseOpenModels(Array.isArray(raw) ? raw.slice(0, 100) : raw);
            for (const row of parsed) { if (sort === 'trendingScore') row.trendingRank = rows.length; rows.push(row); }
            const next: string | undefined = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
            url = undefined;
            if (next) { const u: URL = new URL(next, source); if (u.origin !== source || u.pathname !== '/api/models' || u.username || u.password) throw new Error('Unsafe catalog pagination'); url = u.href; }
          }
          return rows;
        }));
        const unique = new Map<string,OpenModel>();
        for (const row of lists.flat()) if (!unique.has(row.id)) unique.set(row.id,row);
        if (!unique.size) throw new Error('Empty public catalog');
        // Bounded progressive enrichment: fixed Hub metadata endpoints only.
        // Failures retain list metadata and never discard a valid discovery snapshot.
        const candidates = [...unique.values()];
        const batch = candidates.slice(enrichmentCursor, enrichmentCursor + 12);
        enrichmentCursor = (enrichmentCursor + batch.length) % candidates.length;
        await Promise.all(batch.map(async model => {
          try {
            const response = await fetcher(`${source}/api/models/${model.id}?blobs=true`, {signal: AbortSignal.timeout(5000), redirect:'error'});
            if (!response.ok) return;
            const detail = await response.json();
            const enriched = parseOpenModels([detail]).find(row => row.id === model.id);
            if (enriched) unique.set(model.id, {...enriched, trendingRank:model.trendingRank, metadataCheckedAt:new Date(now()).toISOString()});
          } catch { /* Optional metadata enrichment; no weights or model card links. */ }
        }));
        for (const [id, model] of unique) {
          const prior = cache?.models.find(row => row.id === id && row.metadataCheckedAt);
          if (prior && !model.metadataCheckedAt) unique.set(id, {...prior, downloads:model.downloads, gated:model.gated, trendingRank:model.trendingRank});
        }
        const fresh: OpenModelCatalog = {models:[...unique.values()],checkedAt:new Date(now()).toISOString(),stale:false,source,version:'2'};
        if (cachePath) { await fs.mkdir(path.dirname(cachePath), {recursive:true}); const tmp = `${cachePath}.${process.pid}.tmp`; await fs.writeFile(tmp,JSON.stringify(fresh), {mode:0o600}); await fs.rename(tmp,cachePath); }
        cache = fresh; return fresh;
      } catch { if (cache) { cache = {...cache,stale:true}; return cache; } throw new Error('Public catalog unavailable'); }
      finally { pending = undefined; }
    })();
    return pending;
  }
  async function load(): Promise<OpenModelCatalog> {
    await hydrate();
    if (cache) { if (now()-Date.parse(cache.checkedAt)>=CATALOG_TTL) { void refresh().catch(()=>{}); return {...cache,stale:true}; } return cache; }
    return refresh();
  }
  return Object.assign(load,{refresh,start() { void load().catch(()=>{}); const timer=setInterval(()=>{void refresh().catch(()=>{});},CATALOG_TTL); timer.unref(); return ()=>clearInterval(timer); }});
}
export const loadOpenModelCatalog = createOpenModelCatalog(fetch, Date.now, path.join(path.dirname(process.env.STORE_PATH ?? '/data/accounts.json'),'open-model-catalog-v2.json'));
