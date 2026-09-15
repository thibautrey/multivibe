import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapshotSources,collectionSources} from './curated-model-catalog.js';
import {parseOpenModels} from './open-model-catalog.js';
import {rankOpenModels} from './open-model-ranking.js';
test('verified catalog references use exact model ids and valid source links',()=>{
 const sources=snapshotSources();assert.ok(sources.get('Qwen/Qwen3.8-27B')?.some(s=>s.id==='lmstudio'));
 for(const [id,entries] of sources){assert.match(id,/^[\w.-]+\/[\w.-]+$/);assert.equal(new Set(entries.map(e=>e.id)).size,entries.length);for(const e of entries)assert.ok(['lmstudio.ai','ollama.com'].includes(new URL(e.url).hostname));}
});
test('collections preserve owner attribution and reject unrelated items; outages retain catalog references',async()=>{
 const result=await collectionSources((async input=>{
  const owner=new URL(String(input)).searchParams.get('owner');
  return Response.json([{owner:{name:owner},slug:`${owner}/latest-123`,items:[{type:'model',id:`${owner}/model`},{type:'model',id:'unrelated/model'},{type:'dataset',id:`${owner}/data`}]}]);
 }) as typeof fetch);
 assert.equal(result.get('Qwen/model')?.[0].kind,'publisher');assert.equal(result.get('mlx-community/model')?.[0].kind,'quantization');assert.equal(result.has('unrelated/model'),false);
 assert.deepEqual(await collectionSources((async()=>{throw Error('offline');}) as typeof fetch),snapshotSources());
});
test('curation boosts Recommended only; publisher catalogs are not quality votes',()=>{
 const models=parseOpenModels(['curated','benchmark','publisher'].map(id=>({id:`owner/${id}`,private:false,gated:false,pipeline_tag:'text-generation',tags:['code','license:mit'],downloads:100})));
 models[0].recommendationSources=[{id:'lmstudio',label:'LM Studio',url:'https://lmstudio.ai/models/qwen3.8',kind:'curated',checkedAt:'2026-09-15'}];
 models[2].recommendationSources=[{id:'Qwen',label:'Qwen',url:'https://huggingface.co/collections/Qwen/latest',kind:'publisher',checkedAt:'2026-09-15'}];
 const catalog={models,checkedAt:'2026-09-15',stale:false,source:'test',version:'8'};
 const scores=new Map([[models[1].id,{modelId:models[1].id,score:90,label:'Test',benchmarkId:'test',taskId:'test',metric:null,source:'hugging-face',sourceType:'provider',verified:false,sourceUrl:null,sourceName:null,date:null,notes:null,filename:null,pullRequest:null,stale:false,storedAt:'2026-09-15'} as const]]);
 assert.equal(rankOpenModels(catalog,'coding','recommended',[],Date.now(),{scores})[0].model.id,'owner/curated');
 assert.equal(rankOpenModels(catalog,'coding','benchmark',[],Date.now(),{scores})[0].model.id,'owner/benchmark');
});
