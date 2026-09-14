import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { OpenModelCatalog } from '../../../../src/open-model-catalog';

export function OpenModelDiscovery({ compact }: { compact: boolean }) {
  const [catalog, setCatalog] = useState<OpenModelCatalog>();
  const [error, setError] = useState(false);
  const [request, setRequest] = useState(0);
  const [sort, setSort] = useState('trending');
  const [limit, setLimit] = useState(24);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const load = () => { void api('/admin/open-model-catalog', { signal: controller.signal }).then((data: OpenModelCatalog) => {
      if (!controller.signal.aborted) { setCatalog(data); setError(false); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); }); };
    load();
    const interval = window.setInterval(load, 60 * 60 * 1000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [request]);
  let models = (catalog?.models ?? []).filter(model => model.id.toLowerCase().includes(query.toLowerCase()));
  if (sort === 'newest') models = [...models].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return <section className="models-open-discovery" aria-label="Open model discovery">
    <div className="models-selection-heading"><h3>Discover open models</h3><span>Live public catalog</span></div>
    <p className="muted">Public chat models with permissive license tags. Not installed or tested on your computer.</p>
    {!compact && <div className="models-compare-filters"><label>Search<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Model or publisher" /></label><label>Sort<select value={sort} onChange={event => setSort(event.target.value)}><option value="trending">Trending first</option><option value="newest">Newest repositories</option></select></label></div>}
    {(!catalog && !error) && <p role="status">Loading public models…</p>}
    {(error || catalog?.stale) && <p role="status">{catalog ? 'Showing previously fetched models. Refresh is unavailable.' : 'The public catalog could not be loaded.'} <button className="btn ghost" onClick={() => setRequest(value => value + 1)}>Retry</button></p>}
    <div className="models-choice-grid">{models.slice(0, compact ? 3 : limit).map(model => <article className="models-choice" key={model.id}>
      <span className="models-choice-badge">Discovery only</span><h3>{model.id}</h3>
      <p>{model.license} · {model.createdAt ? `Added ${new Date(model.createdAt).toLocaleDateString('en-GB')}` : 'Date unknown'}</p>
      <p className="muted">Hardware, speed and setup requirements need checking.</p>
      <a className="btn ghost" href={model.url} target="_blank" rel="noreferrer">View model card ↗</a>
    </article>)}</div>
    {!compact && models.length > limit && <button className="btn ghost" onClick={() => setLimit(value => value + 24)}>Show more models</button>}
    {catalog && !models.length && <p>No models match. Try a different search or refresh later.</p>}
    <details><summary>Where does this list come from?</summary><p>Hugging Face Hub: a bounded feed of trending and newly created chat-model repositories, refreshed hourly while this page is open. New repository dates are not release dates. Popularity is not a quality recommendation.</p><p>Only public, ungated repositories tagged MIT, Apache-2.0, BSD or ISC are included. Publisher metadata is not an independent license audit or proof of full open-source AI compliance. Review the model card before use. Opening it contacts Hugging Face; no chat content is sent by this catalog.</p></details>
    {catalog && <p className="muted">Checked {new Date(catalog.checkedAt).toLocaleString('en-GB')} · Source: Hugging Face · No automatic downloads</p>}
  </section>;
}
