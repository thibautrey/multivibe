import { useEffect, useMemo, useState } from 'react';
import type { Account, ExposedModel } from '../../types';
import { api } from '../../lib/api';
import { aggregateModels, type CloudModel, type ModelRoute } from '../../lib/modelCatalog';
import type { CloudProvider } from '../ProviderPicker';
import './ModelsTab.css';

export function ModelsTab({ models, accounts, cloudConnected, onUse, onConfigure, onConnectCloud }: {
  models: ExposedModel[]; accounts: Account[]; cloudConnected: boolean;
  onUse: (id: string) => void; onConfigure: (route: ModelRoute) => void; onConnectCloud: () => Promise<void>;
}) {
  const [cloud, setCloud] = useState<CloudModel[]>([]);
  const [providers, setProviders] = useState<CloudProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [readyOnly, setReadyOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setErrors([]);
    void Promise.allSettled([api('/admin/cloud/models'), api('/admin/provider-catalog')]).then(([cloudResult, providerResult]) => {
      if (!active) return;
      const failures: string[] = [];
      if (cloudResult.status === 'fulfilled') setCloud(cloudResult.value.models); else failures.push('Le catalogue MultiVibe Cloud est indisponible.');
      if (providerResult.status === 'fulfilled') setProviders(providerResult.value.providers); else failures.push('Le catalogue des providers est indisponible.');
      setErrors(failures); setLoading(false);
    });
    return () => { active = false; };
  }, [revision]);
  const catalog = useMemo(() => aggregateModels(models, accounts, cloud, providers), [models, accounts, cloud, providers]);
  const filtered = useMemo(() => catalog.filter(model => {
    const routes = model.routes.filter(route => source === 'all' || route.source === source);
    return routes.length && (!readyOnly || routes.some(route => route.ready)) && query.toLocaleLowerCase().trim().split(/\s+/).every(term => `${model.name} ${model.id} ${model.routes.map(route => route.label).join(' ')}`.toLocaleLowerCase().includes(term));
  }), [catalog, query, source, readyOnly]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 30) - 1));
  const connect = async () => {
    setConnecting(true);
    try { await onConnectCloud(); } catch { setErrors(current => [...current, 'La connexion à MultiVibe Cloud a échoué. Réessayez.']); }
    finally { setConnecting(false); }
  };
  return <section className="panel models-catalog" aria-labelledby="models-title">
    <div className="section-split-header"><div><h2 id="models-title">Modèles</h2><p className="muted">Vos providers, vos modèles locaux et le catalogue MultiVibe Cloud réunis.</p></div><button className="btn ghost" disabled={loading} onClick={() => setRevision(value => value + 1)}>Actualiser</button></div>
    <div className="models-cloud-banner"><div><strong>MultiVibe Cloud</strong><p className="muted">Les modèles référencés peuvent nécessiter une offre compatible ou de la capacité disponible. Leur présence au catalogue ne garantit pas leur accès.</p></div>{!cloudConnected && <button className="btn" disabled={connecting} onClick={() => void connect()}>Se connecter</button>}</div>
    <div className="models-controls"><label>Rechercher<input type="search" value={query} placeholder="Nom du modèle ou provider…" onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><label>Source<select value={source} onChange={event => { setSource(event.target.value); setPage(0); }}><option value="all">Toutes les sources</option><option value="provider">Providers</option><option value="local">Local</option><option value="cloud">MultiVibe Cloud</option></select></label><label className="models-ready"><input type="checkbox" checked={readyOnly} onChange={event => { setReadyOnly(event.target.checked); setPage(0); }} /> Disponibles maintenant</label></div>
    {errors.map((error, index) => <p role="alert" key={index}>{error}</p>)}
    <p className="muted" role="status">{filtered.length} modèles{loading ? ' · Chargement des catalogues…' : ''}</p>
    <ul className="models-list">{filtered.slice(currentPage * 30, (currentPage + 1) * 30).map(model => {
      const routes = model.routes.filter(route => source === 'all' || route.source === source);
      const ready = routes.find(route => route.ready);
      const preferred = ready ?? routes.find(route => route.accountId) ?? routes.find(route => route.source === 'cloud') ?? routes[0];
      return <li key={model.id}><div className="models-copy"><strong>{model.name}</strong><code>{model.id}</code><span className="muted">{[...new Set(routes.map(route => route.label))].join(' · ')}</span></div><span className={`badge${ready ? ' ok' : ''}`}>{ready ? 'Disponible' : 'Accès à configurer'}</span><button className="btn ghost" disabled={connecting} onClick={() => {
        if (ready) onUse(ready.modelId);
        else if (preferred.source === 'cloud' && !cloudConnected) void connect();
        else onConfigure(preferred);
      }}>{ready ? 'Utiliser' : preferred.source === 'cloud' && !cloudConnected ? 'Se connecter' : 'Configurer'}</button></li>;
    })}</ul>
    {!filtered.length && !loading && <p>Aucun modèle ne correspond à ces filtres.</p>}
    {filtered.length > 30 && <div className="models-pagination"><button className="btn ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Précédent</button><span>Page {currentPage + 1} / {Math.ceil(filtered.length / 30)}</span><button className="btn ghost" disabled={(currentPage + 1) * 30 >= filtered.length} onClick={() => setPage(currentPage + 1)}>Suivant</button></div>}
  </section>;
}
