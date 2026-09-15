import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkProfiles, benchmarkScores, createRecommendationEvidence, runtimeMemory } from './model-recommendation-evidence.js';
import { rankOpenModels, type RuntimeEstimate } from './open-model-ranking.js';
import { parseOpenModels } from './open-model-catalog.js';
import { createCachedModelBenchmarkClient } from './model-benchmark-cache.js';
import { createModelBenchmarkClient, parseHuggingFaceModelResults } from './model-benchmarks.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const profile = benchmarkProfiles[0];
const observation = (id:string,score:number): import('./model-benchmarks.js').BenchmarkObservation => ({modelId:id,benchmarkId:profile.dataset,taskId:profile.task,score,metric:null,source:'hugging-face' as const,sourceType:'provider' as const,verified:false,sourceUrl:null,sourceName:null,date:null,notes:null,filename:null,pullRequest:null});
const records = (id:string,score:number) => ({key:`hf:model:${id}`,storedAt:'2026-09-15',stale:false,data:{modelId:id,observations:[observation(id,score)]}});
const estimate = (id:string,mib:number):RuntimeEstimate => ({model_id:id,aliases:[],variant:'q4',state:'compatible',reason:'runtime_memory_estimate',memory:[{device:'Host',model_mib:512,context_mib:0,compute_mib:0},{device:'Metal',model_mib:mib-512,context_mib:0,compute_mib:0}]});
const catalog = {models:parseOpenModels(['small','best','large','unknown'].map((name,index)=>({id:`owner/${name}`,private:false,gated:false,pipeline_tag:'text-generation',tags:['code','license:mit'],downloads:1000-index*100}))),checkedAt:'2026-09-15',stale:false,source:'test',version:'6'};
test('best benchmark that fits outranks popularity and higher scores that exceed available memory',()=>{
 const scores=benchmarkScores([records('owner/small',40),records('owner/best',80),records('owner/large',95),records('owner/unknown',100)],profile);
 const rows=rankOpenModels(catalog,'coding','recommended',[estimate('owner/small',4096),estimate('owner/best',8192),estimate('owner/large',24576)],Date.now(),{profile,scores,memory:{accelerator:'metal',freeHostMiB:16384}});
 assert.deepEqual(rows.map(row=>row.model.id),['owner/best','owner/small','owner/unknown','owner/large']);
 assert.equal(rows[0].memory?.requiredMiB,8192); assert.equal(rows[3].compatibility,'insufficient');
 const limited=rankOpenModels(catalog,'coding','benchmark',[estimate('owner/small',4096),estimate('owner/best',8192)],Date.now(),{profile,scores,memory:{accelerator:'metal',freeHostMiB:16384,budgetMiB:6144}});
 assert.equal(limited[0].model.id,'owner/small');
});
test('separate GPU and RAM limits, missing resources, malformed estimates, and zero free memory fail closed',()=>{
 const e=estimate('owner/a',8192);
 assert.equal(runtimeMemory(e,{accelerator:'cuda',freeHostMiB:256,freeDeviceMiB:16384}).state,'insufficient');
 assert.equal(runtimeMemory(e,{accelerator:'metal',freeHostMiB:0}).state,'insufficient');
 assert.equal(runtimeMemory(e,{accelerator:'cuda',freeHostMiB:16384}).state,'unknown');
 assert.equal(runtimeMemory({...e,memory:[{device:'Host',model_mib:NaN,context_mib:0,compute_mib:0}]}).requiredMiB,null);
});
test('task/metric identity and ambiguous scores are not silently mixed',()=>{
 const a=records('owner/a',70);a.data.observations.push({...observation('owner/a',90)});
 const b=records('owner/b',80);b.data.observations[0].taskId='different';
 const c=records('owner/c',60);
 assert.deepEqual([...benchmarkScores([a,b,c],profile).keys()],['owner/c']);
 assert.deepEqual(parseHuggingFaceModelResults('owner/no-results',{id:'owner/no-results'}),[]);
});
test('benchmark warming populates the shared durable cache and cached reads avoid repeated fetches',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'recommendation-evidence-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
 const client=createCachedModelBenchmarkClient(createModelBenchmarkClient({fetcher:(async input=>{calls++;const id=new URL(String(input)).pathname.slice('/api/models/'.length);return new Response(JSON.stringify({id,evalResults:[{data:{dataset:{id:profile.dataset,task_id:profile.task},value:80}}]}));}) as typeof fetch}),{path:path.join(dir,'cache.json')});
 const load=createRecommendationEvidence(client);
 const initial=await load(catalog,'coding');assert.equal(initial.coverage.warming,true);
 for(let i=0;i<100 && (await load(catalog,'coding')).coverage.warming;i++) await new Promise(r=>setTimeout(r,10));
 const loaded=await load(catalog,'coding');assert.equal(loaded.scores.size,4);assert.equal(calls,4);
 await load(catalog,'coding');assert.equal(calls,4);
});
