import { LocalPreparationPanel } from './LocalPreparationPanel';
import publisherIcons from './publisher-icons.json';
import { useEffect, useState } from 'react';
import { relevantChoices, type GuidanceEntry } from '../../../../src/model-guidance';
import { api } from '../../lib/api';
import type { OpenModelCatalog, CatalogNeed, CatalogSort, rankOpenModels } from '../../../../src/open-model-ranking';
type Result = {catalog: OpenModelCatalog; host: {name:string; supported:boolean} | null; recommendations: ReturnType<typeof rankOpenModels>};
const sortLabels: Record<CatalogSort,string> = {recommended:'Recommended',trending:'Trending',downloads:'Top downloaded',newest:'New',established:'Established',community:'Most used on MultiVibe'};
function saved(key:string, fallback:string) { try {return localStorage.getItem(key) ?? fallback;} catch {return fallback;} }
export function OpenModelDiscovery({ compact, need: selectedNeed, expert = false, connected = [], onUse }: { compact: boolean; need?: CatalogNeed; expert?: boolean; connected?: GuidanceEntry[]; onUse?: (id:string)=>void }) {
  const [need,setNeed] = useState<CatalogNeed>(()=>{const v=saved('multivibe.models.need.v1','writing');return ['writing','coding','translation','documents'].includes(v)?v as CatalogNeed:'writing';});
  const effectiveNeed = selectedNeed ?? need;
  const [sort,setSort] = useState<CatalogSort>(()=>{const v=saved('multivibe.models.sort.v1','recommended');return Object.prototype.hasOwnProperty.call(sortLabels,v)?v as CatalogSort:'recommended';});
  const [result,setResult] = useState<Result>(); const [error,setError] = useState(false);
  const [request,setRequest] = useState(0); const [query,setQuery] = useState(''); const [limit,setLimit] = useState(compact ? 6 : 12);
  const [preparing,setPreparing] = useState<string|null>(null);
  const [fitOnly,setFitOnly] = useState(false);
  useEffect(()=>{try {localStorage.setItem('multivibe.models.sort.v1',sort);localStorage.setItem('multivibe.models.need.v1',effectiveNeed);} catch {/* Optional browser storage. */}},[sort,effectiveNeed]);
  useEffect(()=>{
    const controller=new AbortController(); setResult(undefined);setError(false);setLimit(compact ? 6 : 12);
    const load=()=>void api(`/admin/model-recommendations?need=${effectiveNeed}&sort=${sort}&host=local`,{signal:controller.signal}).then((value:Result)=>{if(!controller.signal.aborted){setResult(value);setError(false);}}).catch(()=>{if(!controller.signal.aborted)setError(true);});
    load();const timer=setInterval(load,60000);return()=>{controller.abort();clearInterval(timer);};
  },[effectiveNeed,sort,request,compact]);
  const readyChoices = relevantChoices(connected, effectiveNeed, result?.catalog.models ?? []);
  const readyFor = (id:string) => readyChoices.find(choice=>choice.route.modelId===id);
  const models=(result?.recommendations ?? []).filter(row=>row.model.id.toLowerCase().includes(query.trim().toLowerCase()) && (!fitOnly || row.compatibility==='compatible' || readyFor(row.model.id)?.route.source==='local')).sort((a,b)=>sort==='recommended'?Number(Boolean(readyFor(b.model.id)))-Number(Boolean(readyFor(a.model.id))):0);
  return <section className={`models-open-discovery${expert ? '' : ' models-picker'}${compact ? ' is-beginner' : ''}`} aria-label="Open model discovery">
    <div className="models-picker-toolbar"><div className="models-selection-heading"><span className="models-host-symbol" aria-hidden="true">▱</span><div><h3>{result?.host?.supported ? 'Recommended for your Host' : 'Recommended for your task'}</h3><p className="muted">{result?.host ? `${result.host.name}${result.host.supported ? '' : ' · Unsupported platform'}` : 'Connect Host to check compatibility'}</p></div></div>
    <div className="models-compare-filters">
      {!selectedNeed && <label>Task<select value={need} onChange={e=>setNeed(e.target.value as CatalogNeed)}><option value="writing">Chat and write</option><option value="coding">Code</option><option value="translation">Translate</option><option value="documents">Summarize and analyze</option></select></label>}
      <label><span className="sr-only">Sort models</span><select aria-label="Sort models" value={sort} onChange={e=>setSort(e.target.value as CatalogSort)}>{Object.entries(sortLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      {<label className="models-picker-search"><span className="sr-only">Search models</span><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search models or publishers…" /></label>}
      {!compact && <><label><input type="checkbox" checked={fitOnly} onChange={e=>setFitOnly(e.target.checked)} /> Estimated to fit</label></>}
    </div></div>
    {!result && !error && <p role="status">Finding models…</p>}
    {(error || result?.catalog.stale) && <p role="status">{result ? result.catalog.failedFeeds ? 'Some catalog sources are unavailable. Showing new results and last-known models.' : 'Showing the last catalog. Refresh is unavailable or in progress.' : 'The catalog is unavailable.'} <button className="btn ghost" onClick={()=>setRequest(n=>n+1)}>Retry</button></p>}
    {sort==='community' && <p className="muted">Anonymous reported output volume · Last 30 completed days · Not verified users or quality.</p>}
    {sort==='community' && result?.catalog.communityStatus !== 'available' && result && <p role="status">Anonymous activity ranking is unavailable. External popularity is not substituted.</p>}
    <LocalPreparationPanel modelId={preparing} onClose={()=>setPreparing(null)} onUse={onUse} onChanged={()=>setRequest(n=>n+1)} />
    <div className={expert ? 'models-choice-grid' : 'models-picker-list'}>{models.slice(0,limit).map((row,index)=><article className={`models-choice${!expert && index === 0 && sort === 'recommended' ? ' models-choice-primary' : ''}`} key={row.model.id}>
      {!expert && index === 0 && sort === 'recommended' && <span className="models-best-match">★ Top recommendation</span>}
      {!expert && index === 1 && sort === 'recommended' && <h4 className="models-alternatives-heading">Other good choices</h4>}
      <span className="models-choice-badge">{row.compatibility==='compatible'?'Estimated fit':row.compatibility==='insufficient'?'Not compatible':'Host check needed'}</span>
      <h3>{(publisherIcons as Record<string,string>)[row.model.id.split('/')[0].toLowerCase()] && <img src={(publisherIcons as Record<string,string>)[row.model.id.split('/')[0].toLowerCase()]} alt="" width="28" height="28" loading="lazy" referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true;}} style={{objectFit:'contain',verticalAlign:'middle',marginRight:8}} />}{row.model.id.split('/').pop()?.replace(/[-_]/g, ' ')}</h3><p>{row.reason}</p>
      <details className="models-card-details" open={!compact || expert}><summary>Model details</summary><details className="models-comparison-details" open={!compact || expert}><summary>Compare cost, data and requirements</summary><dl><div><dt>Cost</dt><dd>{readyFor(row.model.id)?.cost.label ?? 'Hardware and electricity'}</dd></div><div><dt>Data</dt><dd>{readyFor(row.model.id)?.data ?? 'On Host if run locally'}</dd></div><div><dt>Speed</dt><dd>Not measured</dd></div><div><dt>Dependency</dt><dd>{readyFor(row.model.id)?.dependency ?? 'Host required · Network for download'}</dd></div></dl></details>
      <a className="models-publisher-link" href={row.model.url} target="_blank" rel="noreferrer">{row.access==='restricted'?'Review access requirements':'View model details'} ↗</a>
      <details><summary>Why this model?</summary><p>{row.model.downloads===null?'Downloads unknown':`${row.model.downloads.toLocaleString('en-US')} downloads · Source reporting window`}. Popularity is not quality or a user count.</p>
        {row.model.communityUsage && <p>Anonymous activity rank #{row.model.communityUsage.rank} · {row.model.communityUsage.periodStart.slice(0,10)} to {row.model.communityUsage.periodEnd.slice(0,10)} (end exclusive). Based on reported output tokens, not people. Minimum 20 contributions across 7 days; these are not distinct users.</p>}
        <p>License: {row.model.license}. Publisher metadata, not an independent license audit. {row.model.gated?'Access approval is required.':''}</p>
        <p>{row.model.createdAt?`Repository created ${new Date(row.model.createdAt).toLocaleDateString('en-GB')}`:'Creation date unknown'} · Not a verified release date.</p>
        <p>{row.model.metadataCheckedAt ? `Metadata checked ${new Date(row.model.metadataCheckedAt).toLocaleString('en-GB')}.` : 'List metadata only.'}</p>
        <p>{row.variants.map(v=>v.reason).filter((reason,index,all)=>all.indexOf(reason)===index).join(' ')}</p><p>No installation or chat route is granted by discovery. A runtime estimate is not a successful test. On mobile, models run on Host, not your phone.</p>
        {expert && row.variants.map(v=><p key={v.model.id}>{v.model.id} · {v.model.formats.join(', ') || 'Format unknown'} · {v.reason}</p>)}
      </details>
      </details>
      {onUse && readyFor(row.model.id) && <button className="btn primary" onClick={()=>onUse(readyFor(row.model.id)!.model.id)}>Use model <span aria-hidden="true">→</span></button>}
      {result?.host?.supported && row.access!=='restricted' && !readyFor(row.model.id) && <button className="btn ghost" onClick={()=>setPreparing(row.model.id)}>Select model <span aria-hidden="true">→</span></button>}
    </article>)}</div>
    {result && !models.length && <p>No models have sufficient task metadata for these filters. Try another task or sort.</p>}
    {models.length>limit && <button className="btn ghost" onClick={()=>setLimit(n=>n+(compact ? 6 : 12))}>View more models ({models.length - limit} remaining) <span aria-hidden="true">→</span></button>}
    <details><summary>Where does this list come from?</summary><p>MultiVibe Cloud supplies anonymous activity ranks; Hugging Face supplies trending, downloaded and new repositories, refreshed every six hours while MultiVibe runs. Explicit quantizations are grouped; fine-tunes remain separate. Missing metadata stays unknown.</p><p>Established means at least 90 days old and in the top quarter by downloads among task-matched models with known counts. It is not a certification. New means repository creation, not release date.</p><p>Publisher icons are served locally; opening a model card contacts Hugging Face. No chat content or hardware profile is sent by catalog discovery. No automatic model downloads.</p></details>
    {result && <p className="muted">Checked {new Date(result.catalog.checkedAt).toLocaleString('en-GB')} · Hugging Face</p>}
  </section>;
}
