import { ModelDetailPanel } from './ModelDetailPanel';
import { ModelBenchmarkChart } from './ModelBenchmarkChart';
import type { MemoryAvailability } from '../../../../src/model-recommendation-evidence';
import { LocalPreparationPanel } from './LocalPreparationPanel';
import publisherIcons from './publisher-icons.json';
import { useEffect, useState } from 'react';
import { relevantChoices, type GuidanceEntry } from '../../../../src/model-guidance';
import { api } from '../../lib/api';
import type { OpenModelCatalog, CatalogNeed, CatalogSort, rankOpenModels } from '../../../../src/open-model-ranking';
type Result = {memoryProgress?:{pending:number;total:number;persistenceError:boolean};catalog: OpenModelCatalog; host: {name:string; supported:boolean} | null; memory?: MemoryAvailability; benchmarks?: {selected?: string; options: {id:string;label:string;count:number}[]; coverage:{cachedModels:number;totalModels:number;warming:boolean}}; recommendations: ReturnType<typeof rankOpenModels>};
const sortLabels: Record<CatalogSort,string> = {recommended:'Recommended',benchmark:'Best benchmark that fits',trending:'Trending',downloads:'Top downloaded',newest:'New',established:'Established',community:'Most used on MultiVibe'};
function saved(key:string, fallback:string) { try {return localStorage.getItem(key) ?? fallback;} catch {return fallback;} }
export function OpenModelDiscovery({ compact, need: selectedNeed, expert = false, connected = [], onUse }: { compact: boolean; need?: CatalogNeed; expert?: boolean; connected?: GuidanceEntry[]; onUse?: (id:string)=>void }) {
  const [need,setNeed] = useState<CatalogNeed>(()=>{const v=saved('multivibe.models.need.v1','writing');return ['writing','coding','translation','documents'].includes(v)?v as CatalogNeed:'writing';});
  const effectiveNeed = selectedNeed ?? need;
  const [sort,setSort] = useState<CatalogSort>(()=>{const v=saved('multivibe.models.sort.v1','recommended');return Object.prototype.hasOwnProperty.call(sortLabels,v)?v as CatalogSort:'recommended';});
  const [result,setResult] = useState<Result>(); const [error,setError] = useState(false);
  const [request,setRequest] = useState(0); const [query,setQuery] = useState(''); const [limit,setLimit] = useState(compact ? 6 : 12);
  const [preparing,setPreparing] = useState<string|null>(null);
  const [showChart,setShowChart] = useState(false);
  const [benchmarkChoice,setBenchmarkChoice] = useState<{need: CatalogNeed; id: string}>();
  const benchmark = benchmarkChoice?.need === effectiveNeed ? benchmarkChoice.id : '';
  useEffect(()=>{setBenchmarkChoice(undefined);},[effectiveNeed]);
  const [memoryBudget,setMemoryBudget] = useState('');
  const validMemoryBudget = memoryBudget === '' || (Number.isFinite(Number(memoryBudget)) && Number(memoryBudget) > 0 && Number(memoryBudget) <= 4096);
  const [selectedModel,setSelectedModel] = useState<string>();
  const [showUnresolved,setShowUnresolved] = useState(false);
  const [fitOnly,setFitOnly] = useState(false);
  const [showAllFits,setShowAllFits] = useState(false);
  useEffect(()=>{try {localStorage.setItem('multivibe.models.sort.v1',sort);localStorage.setItem('multivibe.models.need.v1',effectiveNeed);} catch {/* Optional browser storage. */}},[sort,effectiveNeed]);
  useEffect(()=>{
    const controller=new AbortController(); setResult(undefined);setError(false);setLimit(compact ? 6 : 12);
    let memoryPending=true;let lastLoad=0;
    const load=()=>{lastLoad=Date.now();void api(`/admin/model-recommendations?need=${effectiveNeed}&sort=${sort}&host=local${benchmark ? `&benchmark=${encodeURIComponent(benchmark)}` : ''}${validMemoryBudget && Number(memoryBudget)>0 ? `&memory_gib=${encodeURIComponent(memoryBudget)}` : ''}`,{signal:controller.signal}).then((value:Result)=>{if(!controller.signal.aborted){setResult(value);memoryPending=Boolean(value.memoryProgress?.pending);setError(false);}}).catch(()=>{if(!controller.signal.aborted)setError(true);});};
    load();const timer=setInterval(()=>{if(memoryPending||Date.now()-lastLoad>=60000)load();},5000);return()=>{controller.abort();clearInterval(timer);};
  },[effectiveNeed,sort,request,compact,benchmark,memoryBudget]);
  const readyChoices = relevantChoices(connected, effectiveNeed, result?.catalog.models ?? []);
  const readyFor = (id:string) => readyChoices.find(choice=>choice.route.modelId===id);
  const models=(result?.recommendations ?? []).filter(row=>(showUnresolved || row.familyStatus !== 'unresolved') && [row.model.id,...row.variants.map(v=>v.model.id)].some(id=>id.toLowerCase().includes(query.trim().toLowerCase())) && (!(fitOnly || (!showAllFits && ['recommended','benchmark'].includes(sort) && result?.memory?.budgetMiB!==undefined)) || row.compatibility==='compatible'));
  const activeModel = models.find(row=>row.model.id===selectedModel) ?? models[0];
  return <section className={`models-open-discovery models-picker${compact ? ' is-beginner' : ''}`} aria-label="Open model discovery">
    <div className="models-picker-toolbar">
    <div className="models-compare-filters">
      {!selectedNeed && <label>Task<select value={need} onChange={e=>setNeed(e.target.value as CatalogNeed)}><option value="writing">Chat and write</option><option value="coding">Code</option><option value="translation">Translate</option><option value="documents">Summarize and analyze</option></select></label>}
      <label><span className="sr-only">Sort models</span><select aria-label="Sort models" value={sort} onChange={e=>setSort(e.target.value as CatalogSort)}>{Object.entries(sortLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      {<label className="models-picker-search"><span className="sr-only">Search models</span><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search models or publishers…" /></label>}
      {!compact && !(result?.memory?.budgetMiB!==undefined && ['recommended','benchmark'].includes(sort)) && <><label><input type="checkbox" checked={fitOnly} onChange={e=>setFitOnly(e.target.checked)} /> Estimated to fit</label></>}
      <button className="btn ghost models-chart-toggle" aria-label="Compare benchmarks and memory" title="Compare benchmarks and memory" aria-expanded={showChart} aria-controls="model-benchmark-chart" onClick={()=>setShowChart(value=>!value)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 3v17h17"/><circle cx="9" cy="14" r="1.5"/><circle cx="14" cy="9" r="1.5"/><circle cx="19" cy="5" r="1.5"/></svg><span>Compare</span></button>
    </div></div>
    {(sort === 'benchmark' || showChart) && <div className="models-benchmark-controls"><label>Benchmark<select value={benchmark || result?.benchmarks?.selected || ''} onChange={event=>setBenchmarkChoice({need: effectiveNeed, id: event.target.value})}>{!result?.benchmarks?.options?.length && <option value="">Collecting benchmarks…</option>}{result?.benchmarks?.options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label>Memory limit (GiB)<input type="number" min="0.25" max="4096" step="0.25" placeholder="Automatic" value={memoryBudget} onChange={event=>setMemoryBudget(event.target.value)} /></label></div>}
    {result?.memory?.totalHostMiB && <div className="model-browser-memory"><span>{Math.round(result.memory.totalHostMiB/1024)} GiB RAM · {((result.memory.budgetMiB ?? 0)/1024).toFixed(0)} GiB model budget</span>{['recommended','benchmark'].includes(sort) && <label><input type="checkbox" checked={showAllFits} onChange={event=>setShowAllFits(event.target.checked)}/> Show models with unknown or insufficient memory</label>}</div>}
    {!validMemoryBudget && <p className="models-error" role="alert">Enter a memory limit greater than 0 and at most 4,096 GiB. Using Host availability until the value is valid.</p>}
    {showChart && <ModelBenchmarkChart rows={models} label={result?.benchmarks?.options.find(option=>option.id===result.benchmarks?.selected)?.label ?? 'Benchmark score'} memory={result?.memory} onSelect={id=>{setSelectedModel(id);setLimit(Math.max(limit,models.findIndex(row=>row.model.id===id)+1));setShowChart(false);}} />}

    {result?.memoryProgress?.pending && !models.length ? <p role="status">Estimating model memory… Results appear as estimates become available.</p> : null}
    {result?.memoryProgress?.persistenceError && <p role="status">Memory estimates cannot be saved locally. Check available disk space and access.</p>}
    {!result && !error && <p role="status">Finding models…</p>}
    {(error || result?.catalog.stale) && <p role="status">{result ? result.catalog.failedFeeds ? 'Some catalog sources are unavailable. Showing new results and last-known models.' : 'Showing the last catalog. Refresh is unavailable or in progress.' : 'The catalog is unavailable.'} <button className="btn ghost" onClick={()=>setRequest(n=>n+1)}>Retry</button></p>}
    {sort==='community' && <p className="muted">Anonymous reported output volume · Last 30 completed days · Not verified users or quality.</p>}
    {sort==='community' && result?.catalog.communityStatus !== 'available' && result && <p role="status">Anonymous activity ranking is unavailable. External popularity is not substituted.</p>}
    {result?.recommendations.some(row=>row.familyStatus==='unresolved') && <details className="model-source-options"><summary>More filters</summary><label className="models-ready models-unresolved-toggle"><input type="checkbox" checked={showUnresolved} onChange={e=>setShowUnresolved(e.target.checked)} /> Show conversions with unresolved originals ({result.recommendations.filter(row=>row.familyStatus==='unresolved').length})</label></details>}
    <LocalPreparationPanel modelId={preparing} onClose={()=>setPreparing(null)} onUse={onUse} onChanged={()=>setRequest(n=>n+1)} />
    {activeModel && <div className={`model-browser ${compact ? 'model-browser-cards' : ''}`}>
      <div className="model-browser-results"><div className="model-browser-count">{models.length} models</div><div className={compact ? 'model-browser-card-grid' : 'model-browser-list'} aria-label="Models">
      {models.slice(0,limit).map((row,index)=>{const icon=(publisherIcons as Record<string,string>)[row.model.id.split('/')[0].toLowerCase()];return <button type="button" key={row.model.id} className="model-browser-item" aria-pressed={activeModel.model.id===row.model.id} onClick={()=>setSelectedModel(row.model.id)}>
        <span className="model-browser-icon">{icon?<img src={icon} alt="" width="32" height="32"/>:row.model.id.split('/')[0].slice(0,2).toUpperCase()}</span>
        <span className="model-browser-item-copy"><strong>{row.model.id.split('/').pop()?.replace(/[-_]/g,' ')}</strong><small>{row.model.id.split('/')[0]}{index===0 && row.compatibility==='compatible' && ['recommended','benchmark'].includes(sort)?' · Top pick':''}</small><span className="model-browser-item-metrics">{row.benchmark && <span title={row.benchmark.label}>{row.benchmark.score} score</span>}{row.memory?.requiredMiB != null && <span>{(row.memory.requiredMiB/1024).toFixed(1)} GiB est.</span>}{row.compatibility==='compatible' && <span className="model-fit-positive">Fits</span>}</span></span>
      </button>;})}</div>
      {models.length>limit && <button className="btn ghost model-browser-more" onClick={()=>setLimit(n=>n+24)}>Show more models</button>}</div>
      <ModelDetailPanel key={activeModel.model.id} row={activeModel} memory={result?.memory} supported={Boolean(result?.host?.supported)} ready={readyFor(activeModel.model.id)} onUse={onUse} onPrepare={setPreparing}/>
    </div>}
    {result && !models.length && <p>No models with a confirmed memory estimate fit these filters yet. Try another task or show models without a confirmed fit.</p>}

    <details className="model-detail-notes"><summary>Sources</summary><p>Recommendations combine <a href="https://lmstudio.ai/models" target="_blank" rel="noreferrer">LM Studio’s public catalog</a>, confirmed <a href="https://ollama.com/library" target="_blank" rel="noreferrer">Ollama library</a> links, and Hugging Face collections from Qwen, Meta, Google, Mistral, MLX Community, Unsloth and bartowski.</p><p>Catalog inclusion is a discovery signal, not an endorsement of MultiVibe or proof of recent usage. Publisher and quantization collections supply models and variants, not independent quality votes. Public catalogs, Hugging Face metadata and collections refresh every six hours. LM Studio/Ollama fall back to mappings verified on 15 September 2026 when unavailable; they do not reproduce private recommendation algorithms. Missing sources do not block discovery.</p><p>Task suitability, memory estimates and benchmarks still influence recommendations. “Best benchmark that fits” keeps benchmark ordering. Download counts are not unique users; model memory and quality may vary by quantization.</p></details>

  </section>;
}
