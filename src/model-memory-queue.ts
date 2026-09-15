import {isModelWeightArtifact} from './model-variants.js';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createDiscoveryMemory,type MemoryEstimateReport,type DiscoveryMemory} from './model-discovery-memory.js';
import type {OpenModel} from './open-model-ranking.js';
type Job={model:OpenModel;original:OpenModel;key:string;priority:number;order:number;state:'queued'|'running'|'done';attempts:number;nextAt:number;report?:MemoryEstimateReport};
export type MemoryQueue = ReturnType<typeof createMemoryEstimationQueue>;
const MAX_JOBS=10000;
const descriptor=(model:OpenModel):OpenModel=>({...model,files:[],communityUsage:undefined,recommendationSources:undefined});
const identity=(model:OpenModel,original:OpenModel)=>`v2:8192:${model.id}@${model.revision}:${original.id}@${original.revision}`;
const validModel=(m:any)=>m && typeof m.id==='string' && /^[\w.-]+\/[\w.-]+$/.test(m.id) && (m.revision==null||/^[a-f0-9]{40}$/.test(m.revision));
export function createMemoryEstimationQueue(options:{path:string;resolve?:ReturnType<typeof createDiscoveryMemory>['inspect'];now?:()=>number;concurrency?:number}) {
 const now=options.now??Date.now;const resolve=options.resolve??createDiscoveryMemory().inspect;
 const jobs=new Map<string,Job>();let order=0;let active=0;let dispatch=0;let stopped=false;let pauseUntil=0;let timer:ReturnType<typeof setTimeout>|undefined;
 let saveChain=Promise.resolve();let persistenceError=false;let writes=0;
 const storedJobs=new Map<string,string>();const deleted=new Set<string>();
 const save=(updated:Job[]=[])=>{
  const record=JSON.stringify({version:2,updates:updated,deleted:[...deleted]});deleted.clear();
  saveChain=saveChain.catch(()=>{}).then(async()=>{
   await fs.mkdir(path.dirname(options.path),{recursive:true});
   await fs.appendFile(`${options.path}.journal`,'\n'+record+'\n',{mode:0o600});
   const parsed=JSON.parse(record);for(const id of parsed.deleted)storedJobs.delete(id);for(const j of parsed.updates)storedJobs.set(j.model.id,JSON.stringify(j));
   if(++writes>=200||stopped){
    const tmp=`${options.path}.${process.pid}.tmp`;
    await fs.writeFile(tmp,`{"version":2,"jobs":[${[...storedJobs.values()].join(',')}]}`,{mode:0o600});
    await fs.rename(tmp,options.path);await fs.writeFile(`${options.path}.journal`,'',{mode:0o600});writes=0;
   }
   persistenceError=false;
  }).catch(()=>{persistenceError=true;});
  return saveChain;
 };
 const ready=(async()=>{
  const recovered=new Map<string,Job>();
  try{if((await fs.stat(options.path)).size<=64*1024**2){const snapshot=JSON.parse(await fs.readFile(options.path,'utf8'));if(snapshot.version===2&&Array.isArray(snapshot.jobs))for(const j of snapshot.jobs.slice(0,MAX_JOBS))if(j?.model?.id)recovered.set(j.model.id,j);}}catch{/* Missing or corrupt snapshot can be recovered from the journal. */}
  try{if((await fs.stat(`${options.path}.journal`)).size<=64*1024**2)for(const line of (await fs.readFile(`${options.path}.journal`,'utf8')).split('\n')){
    if(!line)continue;try{const event=JSON.parse(line);if(event.version!==2||!Array.isArray(event.updates))continue;for(const id of event.deleted??[])recovered.delete(id);for(const j of event.updates)if(j?.model?.id)recovered.set(j.model.id,j);}catch{/* An interrupted final journal record is ignored. */}
  }}catch{/* First run. */}
  for(const j of [...recovered.values()].slice(0,MAX_JOBS)){
   if(!validModel(j.model)||!validModel(j.original)||j.key!==identity(j.model,j.original)||!Number.isFinite(j.nextAt)||!Number.isSafeInteger(j.order)||!Number.isSafeInteger(j.attempts))continue;
   if(j.report && (!Array.isArray(j.report.estimates)||j.report.estimates.some((e:any)=>e.variant!==j.model.id||e.estimator!=='catalog-memory-v2'||e.contextTokens!==8192||!Number.isFinite(e.requiredMiB)||e.requiredMiB<=0)))continue;
   if(j.report){j.report.estimates=j.report.estimates.filter(e=>isModelWeightArtifact(e.artifact)&&isModelWeightArtifact(e.variant));if(j.report.reason==='ready'&&!j.report.estimates.length)j.report.reason='incomplete_weights';}
   if(j.model.id!==j.original.id&&j.report?.estimates.length&&!j.report.lineageVerified){j.report=undefined;j.state='queued';j.nextAt=0;j.attempts=0;}
   if(j.report?.httpStatus===429 && j.nextAt>now())pauseUntil=Math.max(pauseUntil,j.nextAt);
   j.state=j.state==='done'?'done':'queued';jobs.set(j.model.id,j);storedJobs.set(j.model.id,JSON.stringify(j));order=Math.max(order,j.order+1);
  }
 })();
 function kick(){
  if(stopped)return;if(timer){clearTimeout(timer);timer=undefined;}
  if(pauseUntil>now()){timer=setTimeout(kick,pauseUntil-now());timer.unref?.();return;}
  while(active<Math.max(1,Math.min(options.concurrency??3,8))){
   const available=[...jobs.values()].filter(j=>j.state==='queued'&&j.nextAt<=now());
   if(!available.length)break;
   // Every fifth dispatch is FIFO so sustained foreground requests cannot starve coverage.
   const fair=++dispatch%5===0;available.sort((a,b)=>fair?a.order-b.order:b.priority-a.priority||a.order-b.order);
   const job=available[0];job.state='running';active++;
   void (async()=>{
    await save([job]);
    let report:MemoryEstimateReport;
    try{report=await resolve(job.model,job.original,8192);}catch{report={reason:'temporary_failure',estimates:[],checkedAt:new Date(now()).toISOString()};}
    if(jobs.get(job.model.id)===job){
     job.report=report;job.attempts++;
     const retry=report.reason==='temporary_failure'&&job.attempts<4;
     job.state=retry?'queued':'done';job.priority=0;
     job.nextAt=now()+(retry?Math.max(report.retryAfterMs??0,[60000,300000,1800000][job.attempts-1]):report.reason==='ready'?6*3600000:24*3600000);
     if(report.httpStatus===429 || report.httpStatus===503)pauseUntil=Math.max(pauseUntil,now()+(report.retryAfterMs??60000));
     await save([job]);
    }
   })().finally(()=>{active--;kick();});
  }
  const pending=[...jobs.values()].filter(j=>j.state==='queued');
  if(pending.length&&active===0){const delay=Math.max(1,Math.min(...pending.map(j=>j.nextAt))-now());timer=setTimeout(kick,Math.min(delay,2147483647));timer.unref?.();}
 }
 async function enqueue(items:{model:OpenModel;original:OpenModel;priority?:number}[]){
  await ready;const updated=new Set<Job>();
  for(const item of items){
   if(!validModel(item.model)||!validModel(item.original))continue;
   const key=identity(item.model,item.original);const previous=jobs.get(item.model.id);
   if(previous?.key===key){
    if(previous.state==='done'&&previous.nextAt<=now()){previous.state='queued';previous.report=undefined;previous.order=order++;previous.attempts=0;updated.add(previous);}
    if(previous.state==='queued'&&(item.priority??0)>previous.priority){previous.priority=item.priority??0;updated.add(previous);}
    continue;
   }
   if(jobs.size>=MAX_JOBS&&!previous){const oldest=[...jobs.values()].filter(j=>j.state==='done').sort((a,b)=>a.order-b.order)[0];if(!oldest)continue;jobs.delete(oldest.model.id);deleted.add(oldest.model.id);}
   const job:Job={model:descriptor(item.model),original:descriptor(item.original),key,priority:item.priority??0,order:order++,state:'queued',attempts:0,nextAt:0};jobs.set(item.model.id,job);updated.add(job);
  }
  if(updated.size)await save([...updated]);kick();
 }
 async function snapshot(ids?:string[]){
  await ready;const selected=ids?ids.flatMap(id=>jobs.has(id)?[jobs.get(id)!]:[]):[...jobs.values()];
  const reports:Record<string,MemoryEstimateReport>={};const discoveryMemory=new Map<string,DiscoveryMemory>();const artifactMemory=new Map<string,DiscoveryMemory[]>();
  for(const job of selected){
   const fresh=job.report && (job.state!=='done'||job.nextAt>now());
   const report=fresh?job.report!:{reason:job.state==='running'?'estimating' as const:'queued' as const,estimates:[],checkedAt:new Date(now()).toISOString()};
   reports[job.model.id]=report;
   if(report.estimates.length){discoveryMemory.set(job.model.id,report.estimates[0]);artifactMemory.set(job.model.id,report.estimates);}
  }
  return {reports,discoveryMemory,artifactMemory,pending:selected.filter(j=>j.state!=='done').length,total:selected.length,persistenceError,pausedUntil:pauseUntil>now()?new Date(pauseUntil).toISOString():undefined};
 }
 async function close(){stopped=true;if(timer)clearTimeout(timer);await ready;while(active)await new Promise(r=>setTimeout(r,10));await save();}
 void ready.then(kick);
 return {enqueue,snapshot,close};
}
