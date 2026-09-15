import {exceedsWeightBudget} from '../../../../src/model-memory-budget';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { modelArtifacts } from '../../../../src/model-variants';
import { runtimeMemory, type MemoryAvailability } from '../../../../src/model-recommendation-evidence';
import type { OpenModel, RuntimeEstimate, rankOpenModels } from '../../../../src/open-model-ranking';
type Row = ReturnType<typeof rankOpenModels>[number];
export function ModelVariantsTable({row, memory, supported, onPrepare}: {row:Row;memory?:MemoryAvailability;supported:boolean;onPrepare:(id:string)=>void}) {
  const [query,setQuery]=useState('');const [limit,setLimit]=useState(25);
  const [open]=useState(true);const [selection,setSelection]=useState('');const [models,setModels]=useState<OpenModel[]>(row.variants.map(v=>v.model));const [estimates,setEstimates]=useState<RuntimeEstimate[]>();const [loading,setLoading]=useState(false);const [error,setError]=useState('');const [request,setRequest]=useState(0);
  useEffect(()=>{if(!open)return; const controller=new AbortController();setLoading(true);setError('');
    void Promise.allSettled([api(`/admin/open-model-family?model=${encodeURIComponent(row.model.id)}`,{signal:controller.signal}),supported ? api('/admin/provider-agent/model-compatibility',{method:'POST',body:JSON.stringify({context_tokens:8192}),signal:controller.signal}) : Promise.resolve(null)]).then(([family,report])=>{
      if(controller.signal.aborted)return;
      if(family.status==='fulfilled') setModels(family.value.models);else setError('Could not load additional variants. Showing known catalog entries.');
      if(report.status==='fulfilled' && report.value?.schema_version==='provider-model-compatibility-v1' && report.value.context_tokens===8192) setEstimates(report.value.models);
      setLoading(false);
    });return()=>controller.abort();
  },[open,row.model.id,supported,request]);
  const sorted=[...models].sort((a,b)=>Number(b.id===row.model.id)-Number(a.id===row.model.id) || (b.downloads ?? -1)-(a.downloads ?? -1));
  const entries=sorted.flatMap(model=>modelArtifacts(model).map(artifact=>({model,artifact}))).filter(({model,artifact})=>`${model.id} ${artifact.name} ${artifact.quantization}`.toLowerCase().includes(query.trim().toLowerCase()));
  const options=sorted.flatMap(model=>modelArtifacts(model).map(artifact=>({model,artifact})));
  const choice=options.find(({model,artifact})=>`${model.id}:${artifact.name}`===selection) ?? options.find(({model,artifact})=>model.id===row.memory?.variant && artifact.name===row.memory?.artifact) ?? options.find(({artifact})=>artifact.quantization==='Q4_K_M') ?? options[0];
  const common = ['Q4_K_M','Q5_K_M','Q6_K','Q8_0','4BIT','5BIT','6BIT','8BIT','FP16','BF16','F16'];
  const shortlist=[...new Map([...options].filter(o=>common.includes(o.artifact.quantization)).sort((a,b)=>Number(a.artifact.bytes===null)-Number(b.artifact.bytes===null)).map(o=>[`${o.artifact.format}:${o.artifact.quantization}`,o] as const).reverse()).values()].reverse().slice(0,16);
  const selectorOptions=choice ? [choice,...shortlist.filter(o=>o.model.id!==choice.model.id || o.artifact.name!==choice.artifact.name)] : shortlist;
  const prediction=choice && row.variants.find(v=>v.model.id===choice.model.id && v.memory.artifact===choice.artifact.name)?.memory;
  return <section className="model-download-options"><h4>Download options</h4>
    {choice && <div className="model-variant-choice"><label><span className="sr-only">Model variant</span><select aria-label="Model variant" value={`${choice.model.id}:${choice.artifact.name}`} onChange={event=>setSelection(event.target.value)}>{selectorOptions.map(({model,artifact})=><option key={`${model.id}:${artifact.name}`} value={`${model.id}:${artifact.name}`}>{artifact.format} · {artifact.quantization} · {artifact.bytes===null?'Size unknown':`${(artifact.bytes/1073741824).toFixed(2)} GiB`} · {model.id.split('/')[0]}</option>)}</select></label>
      <div className="model-variant-summary"><span>{choice.artifact.format}</span><span>{choice.artifact.quantization}</span><span>{choice.artifact.bytes===null?'Download size unknown':`${(choice.artifact.bytes/1073741824).toFixed(2)} GiB download`}</span>{prediction && <span>{(prediction.requiredMiB!/1024).toFixed(1)} GiB memory est.</span>}</div>
      <p className="model-variant-publisher">By {choice.model.id.split('/')[0]}{choice.model.downloads!==null?` · ${new Intl.NumberFormat('en',{notation:'compact'}).format(choice.model.downloads)} repository downloads`:''}</p>
      <div className="model-variant-footer"><span className={prediction?.state==='compatible'?'model-fit-positive':'muted'}>{prediction?.state==='compatible'?'Estimated to fit':prediction?.state==='insufficient'||exceedsWeightBudget(choice.artifact.bytes,memory)?'Exceeds memory limit':'Memory fit unknown'}</span><a className="btn ghost" href={choice.model.url} target="_blank" rel="noreferrer">View files ↗</a>{supported && !row.model.gated && <button className="btn primary" onClick={()=>onPrepare(row.model.id)}>Check Host setup</button>}</div>
      {supported && <small className="muted">Host setup checks which variant it can install.</small>}
    </div>}
    {loading && <p role="status">Loading variant metadata…</p>}{error && <p role="alert">{error} <button className="models-text-button" onClick={()=>setRequest(n=>n+1)}>Retry</button></p>}
    <details className="model-variant-all"><summary>All variants & publishers ({entries.length})</summary><label className="models-provider">Find a variant<input type="search" placeholder="Publisher, quantization or file…" value={query} onChange={e=>{setQuery(e.target.value);setLimit(25);}} /></label><p>{entries.length} weight variants · Showing {Math.min(limit,entries.length)}</p>
    <div className="models-variants-scroll"><table><thead><tr><th>Variant / publisher</th><th>Quantization</th><th>Weight size</th><th>Memory fit</th><th>Downloads</th><th>Action</th></tr></thead><tbody>{entries.slice(0,limit).map(({model,artifact})=>{
      const artifacts=modelArtifacts(model);
        const matches=estimates?.filter(e=>[e.model_id,...e.aliases].includes(model.id));
        const estimate=matches?.length===1 ? matches[0] : undefined;
        const exact = artifacts.length===1 || estimate && artifact.files.some(file=>file===estimate.variant || file.split('/').pop()===estimate.variant);
        const initial=row.variants.find(v=>v.model.id===model.id);
        const fit=exact && estimate ? runtimeMemory(estimate,memory) : initial?.memory.source === 'metadata' ? initial.memory.artifact === artifact.name ? initial.memory : undefined : artifacts.length===1 ? initial?.memory : undefined;
        return <tr key={`${model.id}:${artifact.name}`}><td><strong>{model.id}</strong><small>{model.id.split('/')[0]} · {artifact.format}{model.id===row.model.id?' · Original repository':''}</small>{artifact.name!==model.id && <small>{artifact.name}</small>}</td><td>{artifact.quantization}</td><td>{artifact.bytes===null?'Unknown':`${(artifact.bytes/1073741824).toFixed(2)} GiB`}</td><td>{fit?.state==='compatible'?'Estimated fit':fit?.state==='insufficient'||exceedsWeightBudget(artifact.bytes,memory)?'Exceeds memory':'Check needed'}{fit?.requiredMiB!=null && <small>{(fit.requiredMiB/1024).toFixed(2)} GiB estimated</small>}</td><td>{model.downloads===null?'Unknown':model.downloads.toLocaleString('en-US')}<small>Repository total</small></td><td>{supported && !model.gated && <button className="btn ghost" onClick={()=>onPrepare(row.model.id)}>Check Host setup</button>}<a href={model.url} target="_blank" rel="noreferrer">View repository ↗</a></td></tr>;
    })}</tbody></table></div>
    {entries.length>limit && <button className="btn ghost" onClick={()=>setLimit(n=>n+25)}>Show more variants</button>}
    <p>Weight size is download size, not RAM required. Runtime estimates use 8,192 context tokens; missing or ambiguous estimates stay unknown. Download counts are per repository, not per file or unique person. Up to 100 repositories per conversion type are discovered; file metadata is enriched for up to 20 repositories per refresh. Split GGUF files are combined only when all shards are known.</p></details>
  </section>;
}
