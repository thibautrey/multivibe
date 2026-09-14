/** Public, self-reported demand. Never execution permission or a user count. */
export type CommunityUsage = { rank: number; periodStart: string; periodEnd: string; checkedAt: string };
export async function fetchCommunityUsage(fetcher: typeof fetch): Promise<Map<string, CommunityUsage>> {
  const response = await fetcher('https://api.multivibe.cloud/catalog/v1/models?segment=usage-popular&limit=200', { signal: AbortSignal.timeout(12000), redirect: 'error' });
  if (!response.ok) throw new Error('Community activity unavailable');
  const page = await response.json();
  // Older servers returned external popularity here. Never relabel that as usage.
  if (page.source !== 'anonymous-output-demand' || !Array.isArray(page.data) || !Number.isFinite(Date.parse(page.generatedAt)) || !Number.isFinite(Date.parse(page.window?.periodStart)) || !Number.isFinite(Date.parse(page.window?.periodEnd))) throw new Error('Anonymous activity ranking unavailable');
  const result = new Map<string, CommunityUsage>();
  for (const row of page.data.slice(0,200)) {
    if (typeof row.id !== 'string' || !row.id.startsWith('hf:')) continue;
    const id = row.id.slice(3);
    const rank = row.usagePopularity?.rank;
    if (!/^[\w.-]+\/[\w.-]+$/.test(id) || !Number.isSafeInteger(rank) || rank < 1 || row.usagePopularity?.source !== page.source) continue;
    if (!result.has(id)) result.set(id, {rank, ...page.window, checkedAt:page.generatedAt});
  }
  return result;
}
