import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMemoryEstimationQueue} from './model-memory-queue.js';
import {parseOpenModels} from './open-model-catalog.js';
import type {MemoryEstimateReport} from './model-discovery-memory.js';
const model=(n:number)=>parseOpenModels([{id:`owner/model-${n}`,sha:'a'.repeat(40),private:false,gated:false,pipeline_tag:'text-generation',tags:['code','license:mit']}])[0];
const ready=(id:string):MemoryEstimateReport=>({reason:'ready',checkedAt:new Date().toISOString(),estimates:[{requiredMiB:4000,weightsMiB:3000,cacheMiB:500,overheadMiB:500,variant:id,artifact:'model-Q4_K_M.gguf',contextTokens:8192,source:'metadata',estimator:'catalog-memory-v2'}]});
async function until(check:()=>Promise<boolean>){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Queue did not settle');}
test('full queue drains beyond 24 families, foreground priority wins, results survive restart',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'memory-queue-test-'));const file=path.join(dir,'queue.json');
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);const seen:string[]=[];
 const q=createMemoryEstimationQueue({path:file,concurrency:1,resolve:async m=>{seen.push(m.id);if(seen.length===1)await gate;return ready(m.id);}});
 try{
  const models=Array.from({length:40},(_,i)=>model(i));await q.enqueue(models.map(m=>({model:m,original:m})));
  await until(async()=>seen.length===1);await q.enqueue([{model:models[39],original:models[39],priority:100}]);release();
  await until(async()=>!(await q.snapshot()).pending);assert.equal(seen[1],models[39].id);assert.equal(new Set(seen).size,40);await q.close();
  let reads=0;const resumed=createMemoryEstimationQueue({path:file,resolve:async m=>{reads++;return ready(m.id);}});
  await resumed.enqueue(models.map(m=>({model:m,original:m})));assert.equal((await resumed.snapshot()).discoveryMemory.size,40);assert.equal(reads,0);await resumed.close();
 }finally{release();await q.close();await rm(dir,{recursive:true,force:true});}
});
test('pending retries resume after restart; a revision change invalidates saved estimates',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'memory-retry-test-'));const file=path.join(dir,'queue.json');let time=1000000;const m=model(1);
 const q=createMemoryEstimationQueue({path:file,now:()=>time,resolve:async()=>({reason:'temporary_failure',estimates:[],checkedAt:new Date(time).toISOString()})});
 await q.enqueue([{model:m,original:m}]);await until(async()=>(await q.snapshot()).reports[m.id]?.reason==='temporary_failure');await q.close();time+=60001;
 let calls=0;const resumed=createMemoryEstimationQueue({path:file,now:()=>time,resolve:async x=>{calls++;return ready(x.id);}});
 try{
  await until(async()=>(await resumed.snapshot()).reports[m.id]?.reason==='ready');assert.equal(calls,1);
  const changed={...m,revision:'b'.repeat(40)};await resumed.enqueue([{model:changed,original:changed}]);await until(async()=>(await resumed.snapshot()).reports[m.id]?.reason==='ready');assert.equal(calls,2);
 }finally{await resumed.close();await rm(dir,{recursive:true,force:true});}
});
test('corrupt queue is rebuilt and supported jobs still complete',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'memory-corrupt-test-'));const file=path.join(dir,'queue.json');await writeFile(file,'invalid');
 const q=createMemoryEstimationQueue({path:file,resolve:async m=>ready(m.id)});
 try{const m=model(1);await q.enqueue([{model:m,original:m}]);await until(async()=>!(await q.snapshot()).pending);assert.equal((await q.snapshot()).discoveryMemory.size,1);}finally{await q.close();await rm(dir,{recursive:true,force:true});}
});

test('rate limits pause the shared queue rather than failing every pending model',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'memory-rate-test-'));const file=path.join(dir,'queue.json');let calls=0;
 const q=createMemoryEstimationQueue({path:file,concurrency:1,resolve:async()=>{calls++;return {reason:'temporary_failure',httpStatus:429,retryAfterMs:60000,estimates:[],checkedAt:new Date().toISOString()};}});
 try{await q.enqueue([model(1),model(2)].map(m=>({model:m,original:m})));await until(async()=>Boolean((await q.snapshot()).pausedUntil));assert.equal(calls,1);assert.equal((await q.snapshot()).pending,2);}finally{await q.close();await rm(dir,{recursive:true,force:true});}
});
