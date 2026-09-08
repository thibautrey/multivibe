import type { Account, ExposedModel } from '../types';
import type { CloudProvider, SetupProvider } from '../components/ProviderPicker';

export type CloudModel = { id: string; name: string; aliases: string[]; availability: string; network: boolean };
export type ModelRoute = { source: 'provider' | 'local' | 'cloud'; label: string; modelId: string; ready: boolean; accountId?: string; provider?: SetupProvider; sdkProvider?: string };
export type CatalogEntry = { id: string; name: string; routes: ModelRoute[] };

export function aggregateModels(models: ExposedModel[], accounts: Account[], cloud: CloudModel[], providers: CloudProvider[], now = Date.now()): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  const aliases = new Map<string, string>();
  // Only merge identities explicitly declared by the catalog, never fuzzy model names.
  for (const model of cloud) {
    aliases.set(model.id, model.id);
    for (const alias of model.aliases) {
      if (!aliases.has(alias)) aliases.set(alias, model.id);
    }
  }
  // OpenRouter SDK IDs add a routing namespace to the exact upstream alias.
  for (const provider of providers.filter(provider => provider.id === 'openrouter')) {
    for (const model of provider.models) {
      const canonical = aliases.get(model.id);
      if (canonical) aliases.set(`openrouter/${model.id}`, canonical);
    }
  }
  const add = (id: string, name: string, route: ModelRoute) => {
    const key = aliases.get(id) ?? id;
    const entry = entries.get(key) ?? { id: key, name, routes: [] };
    if (!entry.routes.some(item => item.source === route.source && item.accountId === route.accountId && item.modelId === route.modelId && item.sdkProvider === route.sdkProvider)) entry.routes.push(route);
    entries.set(key, entry);
  };
  const healthy = (account: Account, modelId: string) => account.enabled && !account.state?.needsTokenRefresh
    && !(Number(account.state?.authBlockedUntil) > now) && !(Number(account.state?.modelBlocks?.[modelId]?.until) > now);
  for (const model of models) {
    const candidates = model.metadata?.provider_candidates ?? (model.metadata?.provider ? [model.metadata.provider] : []);
    const matching = accounts.filter(account => model.metadata?.account_ids?.length
      ? model.metadata.account_ids.includes(account.id)
      : candidates.includes(account.provider ?? 'openai') && (account.provider !== 'ai-sdk' || account.sdkProvider === model.metadata?.sdk_provider)
        && (account.provider !== 'openai-compatible' || account.localRuntime?.confirmedModelIds.includes(model.id)));
    for (const account of matching) {
      const source = account.id === 'multivibe-cloud' ? 'cloud' : account.localRuntime || account.location === 'local' ? 'local' : 'provider';
      add(model.id, model.id, { source, label: source === 'cloud' ? 'MultiVibe Cloud' : account.localRuntime?.adapter ?? account.sdkProvider ?? account.provider ?? 'OpenAI',
        modelId: model.id, ready: healthy(account, model.id), accountId: account.id, provider: account.provider ?? 'openai', sdkProvider: account.sdkProvider });
    }
    if (!matching.length) add(model.id, model.id, { source: 'provider', label: model.metadata?.is_alias ? 'Routing alias' : candidates.join(' · ') || 'Provider', modelId: model.id, ready: false, provider: candidates[0] });
  }
  for (const account of accounts.filter(account => account.localRuntime)) {
    for (const id of account.localRuntime!.confirmedModelIds) add(id, id, { source: 'local', label: account.localRuntime!.adapter, modelId: id, ready: healthy(account, id), accountId: account.id });
  }
  for (const provider of providers) for (const model of provider.models) {
    const id = `${provider.id}/${model.id}`;
    const key = aliases.get(id) ?? id;
    if (entries.get(key)?.routes.some(route => route.modelId === id && route.sdkProvider === provider.id)) continue;
    add(id, model.name, { source: 'provider', label: provider.name, modelId: id, ready: false, provider: 'ai-sdk', sdkProvider: provider.id });
  }
  for (const model of cloud) {
    const entry = entries.get(model.id);
    if (entry) entry.name = model.name;
    if (entry?.routes.some(route => route.source === 'cloud')) continue;
    add(model.id, model.name, { source: 'cloud', label: model.network ? 'MultiVibe Cloud network' : 'MultiVibe Cloud catalog', modelId: model.id, ready: false });
  }
  return [...entries.values()].sort((a, b) => Number(b.routes.some(route => route.ready)) - Number(a.routes.some(route => route.ready)) || a.name.localeCompare(b.name));
}

// Keep only matching routes so availability and actions respect the selected filters.
export function filterCatalog(catalog: CatalogEntry[], filters: { query: string; source: string; provider: string; readyOnly: boolean; sort: string }): CatalogEntry[] {
  const terms = filters.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return catalog.map(model => ({ ...model, routes: model.routes.filter(route =>
    (filters.source === 'all' || route.source === filters.source)
    && (filters.provider === 'all' || route.label === filters.provider)
    && (!filters.readyOnly || route.ready)) }))
    .filter(model => model.routes.length && terms.every(term => `${model.name} ${model.id} ${model.routes.map(route => route.label).join(' ')}`.toLowerCase().includes(term)))
    .sort((a, b) => (filters.sort === 'ready' ? Number(b.routes.some(route => route.ready)) - Number(a.routes.some(route => route.ready)) : 0)
      || (filters.sort === 'name-desc' ? -1 : 1) * (a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en')));
}
