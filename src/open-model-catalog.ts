/** Public discovery only: never grants an inference route or installation permission. */
export type OpenModel = { id: string; url: string; license: string; createdAt: string | null; downloads: number | null };
export type OpenModelCatalog = { models: OpenModel[]; checkedAt: string; stale: boolean; source: string };
const source = 'https://huggingface.co';
const licenses = new Set(['apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'isc']);
export function parseOpenModels(value: unknown): OpenModel[] {
  if (!Array.isArray(value)) throw new Error('Invalid public catalog');
  return value.flatMap(item => {
    if (!item || typeof item.id !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(item.id) || item.private !== false || item.gated !== false || item.pipeline_tag !== 'text-generation' || !Array.isArray(item.tags)) return [];
    const license = item.tags.find((tag: unknown) => typeof tag === 'string' && tag.startsWith('license:'))?.slice(8);
    if (!licenses.has(license) || !item.tags.includes('conversational') || item.tags.some((tag: unknown) => typeof tag === 'string' && tag.startsWith('base_model:adapter:'))) return [];
    return [{ id: item.id, url: `${source}/${item.id}`, license, createdAt: typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : null, downloads: typeof item.downloads === 'number' && Number.isFinite(item.downloads) ? item.downloads : null }];
  });
}
export function createOpenModelCatalog(fetcher: typeof fetch = fetch, now = Date.now) {
  let cache: OpenModelCatalog | undefined;
  let pending: Promise<OpenModelCatalog> | undefined;
  return function load(): Promise<OpenModelCatalog> {
    if (cache && now() - Date.parse(cache.checkedAt) < 60 * 60 * 1000) return Promise.resolve(cache);
    if (pending) return pending;
    pending = (async () => {
      try {
        const lists = await Promise.all(['trendingScore', 'createdAt'].map(async sort => {
          const response = await fetcher(`${source}/api/models?pipeline_tag=text-generation&sort=${sort}&direction=-1&limit=100&full=true`, { signal: AbortSignal.timeout(12000), redirect: 'error' });
          if (!response.ok) throw new Error('Public catalog unavailable');
          return parseOpenModels(await response.json());
        }));
        const models = [...new Map(lists.flat().map(model => [model.id, model])).values()];
        cache = { models, checkedAt: new Date(now()).toISOString(), stale: false, source };
        return cache;
      } catch {
        if (cache) return { ...cache, stale: true };
        throw new Error('Public catalog unavailable');
      } finally { pending = undefined; }
    })();
    return pending;
  };
}
export const loadOpenModelCatalog = createOpenModelCatalog();
