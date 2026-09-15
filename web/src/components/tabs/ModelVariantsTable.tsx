import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { modelArtifacts } from '../../../../src/model-variants';
import { runtimeMemory, type MemoryAvailability } from '../../../../src/model-recommendation-evidence';
import type { OpenModel, RuntimeEstimate, rankOpenModels } from '../../../../src/open-model-ranking';
type Row = ReturnType<typeof rankOpenModels>[number];
export function ModelVariantsTable({row, memory, supported, onPrepare}: {row:Row;memory?:MemoryAvailability;supported:boolean;onPrepare:(id:string)=>void}) {
  const [query,setQuery]=useState('');const [limit,setLimit]=useState(25);
  const [open,setOpen]=useState(false);const [models,setModels]=useState<OpenModel[]>(row.variants.map(v=>v.model));const [estimates,setEstimates]=useState<RuntimeEstimate[]>();const [loading,setLoading]=useState(false);const [error,setError]=useState('');const [request,setRequest]=useState(0);
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
  return <details className="models-variants" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>Quantizations and variants ({models.length} repositories)</summary>
    {open && <><p>Original: <strong>{row.model.id}</strong>. Conversions follow declared Hugging Face ancestry; explicitly declared fine-tunes remain separate models. Publisher metadata can be incomplete or incorrect.</p>
    {loading && <p role="status">Loading variant metadata…</p>}{error && <p role="alert">{error} <button className="models-text-button" onClick={()=>setRequest(n=>n+1)}>Retry</button></p>}
    <label className="models-provider">Find a variant<input type="search" placeholder="Publisher, quantization or file…" value={query} onChange={e=>{setQuery(e.target.value);setLimit(25);}} /></label><p>{entries.length} weight variants · Showing {Math.min(limit,entries.length)}</p>
    <div className="models-variants-scroll"><table><thead><tr><th>Variant / publisher</th><th>Quantization</th><th>Weight size</th><th>Memory fit</th><th>Downloads</th><th>Action</th></tr></thead><tbody>{entries.slice(0,limit).map(({model,artifact})=>{
      const artifacts=modelArtifacts(model);
        const matches=estimates?.filter(e=>[e.model_id,...e.aliases].includes(model.id));
        const estimate=matches?.length===1 ? matches[0] : undefined;
        const exact = artifacts.length===1 || estimate && artifact.files.some(file=>file===estimate.variant || file.split('/').pop()===estimate.variant);
        const initial=row.variants.find(v=>v.model.id===model.id);
        const fit=exact ? estimate ? runtimeMemory(estimate,memory) : artifacts.length===1 ? initial?.memory : undefined : undefined;
        return <tr key={`${model.id}:${artifact.name}`}><td><strong>{model.id}</strong><small>{model.id.split('/')[0]} · {artifact.format}{model.id===row.model.id?' · Original repository':''}</small>{artifact.name!==model.id && <small>{artifact.name}</small>}</td><td>{artifact.quantization}</td><td>{artifact.bytes===null?'Unknown':`${(artifact.bytes/1073741824).toFixed(2)} GiB`}</td><td>{fit?.state==='compatible'?'Estimated fit':fit?.state==='insufficient'?'Exceeds memory':'Check needed'}{fit?.requiredMiB!=null && <small>{(fit.requiredMiB/1024).toFixed(2)} GiB runtime</small>}</td><td>{model.downloads===null?'Unknown':model.downloads.toLocaleString('en-US')}<small>Repository total</small></td><td>{supported && !model.gated && <button className="btn ghost" onClick={()=>onPrepare(model.id)}>Select variant</button>}<a href={model.url} target="_blank" rel="noreferrer">View repository ↗</a></td></tr>;
    })}</tbody></table></div>
    {entries.length>limit && <button className="btn ghost" onClick={()=>setLimit(n=>n+25)}>Show more variants</button>}
    <p>Weight size is download size, not RAM required. Runtime estimates use 8,192 context tokens; missing or ambiguous estimates stay unknown. Download counts are per repository, not per file or unique person. Up to 100 repositories per conversion type are discovered; file metadata is enriched for up to 20 repositories per refresh. Split GGUF files are combined only when all shards are known.</p></>}
  </details>;
}
