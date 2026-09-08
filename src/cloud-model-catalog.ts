export type CloudCatalogModel = { id: string; name: string; aliases: string[]; availability: string; network: boolean };

// Public discovery is deliberately separate from the authenticated inference catalog.
export async function readCloudModelCatalog(origin: string, fetchImpl: typeof fetch = fetch): Promise<CloudCatalogModel[]> {
  const models = new Map<string, CloudCatalogModel>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const signal = AbortSignal.timeout(30_000);
  for (let page = 0; page < 100; page++) {
    const url = new URL('/catalog/v2/models', origin);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, { redirect: 'error', signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Cloud catalog unavailable');
    const body = await response.json();
    if (!Array.isArray(body.data) || body.data.length > 200) throw new Error('Invalid Cloud catalog');
    for (const entry of body.data) {
      if (typeof entry?.id !== 'string' || !entry.id || entry.id.length > 512 || models.has(entry.id)) throw new Error('Invalid Cloud model');
      models.set(entry.id, { id: entry.id, name: typeof entry.displayName === 'string' ? entry.displayName : entry.id,
        aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((id: unknown): id is string => typeof id === 'string' && id.length <= 512) : [],
        availability: typeof entry.availability === 'string' ? entry.availability : 'unknown', network: Boolean(entry.multivibeNetwork) });
    }
    if (body.nextCursor === undefined) return [...models.values()];
    if (typeof body.nextCursor !== 'string' || !body.nextCursor || body.nextCursor.length > 8192 || cursors.has(body.nextCursor)) throw new Error('Invalid Cloud pagination');
    cursor = body.nextCursor;
    cursors.add(body.nextCursor);
  }
  throw new Error('Cloud catalog exceeds page limit');
}
