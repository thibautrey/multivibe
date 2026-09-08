import { useEffect, useMemo, useState } from 'react';
import type { Account, ExposedModel } from '../../types';
import { api } from '../../lib/api';
import { aggregateModels, filterCatalog, type CloudModel, type ModelRoute } from '../../lib/modelCatalog';
import type { CloudProvider } from '../ProviderPicker';
import './ModelsTab.css';

const sources = [{ id: 'all', label: 'All sources' }, { id: 'provider', label: 'Providers' }, { id: 'local', label: 'Local models' }, { id: 'cloud', label: 'MultiVibe Cloud' }];
const PAGE_SIZE = 20;

export function ModelsTab({ models, accounts, cloudConnected, onUse, onConfigure, onConnectCloud }: {
  models: ExposedModel[]; accounts: Account[]; cloudConnected: boolean;
  onUse: (id: string) => void; onConfigure: (route: ModelRoute) => void; onConnectCloud: () => Promise<void>;
}) {
  const [cloud, setCloud] = useState<CloudModel[]>([]);
  const [providers, setProviders] = useState<CloudProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [provider, setProvider] = useState('all');
  const [readyOnly, setReadyOnly] = useState(false);
  const [sort, setSort] = useState('ready');
  const [page, setPage] = useState(0);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.allSettled([api('/admin/cloud/models'), api('/admin/provider-catalog')]).then(([cloudResult, providerResult]) => {
      if (!active) return;
      if (cloudResult.status === 'fulfilled') setCloud(cloudResult.value.models);
      if (providerResult.status === 'fulfilled') setProviders(providerResult.value.providers);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);
  const catalog = useMemo(() => aggregateModels(models, accounts, cloud, providers), [models, accounts, cloud, providers]);
  const providerOptions = useMemo(() => [...new Set(catalog.flatMap(model => model.routes.filter(route => source === 'all' || route.source === source).map(route => route.label)))].sort((a, b) => a.localeCompare(b)), [catalog, source]);
  const filtered = useMemo(() => filterCatalog(catalog, { query, source, provider, readyOnly, sort }), [catalog, query, source, provider, readyOnly, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const activeFilters = Boolean(query || source !== 'all' || provider !== 'all' || readyOnly);
  const reset = () => { setQuery(''); setSource('all'); setProvider('all'); setReadyOnly(false); setPage(0); };
  const connect = async () => {
    setConnecting(true);
    setConnectionError('');
    try { await onConnectCloud(); } catch { setConnectionError('Could not connect to MultiVibe Cloud. Please try again.'); }
    finally { setConnecting(false); }
  };
  const useRoute = (route: ModelRoute) => {
    if (route.ready) onUse(route.modelId);
    else if (route.source === 'cloud' && !cloudConnected) void connect();
    else onConfigure(route);
  };
  const actionLabel = (route: ModelRoute) => route.ready ? 'Use model' : route.source === 'cloud' ? cloudConnected ? 'View access' : 'Connect Cloud' : 'Set up';
  return <section className="panel models-catalog" aria-label="Model library">
    <div className="models-layout">
      <aside className="models-sidebar" aria-label="Model filters">
        <div className="models-filter-heading"><strong>Filters</strong>{activeFilters && <button className="models-text-button" onClick={reset}>Reset</button>}</div>
        <fieldset><legend>Source</legend>{sources.map(item => <button key={item.id} className="models-source" aria-pressed={source === item.id} onClick={() => { setSource(item.id); setProvider('all'); setPage(0); }}><span>{item.label}</span><span>{catalog.filter(model => item.id === 'all' || model.routes.some(route => route.source === item.id)).length.toLocaleString('en-US')}</span></button>)}</fieldset>
        <fieldset><legend>Availability</legend><label className="models-ready"><input type="checkbox" checked={readyOnly} onChange={event => { setReadyOnly(event.target.checked); setPage(0); }} /> Ready to use</label><p className="muted">Models with a connected, available account.</p></fieldset>
        <label className="models-provider">Provider or runtime<select value={provider} onChange={event => { setProvider(event.target.value); setPage(0); }}><option value="all">All providers</option>{providerOptions.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <div className="models-cloud-card"><strong>MultiVibe Cloud</strong><p className="muted">Cloud access depends on your plan and available capacity.</p>{!cloudConnected && <button className="btn ghost" disabled={connecting} onClick={() => void connect()}>{connecting ? 'Connecting…' : 'Connect Cloud'}</button>}</div>
      </aside>
      <div className="models-results" aria-busy={loading}>
        <div className="models-toolbar"><label className="models-search"><span className="sr-only">Search models</span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input type="search" value={query} placeholder="Search models or providers…" onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><select aria-label="Sort models" value={sort} onChange={event => { setSort(event.target.value); setPage(0); }}><option value="ready">Ready to use first</option><option value="name">Name: A–Z</option><option value="name-desc">Name: Z–A</option></select></div>
        {connectionError && <p className="models-error" role="alert">{connectionError}</p>}
        <div className="models-result-bar"><span role="status"><strong>{filtered.length.toLocaleString('en-US')}</strong> models{loading ? ' · Updating catalogs…' : filtered.length ? ` · Showing ${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)}` : ''}</span>{activeFilters && <button className="models-text-button" onClick={reset}>Clear filters</button>}</div>
        <div className="models-list-head" aria-hidden="true"><span>Model / provider</span><span>Availability</span><span /></div>
        <ul className="models-list">{filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(model => {
          const ready = model.routes.find(route => route.ready);
          const preferred = ready ?? model.routes.find(route => route.accountId) ?? model.routes.find(route => route.source === 'cloud') ?? model.routes[0];
          return <li key={model.id}><div className="models-row"><div className="models-identity"><span className={`models-mark${model.logo ? ' has-logo' : ''}`} aria-hidden="true">{model.logo ? <img src={`/assets/catalog-icons/models/${model.logo}`} alt="" loading="lazy" decoding="async" /> : model.name.replace(/^(hf|openrouter):/, '').slice(0, 2).toUpperCase()}</span><div className="models-copy"><strong>{model.name}</strong><code>{model.id}</code><span className="muted">{[...new Set(model.routes.map(route => route.label))].join(' · ')}</span></div></div><span className={`models-status${ready ? ' is-ready' : ''}`}><i />{ready ? 'Ready to use' : 'Setup needed'}</span><button className={`btn ${ready ? '' : 'ghost'}`} disabled={connecting} aria-label={`${actionLabel(preferred)}: ${model.name}`} onClick={() => useRoute(preferred)}>{actionLabel(preferred)}<span aria-hidden="true"> →</span></button></div>
            {model.routes.length > 1 && <details className="models-routes"><summary>View {model.routes.length} connection options</summary><ul>{model.routes.map((route, index) => <li key={index}><div><strong>{route.label}</strong><span className="muted">{route.ready ? 'Ready to use' : 'Setup needed'} · {route.source === 'local' ? 'Local' : route.source === 'cloud' ? 'Cloud' : 'Provider'}</span></div><button className="btn ghost" disabled={connecting} onClick={() => useRoute(route)}>{actionLabel(route)}</button></li>)}</ul></details>}
          </li>;
        })}</ul>
        {!filtered.length && <div className="models-empty"><h3>{loading ? 'Loading your model library…' : activeFilters ? 'No models match your filters' : 'Your model library is empty'}</h3><p className="muted">{loading ? 'Connected models will appear as catalogs become available.' : activeFilters ? 'Try a different search, source, or provider.' : 'Connect a provider or refresh the catalog to get started.'}</p>{activeFilters && <button className="btn ghost" onClick={reset}>Clear filters</button>}</div>}
        {pages > 1 && <nav className="models-pagination" aria-label="Model pages"><button className="btn ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← Previous</button><label>Page<select aria-label="Go to page" value={currentPage} onChange={event => setPage(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select>of {pages}</label><button className="btn ghost" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Next →</button></nav>}
      </div>
    </div>
  </section>;
}
