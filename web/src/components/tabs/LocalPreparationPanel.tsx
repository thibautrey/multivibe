import {useEffect, useRef, useState} from 'react';
import type {PreparationJob} from '../../../../src/local-model-preparation';
import {api} from '../../lib/api';
import {preparationActive, preparationBytes, preparationChatReady, preparationError, preparationLabels} from '../../lib/localPreparation';

/** One panel per catalog, not one poller per model. Only a model ID or exact
 * server-issued consent digest crosses the browser boundary. */
export function LocalPreparationPanel({modelId,onClose,onUse,onChanged}: {
  modelId: string | null; onClose:()=>void; onUse?: (id:string)=>void; onChanged:()=>void;
}) {
  const [jobs,setJobs]=useState<PreparationJob[]>([]);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const locked=useRef(false); const mounted=useRef(true);
  const heading=useRef<HTMLHeadingElement>(null);
  const seenReady=useRef(new Set<string>());
  const changed=useRef(onChanged); changed.current=onChanged;
  useEffect(()=>{
    mounted.current=true;
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try {
        const result=await api('/admin/local-model-preparation',{signal:controller.signal}) as {jobs:PreparationJob[]};
        if(controller.signal.aborted) return;
        setJobs(result.jobs);
        for(const job of result.jobs) if(preparationChatReady(job) && !seenReady.current.has(job.id)) {
          seenReady.current.add(job.id);changed.current();
        }
      } catch { /* Failed polls never advance a job to ready. Actions show explicit errors. */ }
      if(!controller.signal.aborted) timer=setTimeout(load,2000);
    };
    void load();return()=>{mounted.current=false;controller.abort();clearTimeout(timer);};
  },[]);
  useEffect(()=>{setError('');if(modelId) heading.current?.focus();},[modelId]);
  async function action(path:string,body:object) {
    if(locked.current) return;
    locked.current=true;setBusy(true);setError('');
    try {
      await api(`/admin/local-model-preparation${path}`,{method:'POST',body:JSON.stringify(body)});
      const result=await api('/admin/local-model-preparation') as {jobs:PreparationJob[]};
      if(mounted.current) setJobs(result.jobs);
    } catch(error) {if(mounted.current)setError(preparationError(error));}
    finally {locked.current=false;if(mounted.current)setBusy(false);}
  }
  const displayed=jobs.filter(job=>modelId ? job.quote.modelId===modelId : preparationActive(job.stage) || job.stage==='awaiting-consent' || job.stage==='ready' || job.stage==='interrupted').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  // Show latest attempt for a selected model, retaining old jobs in the API history.
  const visible=modelId?displayed.slice(0,1):displayed;
  if(!modelId && !visible.length) return null;
  return <section className="models-local-preparation" aria-label="Local preparation">
    <h3 ref={heading} tabIndex={-1}>Prepare on Host</h3>
    {modelId && <><p>{modelId}</p><button className="btn ghost" onClick={onClose}>Close</button></>}
    {error && <p role="alert">{error}</p>}
    {modelId && !visible.length && <><p>Check Host and get a download plan first. Nothing is installed before your approval.</p><button className="btn primary" disabled={busy} onClick={()=>void action('/quote',{modelId})}>{busy?'Checking…':'Check preparation'}</button></>}
    {visible.map(job=><article key={job.id}>
      <h4>{job.quote.modelId}</h4><p>Target: {job.quote.hostName}</p>
      <p role="status">{preparationLabels[job.stage]}</p>
      {job.stage==='awaiting-consent' && <>
        <dl><dt>Model version</dt><dd>{job.quote.variant}</dd><dt>Runtime</dt><dd>{job.quote.runtime} {job.quote.runtimeVersion}</dd><dt>Download</dt><dd>{preparationBytes(job.quote.downloadBytes)}</dd><dt>Required disk space</dt><dd>{preparationBytes(job.quote.requiredDiskBytes)}</dd></dl>
        <p>Approval installs the listed runtime and model on {job.quote.hostName}, then tests a synthetic prompt locally. Your conversations are not used. Existing installations stay unchanged.</p>
        <button className="btn primary" disabled={busy} onClick={()=>void action(`/${encodeURIComponent(job.id)}/consent`,{consentDigest:job.consentDigest})}>Approve and prepare</button>
      </>}
      {job.stage==='downloading' && (job.progress && job.progress.totalBytes>0 ? <><progress aria-label="Model download" max={job.progress.totalBytes} value={job.progress.completedBytes}/><p>{preparationBytes(job.progress.completedBytes)} of {preparationBytes(job.progress.totalBytes)}</p></> : <progress aria-label="Waiting for download progress"/>)}
      {job.stage==='testing' && <p>Waiting for a successful local response.</p>}
      {job.stage==='verifying-chat' && <p>Checking the route used by chat. Download completion alone is not readiness.</p>}
      {(preparationActive(job.stage)||job.stage==='awaiting-consent') && <button className="btn ghost" disabled={busy} onClick={()=>void action(`/${encodeURIComponent(job.id)}/cancel`,{})}>Cancel preparation</button>}
      {job.error && <p>{preparationError(job.error)}</p>}
      {['cancelled','interrupted','failed'].includes(job.stage) && <><p>A new plan requires new approval. Resuming a partial download is not guaranteed.</p><button className="btn ghost" disabled={busy} onClick={()=>void action('/quote',{modelId:job.quote.modelId})}>Check again</button></>}
      {preparationChatReady(job) && onUse && <button className="btn primary" onClick={()=>onUse(job.chatModelId!)}>Chat</button>}
    </article>)}
    <p className="muted">On a phone, the model still runs on the named Host—not on your phone.</p>
  </section>;
}
