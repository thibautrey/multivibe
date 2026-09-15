import { collectionSources } from './curated-model-catalog.js';
import { fetchCommunityUsage } from './community-model-usage.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OpenModel, OpenModelCatalog, CatalogNeed } from './open-model-ranking.js';
export type { OpenModel, OpenModelCatalog } from './open-model-ranking.js';
const source = 'https://huggingface.co';
const idPattern = /^[A-Za-z0-9][\w.-]{0,127}\/[A-Za-z0-9][\w.-]{0,127}$/;
export const CATALOG_TTL = 6 * 60 * 60 * 1000;
const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const safeBytes = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const safeFilename = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\\\x00-\x1f\x7f%?#]/u.test(v) && v.split('/').every(p => p !== '' && p !== '.' && p !== '..');
const positive = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function parseOpenModels(value: unknown): OpenModel[] {
  if (!Array.isArray(value)) throw new Error('Invalid public catalog');
  return value.flatMap(item => {
    if (!item || typeof item.id !== 'string' || !idPattern.test(item.id) || item.private !== false || !['text-generation','image-text-to-text','text2text-generation','translation','summarization'].includes(item.pipeline_tag)) return [];
    const card = item.cardData ?? {};
    const tags = [...strings(item.pipeline_tag), ...strings(item.tags), ...strings(card.task_categories), ...strings(card.tags)];
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
    const taggedParents = tags.filter(t => t.startsWith('base_model:quantized:') || t.startsWith('base_model:converted:')).map(t=>t.split(':').slice(2).join(':'));
    const parents = [...new Set([...taggedParents,...strings(card.base_model)])];
    const parent = parents.length === 1 ? parents[0] : null;
    const quantConfig = item.config?.quantization_config ?? card.quantization_config;
    const bits = typeof quantConfig?.bits === 'number' ? quantConfig.bits : typeof quantConfig?.weight_bits === 'number' ? quantConfig.weight_bits : null;
    const quantization = [typeof quantConfig?.quant_method === 'string' ? quantConfig.quant_method : '', bits !== null ? `${bits}-bit` : ''].filter(Boolean).join(' ') || null;
    const declaredNonConversion = ['finetune','merge'].includes(card.base_model_relation) ? card.base_model_relation : tags.some(t=>t.startsWith('base_model:finetune:')) ? 'finetune' : tags.some(t=>t.startsWith('base_model:merge:')) ? 'merge' : null;
    const relation = declaredNonConversion ?? (taggedParents.length ? tags.some(t=>t.startsWith('base_model:quantized:')) ? 'quantized' : 'converted' : typeof card.base_model_relation === 'string' ? card.base_model_relation : quantization && parent ? 'quantized' : null);
    const files = Array.isArray(item.siblings) ? item.siblings.filter((f: any) => f && safeFilename(f.rfilename)).map((f: any) => {
      const bytes = safeBytes(f.size ?? f.lfs?.size);
      const sha256 = typeof f.lfs?.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(f.lfs.sha256) && bytes !== null && safeBytes(f.lfs.size) === bytes ? f.lfs.sha256 : null;
      return {name: f.rfilename, bytes, sha256};
    }) : [];
    return [{ revision: typeof item.sha === 'string' && /^[a-f0-9]{40}$/u.test(item.sha) ? item.sha : null, id: item.id, url: `${source}/${item.id}`, license,
      createdAt: typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : null,
      downloads: positive(item.downloads), gated: item.gated !== false, needs, languages: strings(card.language),
      parent: parent && idPattern.test(parent) ? parent : null, relation, quantization, lineageAmbiguous: parents.length > 1,
      files, formats: [...new Set<string>(files.map((f: {name:string}) => f.name.split('.').pop()!).filter((x:string) => ['gguf','safetensors','bin'].includes(x)))],
      architecture: strings(item.config?.architectures)[0] ?? null, context: positive(item.config?.max_position_embeddings), trendingRank: null }];
  });
}
export function createOpenModelCatalog(fetcher: typeof fetch = fetch, now = Date.now, cachePath?: string) {
  let cache: OpenModelCatalog | undefined; let pending: Promise<OpenModelCatalog> | undefined; let hydration: Promise<void> | undefined;
  let enrichmentCursor = 0;
  let retryAfter = 0;
  async function hydrate() {
    if (!hydration) hydration = (async () => {
      if (cachePath) try {
        const saved = JSON.parse(await fs.readFile(cachePath, 'utf8'));
        if (['2','3','4','5','6','7','8'].includes(saved.version) && Array.isArray(saved.models) && Number.isFinite(Date.parse(saved.checkedAt)) && saved.models.every((m: OpenModel) => m && typeof m.id === 'string' && idPattern.test(m.id) && m.url === `${source}/${m.id}` && Array.isArray(m.needs) && Array.isArray(m.files) && Array.isArray(m.formats) && Array.isArray(m.languages))) cache = saved;
      } catch { /* First run or invalid cache. */ }
    })();
    await hydration;
  }
  async function refresh(): Promise<OpenModelCatalog> {
    if (pending) return pending;
    pending = (async () => {
      try {
        await hydrate();
        const feeds = await Promise.allSettled(['trendingScore','downloads','createdAt'].flatMap(sort => ['pipeline_tag=text-generation', 'pipeline_tag=image-text-to-text', 'pipeline_tag=translation', 'pipeline_tag=summarization', 'pipeline_tag=text-generation&filter=translation', 'pipeline_tag=text-generation&filter=summarization', 'pipeline_tag=text-generation&filter=code'].map(filter => ({sort, filter}))).map(async ({sort, filter}) => {
          let url: string | undefined = `${source}/api/models?${filter}&sort=${sort}&direction=-1&limit=100&full=true&config=true`;
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
        const failedFeeds = feeds.filter(feed => feed.status === 'rejected').length;
        const lists = feeds.flatMap(feed => feed.status === 'fulfilled' ? [feed.value] : []);
        const unique = new Map<string,OpenModel>();
        for (const row of lists.flat()) if (!unique.has(row.id)) unique.set(row.id,row);
        if (!unique.size) throw new Error('Empty public catalog');
        const curated = await collectionSources(fetcher,now);
        const missingCurated=[...curated.keys()].filter(id=>!unique.has(id));
        for(let offset=0;offset<missingCurated.length;offset+=8)await Promise.all(missingCurated.slice(offset,offset+8).map(async id=>{
          try {const response=await fetcher(`${source}/api/models/${id}?blobs=true`,{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)return;const model=parseOpenModels([await response.json()]).find(m=>m.id===id);if(model)unique.set(id,model);} catch {/* Keep independently available sources. */}
        }));

        // A failed independent feed must not hide new results from healthy feeds.
        // Retain last-known records on partial refresh, without claiming fresh ranks.
        if (failedFeeds) for (const prior of cache?.models ?? []) {
          if (!unique.has(prior.id)) unique.set(prior.id, {...prior, trendingRank: null, communityUsage: undefined});
        }
        retryAfter = failedFeeds ? now() + 60_000 : 0;
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
          if (prior && !model.metadataCheckedAt) unique.set(id, {...prior, downloads:model.downloads, license:model.license, gated:model.gated, trendingRank:model.trendingRank});
        }
        let communityStatus: 'available' | 'unavailable' = 'unavailable';
        // Supplement discovery with the central cached ranking; no credentials or prompts.
        // Clear prior ranks on error rather than presenting old activity as current.
        for (const model of unique.values()) delete model.communityUsage;
        try {
          const usage = await fetchCommunityUsage(fetcher);
          communityStatus = 'available';
          // Include ranked models absent from the discovery feeds, using documented metadata only.
          await Promise.all([...usage].filter(([id]) => !unique.has(id)).slice(0,20).map(async ([id]) => {
            try {
              const response = await fetcher(`${source}/api/models/${id}?blobs=true`, {signal:AbortSignal.timeout(5000),redirect:'error'});
              if (response.ok) for (const model of parseOpenModels([await response.json()])) if (model.id === id) unique.set(id,model);
            } catch { /* Missing metadata cannot establish task suitability. */ }
          }));
          for (const [id, evidence] of usage) { const model = unique.get(id); if (model) model.communityUsage = evidence; }
        } catch { /* Discovery stays usable when community data is unavailable. */ }
        // Follow declared conversion ancestry, including originals absent from the feeds.
        // Bounded depth and request count prevent cycles or unbounded graph expansion.
        const visitedParents = new Set<string>();
        for (let depth=0; depth<4 && visitedParents.size<32; depth++) {
          const missing = [...new Set([...unique.values()].filter(m=>!m.lineageAmbiguous && ['quantized','converted'].includes(m.relation ?? '') && m.parent && !unique.has(m.parent)).map(m=>m.parent!))].filter(id=>!visitedParents.has(id)).slice(0,32-visitedParents.size);
          if (!missing.length) break;
          for (let offset=0; offset<missing.length; offset+=4) await Promise.all(missing.slice(offset,offset+4).map(async id=>{
            visitedParents.add(id);
            const prior = cache?.models.find(m=>m.id===id && m.metadataCheckedAt && now()-Date.parse(m.metadataCheckedAt)<CATALOG_TTL);
            if (prior) { unique.set(id,prior); return; }
            try {
              const response = await fetcher(`${source}/api/models/${id}?blobs=true`,{signal:AbortSignal.timeout(5000),redirect:'error'});
              if (!response.ok) return;
              const original = parseOpenModels([await response.json()]).find(m=>m.id===id);
              if (original) unique.set(id,{...original,metadataCheckedAt:new Date(now()).toISOString()});
            } catch { /* Unresolved lineage stays explicit and does not become an original. */ }
          }));
        }
        for (const prior of cache?.models ?? []) if (!unique.has(prior.id) && prior.parent && cache?.familyChecks?.[prior.parent] && now()-Date.parse(cache.familyChecks[prior.parent])<CATALOG_TTL) unique.set(prior.id,prior);
        for(const model of unique.values())model.recommendationSources=curated.get(model.id) ?? [];
        const fresh: OpenModelCatalog = {familyChecks:cache?.familyChecks,models:[...unique.values()],checkedAt:new Date(now()).toISOString(),stale:failedFeeds > 0,source,version:'8',communityStatus,failedFeeds};
        if (cachePath) { await fs.mkdir(path.dirname(cachePath), {recursive:true}); const tmp = `${cachePath}.${process.pid}.tmp`; await fs.writeFile(tmp,JSON.stringify(fresh), {mode:0o600}); await fs.rename(tmp,cachePath); }
        cache = fresh; return fresh;
      } catch { retryAfter = now() + 60_000; if (cache) { cache = {...cache,stale:true}; return cache; } throw new Error('Public catalog unavailable'); }
      finally { pending = undefined; }
    })();
    return pending;
  }
  async function load(): Promise<OpenModelCatalog> {
    await hydrate();
    if (cache) { if (cache.version !== '8' || cache.stale || now()-Date.parse(cache.checkedAt)>=CATALOG_TTL) { if (now() >= retryAfter) void refresh().catch(()=>{}); return {...cache,stale:true}; } return cache; }
    return refresh();
  }
  const familyPending = new Map<string, Promise<OpenModel[]>>();
  async function family(modelId: string): Promise<OpenModel[]> {
    if (!idPattern.test(modelId)) throw Error('Invalid model identity');
    const snapshot = await load();
    const related = (models: OpenModel[]) => {
      const ids=new Set([modelId]);
      for(let depth=0;depth<8;depth++) {const size=ids.size;for(const m of models) if(!m.lineageAmbiguous && m.parent && ids.has(m.parent) && ['quantized','converted'].includes(m.relation ?? '')) ids.add(m.id);if(size===ids.size)break;}
      return models.filter(m=>ids.has(m.id));
    };
    if (snapshot.familyChecks?.[modelId] && now()-Date.parse(snapshot.familyChecks[modelId])<CATALOG_TTL) return related(snapshot.models);
    const pending = familyPending.get(modelId); if (pending) return pending;
    const operation = (async()=>{
      const results = await Promise.all(['quantized','converted'].map(async relation=>{
        const url = new URL(`${source}/api/models`);
        url.searchParams.set('filter',`base_model:${relation}:${modelId}`); url.searchParams.set('limit','100'); url.searchParams.set('full','true'); url.searchParams.set('config','true'); url.searchParams.set('sort','downloads'); url.searchParams.set('direction','-1');
        const response = await fetcher(url.href,{signal:AbortSignal.timeout(12000),redirect:'error'});
        if (!response.ok) throw Error('Model variants unavailable');
        return related(parseOpenModels(await response.json()));
      }));
      const models = new Map(related(snapshot.models).map(m=>[m.id,m]));
      for (const model of results.flat()) models.set(model.id,model);
      const enrich = [...models.values()].filter(m=>!m.metadataCheckedAt || now()-Date.parse(m.metadataCheckedAt)>=CATALOG_TTL).slice(0,20);
      for(let offset=0;offset<enrich.length;offset+=4) await Promise.all(enrich.slice(offset,offset+4).map(async m=>{
        try { const response = await fetcher(`${source}/api/models/${m.id}?blobs=true`,{signal:AbortSignal.timeout(5000),redirect:'error'});
          if(response.ok) {const detail=related(parseOpenModels([await response.json()])).find(d=>d.id===m.id);if(detail) models.set(m.id,{...detail,metadataCheckedAt:new Date(now()).toISOString()});}
        } catch { /* Per-repository file sizes can remain unknown. */ }
      }));
      const merged = new Map((cache ?? snapshot).models.map(m=>[m.id,m])); for(const model of models.values()) merged.set(model.id,model);
      cache = {...(cache ?? snapshot),models:[...merged.values()],familyChecks:{...(cache ?? snapshot).familyChecks,[modelId]:new Date(now()).toISOString()}};
      if(cachePath) {await fs.mkdir(path.dirname(cachePath),{recursive:true});const tmp=`${cachePath}.${process.pid}.${encodeURIComponent(modelId)}.family.tmp`;await fs.writeFile(tmp,JSON.stringify(cache),{mode:0o600});await fs.rename(tmp,cachePath);}
      return [...models.values()];
    })().finally(()=>familyPending.delete(modelId));
    familyPending.set(modelId,operation);return operation;
  }
  return Object.assign(load,{refresh,family,start() { void load().catch(()=>{}); const timer=setInterval(()=>{void refresh().catch(()=>{});},CATALOG_TTL); timer.unref(); return ()=>clearInterval(timer); }});
}
export const loadOpenModelCatalog = createOpenModelCatalog(fetch, Date.now, path.join(path.dirname(process.env.STORE_PATH ?? '/data/accounts.json'),'open-model-catalog-v2.json'));
