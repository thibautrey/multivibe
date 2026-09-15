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
 const jobs=new Map<string,Job>();let order=0;let active=0;let dispatch=0;let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;
 let saveChain=Promise.resolve();let persistenceError=false;
 const save=()=>{
  const data=JSON.stringify({version:2,jobs:[...jobs.values()]});
  saveChain=saveChain.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(options.path),{recursive:true});const tmp=`${options.path}.${process.pid}.tmp`;await fs.writeFile(tmp,data,{mode:0o600});await fs.rename(tmp,options.path);persistenceError=false;}).catch(()=>{persistenceError=true;});
  return saveChain;
 };
 const ready=(async()=>{
  try{
   if((await fs.stat(options.path)).size>64*1024**2)return;
   const stored=JSON.parse(await fs.readFile(options.path,'utf8'));
   if(stored.version!==2||!Array.isArray(stored.jobs))return;
   for(const j of stored.jobs.slice(0,MAX_JOBS)){
    if(!validModel(j.model)||!validModel(j.original)||j.key!==identity(j.model,j.original)||!Number.isFinite(j.nextAt)||!Number.isSafeInteger(j.order)||!Number.isSafeInteger(j.attempts))continue;
    if(j.report && (!Array.isArray(j.report.estimates)||j.report.estimates.some((e:any)=>e.variant!==j.model.id||e.estimator!=='catalog-memory-v2'||e.contextTokens!==8192||!Number.isFinite(e.requiredMiB)||e.requiredMiB<=0)))continue;
    j.state=j.state==='done'?'done':'queued';jobs.set(j.model.id,j);order=Math.max(order,j.order+1);
   }
  }catch{/* Missing or corrupt cache is safely rebuilt. */}
 })();
 function kick(){
  if(stopped)return;if(timer){clearTimeout(timer);timer=undefined;}
  while(active<Math.max(1,Math.min(options.concurrency??3,8))){
   const available=[...jobs.values()].filter(j=>j.state==='queued'&&j.nextAt<=now());
   if(!available.length)break;
   // Every fifth dispatch is FIFO so sustained foreground requests cannot starve coverage.
   const fair=++dispatch%5===0;available.sort((a,b)=>fair?a.order-b.order:b.priority-a.priority||a.order-b.order);
   const job=available[0];job.state='running';active++;
   void (async()=>{
    await save();
    let report:MemoryEstimateReport;
    try{report=await resolve(job.model,job.original,8192);}catch{report={reason:'temporary_failure',estimates:[],checkedAt:new Date(now()).toISOString()};}
    if(jobs.get(job.model.id)===job){
     job.report=report;job.attempts++;
     const retry=report.reason==='temporary_failure'&&job.attempts<4;
     job.state=retry?'queued':'done';job.priority=0;
     job.nextAt=now()+(retry?[60000,300000,1800000][job.attempts-1]:report.reason==='ready'?6*3600000:24*3600000);
     await save();
    }
   })().finally(()=>{active--;kick();});
  }
  const pending=[...jobs.values()].filter(j=>j.state==='queued');
  if(pending.length&&active===0){const delay=Math.max(1,Math.min(...pending.map(j=>j.nextAt))-now());timer=setTimeout(kick,Math.min(delay,2147483647));timer.unref?.();}
 }
 async function enqueue(items:{model:OpenModel;original:OpenModel;priority?:number}[]){
  await ready;let changed=false;
  for(const item of items){
   if(!validModel(item.model)||!validModel(item.original))continue;
   const key=identity(item.model,item.original);const previous=jobs.get(item.model.id);
   if(previous?.key===key){
    if(previous.state==='done'&&previous.nextAt<=now()){previous.state='queued';previous.report=undefined;previous.order=order++;previous.attempts=0;changed=true;}
    if(previous.state==='queued'&&(item.priority??0)>previous.priority){previous.priority=item.priority??0;changed=true;}
    continue;
   }
   if(jobs.size>=MAX_JOBS&&!previous){const oldest=[...jobs.values()].filter(j=>j.state==='done').sort((a,b)=>a.order-b.order)[0];if(!oldest)continue;jobs.delete(oldest.model.id);}
   jobs.set(item.model.id,{model:descriptor(item.model),original:descriptor(item.original),key,priority:item.priority??0,order:order++,state:'queued',attempts:0,nextAt:0});changed=true;
  }
  if(changed)await save();kick();
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
  return {reports,discoveryMemory,artifactMemory,pending:selected.filter(j=>j.state!=='done').length,total:selected.length,persistenceError};
 }
 async function close(){stopped=true;if(timer)clearTimeout(timer);await ready;while(active)await new Promise(r=>setTimeout(r,10));await save();}
 void ready.then(kick);
 return {enqueue,snapshot,close};
}
