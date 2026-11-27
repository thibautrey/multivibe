import { useDashboardApi, useDashboardRuntime } from "../../adapter";
import { useEffect, useMemo, useState } from 'react';
import type { Account, ExposedModel } from '../../types';

import { aggregateModels, filterCatalog, mergeCloudModelPage, type CloudModel, type ModelRoute } from '../../lib/modelCatalog';
import type { CloudProvider } from '../ProviderPicker';
import './ModelsTab.css';
import { verifiedCloudCatalog, type CloudAccess } from '../../lib/modelGuidance';
import { activeLocale, useI18n } from '../../i18n';
import { ModelBillingPanel } from '../ModelBillingPanel';

const coreSources = [{ id: 'all', label: 'All sources' }, { id: 'provider', label: 'Providers' }, { id: 'cloud', label: 'MultiVibe Cloud' }];
const PAGE_SIZE = 20;

export function ModelsTab({ canConfigure = true, models, accounts, cloudConnected, onUse, onConfigure, onConnectCloud, onDetails }: {
  canConfigure?: boolean; models: ExposedModel[]; accounts: Account[]; cloudConnected: boolean;
  onDetails?: (id: string) => void;
  onUse: (id: string) => void; onConfigure: (route: ModelRoute) => void; onConnectCloud: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const api = useDashboardApi();
  const { capabilities } = useDashboardRuntime();
  const sources = (capabilities.host ? coreSources : [{id:'all',label:'All sources'},{id:'cloud',label:'MultiVibe'},{id:'personal',label:'Personal connections'},{id:'team',label:'Team'}]).map(item => ({ ...item, label: t(item.label) }));
  const [cloudAccess, setCloudAccess] = useState<CloudAccess>();
  const [accessRequest, setAccessRequest] = useState(0);
  useEffect(() => {
    setCloudAccess(undefined);
    if (!cloudConnected || !canConfigure) return;
    const controller = new AbortController();
    void api('cloud/accessible-models', { signal: controller.signal }).then((result: CloudAccess) => {
      if (!controller.signal.aborted) setCloudAccess(result);
    }).catch(() => { if (!controller.signal.aborted) setCloudAccess({ status: 'unavailable', modelIds: [], checkedAt: '' }); });
    return () => controller.abort();
  }, [cloudConnected, canConfigure, accessRequest]);
  const [cloud, setCloud] = useState<CloudModel[]>([]);
  const [catalogCursor, setCatalogCursor] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalogMoreError, setCatalogMoreError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [catalogRequest, setCatalogRequest] = useState(0);
  const [providers, setProviders] = useState<CloudProvider[]>([]);
  const [loading, setLoading] = useState(false);
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
    if (!canConfigure) { setLoading(false); return; }
    setLoading(true);
    setCatalogError('');
    void Promise.allSettled([api('cloud/models'), api('provider-catalog')]).then(([cloudResult, providerResult]) => {
      if (!active) return;
      if (cloudResult.status === 'fulfilled') {
        setCloud(cloudResult.value.models);
        setCatalogCursor(typeof cloudResult.value.nextCursor === 'string' ? cloudResult.value.nextCursor : '');
      }
      if (providerResult.status === 'fulfilled') setProviders(providerResult.value.providers);
      setCatalogError([cloudResult.status === 'rejected' ? t('MultiVibe Cloud discovery catalog could not be loaded.') : '', providerResult.status === 'rejected' ? t('Provider discovery catalog could not be loaded.') : ''].filter(Boolean).join(' '));
      setLoading(false);
    });
    return () => { active = false; };
  }, [canConfigure, catalogRequest]);
  const loadMoreCatalog = async () => {
    if (!catalogCursor || loadingMore) return;
    const cursor = catalogCursor;
    setLoadingMore(true);
    setCatalogMoreError('');
    try {
      const result = await api(`cloud/models?cursor=${encodeURIComponent(cursor)}`);
      setCloud(current => mergeCloudModelPage(current, result.models ?? []));
      const next = typeof result.nextCursor === 'string' ? result.nextCursor : '';
      if (next === cursor) {
        setCatalogCursor('');
        setCatalogMoreError(t('The catalog did not advance. Refresh it before trying again.'));
      } else setCatalogCursor(next);
    } catch {
      setCatalogMoreError(t('More models could not be loaded. Try again.'));
    } finally {
      setLoadingMore(false);
    }
  };
  const rawCatalog = useMemo(() => aggregateModels(models, accounts, canConfigure ? cloud : [], canConfigure ? providers : []), [models, accounts, cloud, providers, canConfigure, locale]);
  const catalog = useMemo(() => canConfigure ? verifiedCloudCatalog(rawCatalog, cloudAccess, cloudConnected) : rawCatalog, [rawCatalog, cloudAccess, cloudConnected, canConfigure]);
  const providerOptions = useMemo(() => [...new Set(catalog.flatMap(model => model.routes.filter(route => source === 'all' || (route.source === source || route.accessSource === source)).map(route => route.label)))].sort((a, b) => a.localeCompare(b)), [catalog, source]);
  // Route labels are localized, so a language switch can retire the selected value.
  const providerFilter = provider === 'all' || providerOptions.includes(provider) ? provider : 'all';
  const filtered = useMemo(() => filterCatalog(catalog, { query, source, provider: providerFilter, readyOnly, sort }), [catalog, query, source, providerFilter, readyOnly, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const activeFilters = Boolean(query || source !== 'all' || provider !== 'all' || readyOnly);
  const reset = () => { setQuery(''); setSource('all'); setProvider('all'); setReadyOnly(false); setPage(0); };
  const connect = async () => {
    setConnecting(true);
    setConnectionError('');
    try { await onConnectCloud(); } catch { setConnectionError(t('Could not connect to MultiVibe Cloud. Please try again.')); }
    finally { setConnecting(false); }
  };
  const useRoute = (route: ModelRoute) => {
    if (!canConfigure && !cloudConnected) return;
    if (route.ready) onUse(route.modelId);
    else if (!canConfigure) return;
    else if (capabilities.cloudConnection && route.source === 'cloud' && !cloudConnected) void connect();
    else onConfigure(route);
  };
  const actionLabel = (route: ModelRoute) => route.ready ? canConfigure ? t('Use model') : t('Open chat') : !canConfigure ? t('Ask your admin') : route.source === 'cloud' ? cloudConnected || !capabilities.cloudConnection ? t('View access') : t('Connect Cloud') : t('Set up');
  const total = filtered.length;
  const firstShown = currentPage * PAGE_SIZE + 1;
  const lastShown = Math.min((currentPage + 1) * PAGE_SIZE, total);
  const resultSummary = loading
    ? t(total === 1 ? 'model · Updating catalogs…' : 'models · Updating catalogs…')
    : total
      ? (total === 1 ? t('model · Showing {from}–{to}', { from: firstShown, to: lastShown }) : t('models · Showing {from}–{to}', { from: firstShown, to: lastShown }))
      : t(total === 1 ? 'model' : 'models');
  return <section className="models-catalog" aria-label={t("Models")}>
    <header className="models-page-heading"><div><h2>{t("Find the right model")}</h2><p>{t("Explore your connected providers and MultiVibe Cloud models.")}</p></div></header>
    {canConfigure && capabilities.host && <ModelBillingPanel />}
    {cloudConnected && canConfigure && <div className="models-access-notice" role="status">
      {!cloudAccess ? t('Checking your Cloud access…') : cloudAccess.status === 'available'
        ? !cloudAccess.modelIds.length ? t('No models exposed for your Cloud account.')
          : !catalog.some(model => model.routes.some(route => route.source === 'cloud' && route.ready)) ? t('Cloud exposes models, but no matching chat route is available here.') : t('Cloud catalog verified for your account.')
        : cloudAccess.status === 'access_denied' ? t('Cloud access denied or expired. Check your connection.') : cloudAccess.status === 'disconnected' ? t('Cloud account disconnected.') : t('Could not verify your Cloud access.')}
      <button className="models-text-button" disabled={!cloudAccess} onClick={() => { setCloudAccess(undefined); setAccessRequest(value => value + 1); }}>{t('Check again')}</button>
    </div>}
    <div className="models-layout models-expert-library">
      <details className="models-expert-filters"><summary>{activeFilters ? t('Filters · Active filters') : t('Filters')}</summary><div className="models-sidebar" aria-label={t("Model filters")}>
        <div className="models-filter-heading"><strong>{t("Filters")}</strong>{activeFilters && <button className="models-text-button" onClick={reset}>{t("Reset")}</button>}</div>
        <fieldset><legend>{t("Source")}</legend>{sources.map(item => <button key={item.id} className="models-source" aria-pressed={source === item.id} onClick={() => { setSource(item.id); setProvider('all'); setPage(0); }}><span>{item.label}</span><span>{catalog.filter(model => item.id === 'all' || model.routes.some(route => (route.source === item.id || route.accessSource === item.id))).length.toLocaleString(activeLocale())}</span></button>)}</fieldset>
        <fieldset><legend>{t("Availability")}</legend><label className="models-ready"><input type="checkbox" checked={readyOnly} onChange={event => { setReadyOnly(event.target.checked); setPage(0); }} /> {t("Ready to use")}</label><p className="muted">{t("Models with a connected, available account.")}</p></fieldset>
        <label className="models-provider">{t("Provider")}<select value={providerFilter} onChange={event => { setProvider(event.target.value); setPage(0); }}><option value="all">{t("All providers")}</option>{providerOptions.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <div className="models-cloud-card"><strong>MultiVibe Cloud</strong><p className="muted">{t("Cloud access depends on your plan and available capacity.")}</p>{capabilities.cloudConnection && !cloudConnected && <button className="btn ghost" disabled={connecting} onClick={() => void connect()}>{connecting ? t('Connecting…') : t('Connect Cloud')}</button>}</div>
      </div></details>
      <div className="models-results" aria-busy={loading}>
        {catalogError && <p className="models-error" role="alert">{catalogError} <button className="btn ghost" disabled={loading} onClick={() => setCatalogRequest(value => value + 1)}>{t("Retry catalogs")}</button></p>}
        <div className="models-toolbar"><label className="models-search"><span className="sr-only">{t("Search models")}</span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input type="search" value={query} placeholder={t("Search models or providers…")} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><select aria-label={t("Sort models")} value={sort} onChange={event => { setSort(event.target.value); setPage(0); }}><option value="ready">{t("Ready to use first")}</option><option value="name">{t("Name: A–Z")}</option><option value="name-desc">{t("Name: Z–A")}</option></select></div>
        {connectionError && <p className="models-error" role="alert">{connectionError}</p>}
        <div className="models-result-bar"><span role="status"><strong>{total.toLocaleString(activeLocale())}</strong> {resultSummary}</span>{activeFilters && <button className="models-text-button" onClick={reset}>{t("Clear filters")}</button>}</div>
        <div className="models-list-head" aria-hidden="true"><span>{t("Model / provider")}</span><span>{t("Availability")}</span><span /></div>
        <ul className="models-list">{filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(model => {
          const ready = model.routes.find(route => route.ready);
          const preferred = ready ?? model.routes.find(route => route.accountId) ?? model.routes.find(route => route.source === 'cloud') ?? model.routes[0];
          return <li key={model.id}><div className="models-row"><div className="models-identity"><span className={`models-mark${model.logo ? ' has-logo' : ''}`} aria-hidden="true">{model.logo ? <img src={`/assets/catalog-icons/models/${model.logo}`} alt="" loading="lazy" decoding="async" /> : model.name.replace(/^(hf|openrouter):/, '').slice(0, 2).toUpperCase()}</span><div className="models-copy"><strong>{model.name}</strong><code>{model.id}</code><span className="muted">{[...new Set(model.routes.map(route => route.label))].join(' · ')}</span>{preferred.priceSummary && <span className="muted">{preferred.priceSummary}</span>}</div></div><span className={`models-status${ready ? ' is-ready' : ''}`}><i />{ready ? t('Ready to use') : (preferred.availabilityLabel ?? t('Unavailable'))}</span><div className="inline wrap">{onDetails && <button className="btn ghost" aria-label={t('Details: {name}', { name: model.name })} onClick={() => onDetails(model.id)}>{t("Details")}</button>}{(canConfigure || cloudConnected) && <button className={`btn ${ready ? '' : 'ghost'}`} disabled={connecting || (!canConfigure && !preferred.ready)} aria-label={t('{action}: {name}', { action: actionLabel(preferred), name: model.name })} onClick={() => useRoute(preferred)}>{actionLabel(preferred)}<span aria-hidden="true"> →</span></button>}</div></div>
            {model.routes.length > 1 && <details className="models-routes"><summary>{t('View {count} connection options', { count: model.routes.length })}</summary><ul>{model.routes.map((route, index) => <li key={index}><div><strong>{route.label}</strong><span className="muted">{route.availabilityLabel ?? (route.ready ? t('Ready to use') : t('Unavailable'))}{route.priceSummary ? ` · ${route.priceSummary}` : ''} · {route.source === 'local' ? t('Local') : route.source === 'cloud' ? t('Cloud') : t('Provider')}</span></div>{(canConfigure || cloudConnected) && <button className="btn ghost" disabled={connecting || (!canConfigure && !route.ready)} onClick={() => useRoute(route)}>{actionLabel(route)}</button>}</li>)}</ul></details>}
          </li>;
        })}</ul>
        {!filtered.length && <div className="models-empty"><h3>{loading ? t('Loading your model library…') : activeFilters ? t('No models match your filters') : t('Your model library is empty')}</h3><p className="muted">{loading ? t('Connected models will appear as catalogs become available.') : activeFilters ? t('Try a different search, source, or provider.') : t('Connect a provider or refresh the catalog to get started.')}</p>{activeFilters && <button className="btn ghost" onClick={reset}>{t("Clear filters")}</button>}</div>}
        {pages > 1 && <nav className="models-pagination" aria-label={t("Model pages")}><button className="btn ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("← Previous")}</button><label>{t("Page")}<select aria-label={t("Go to page")} value={currentPage} onChange={event => setPage(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select>{t("of {total}", { total: pages })}</label><button className="btn ghost" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>{t("Next →")}</button></nav>}
        {catalogCursor && <div className="models-pagination"><button className="btn ghost" disabled={loadingMore} onClick={() => void loadMoreCatalog()}>{loadingMore ? t('Loading more…') : t('Load more models')}</button></div>}
        {catalogMoreError && <p className="models-error" role="alert">{catalogMoreError}{catalogCursor && <button className="models-text-button" disabled={loadingMore} onClick={() => void loadMoreCatalog()}>{t("Try again")}</button>}</p>}

      </div>
    </div>
  </section>;
}
