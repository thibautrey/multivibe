import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpenModelCatalog, parseOpenModels, CATALOG_TTL } from './open-model-catalog.js';
import { rankOpenModels, groupModels } from './open-model-ranking.js';
const model = { id:'publisher/model', private:false, gated:false, pipeline_tag:'text-generation', tags:['conversational','code','translation','summarization','license:custom'], createdAt:'2025-01-01T00:00:00Z', downloads:100 };
test('public specific licenses and gates are discovery, private/adapters are excluded',()=>{
 assert.equal(parseOpenModels([model])[0].license,'custom');
 assert.equal(parseOpenModels([{...model,gated:'auto'}])[0].gated,true);
 for(const change of [{private:true},{id:'../unsafe/path'},{tags:['conversational']},{tags:[...model.tags,'base_model:adapter:test']}]) assert.equal(parseOpenModels([{...model,...change}]).length,0);
});
test('pagination, deduplication and new model discovery without code changes',async()=>{
 let generation=0;let calls=0;
 const load=createOpenModelCatalog((async(input)=>{calls++;return new Response(JSON.stringify([{...model,id:`publisher/model${generation}`}]),{headers:String(input).includes('cursor=next')?{}:{link:'<https://huggingface.co/api/models?cursor=next>; rel="next"'}});}) as typeof fetch);
 assert.equal((await load()).models.length,1);assert.equal(calls,7);
 generation++;assert.equal((await load.refresh()).models[0].id,'publisher/model1');
});
test('atomic cache survives restart and stale failure; no weights fetched',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'catalog-test-'));try {
 let now=Date.now(); const file=path.join(dir,'cache.json');let calls=0;
 const fetcher=(async(input)=>{assert.ok(String(input).startsWith('https://huggingface.co/api/models'));calls++;return new Response(JSON.stringify([model]));}) as typeof fetch;
 const load=createOpenModelCatalog(fetcher,()=>now,file);await Promise.all([load(),load()]);assert.equal(calls,4);
 const offline=createOpenModelCatalog((async()=>{throw Error('offline');}) as typeof fetch,()=>now,file);
 assert.equal((await offline()).models.length,1);now+=CATALOG_TTL+1;assert.equal((await offline()).stale,true);assert.equal((await offline.refresh()).stale,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('only documented quantizations group; canonical downloads never sum',()=>{
 const rows=parseOpenModels([model,{...model,id:'publisher/quant',downloads:500,tags:[...model.tags,'base_model:quantized:publisher/model']},{...model,id:'publisher/tune',cardData:{base_model:'publisher/model',base_model_relation:'finetune'}}]);
 const groups=groupModels(rows);assert.equal(groups.length,2);assert.equal(groups[0].model.downloads,100);assert.equal(groups[0].variants.length,2);
});
test('all needs and sorts work; exact runtime evidence only and gated never selected',()=>{
 const models=parseOpenModels([model,{...model,id:'publisher/gated',gated:true}]);const catalog={models,checkedAt:new Date().toISOString(),stale:false,source:'Hugging Face',version:'2'};
 for(const need of ['writing','coding','translation','documents'] as const) for(const sort of ['recommended','trending','downloads','newest','established'] as const) assert.ok(rankOpenModels(catalog,need,sort).length);
 assert.equal(rankOpenModels(catalog,'writing','recommended')[0].compatibility,'unknown');
 const estimates=[{model_id:model.id,aliases:[],variant:'test',state:'compatible' as const,reason:'runtime_memory_estimate'}];
 assert.equal(rankOpenModels(catalog,'writing','recommended',estimates)[0].selectedVariant,model.id);
 assert.equal(rankOpenModels(catalog,'writing','recommended',[{...estimates[0],state:'insufficient'}]).find(r=>r.model.id===model.id)?.compatibility,'insufficient');
});
test('initial failure and unsafe pagination fail closed',async()=>{
 await assert.rejects(createOpenModelCatalog((async()=>new Response('',{status:503})) as typeof fetch)());
 await assert.rejects(createOpenModelCatalog((async()=>new Response(JSON.stringify([model]),{headers:{link:'<https://evil.example/api/models>; rel="next"'}})) as typeof fetch)());
});

test('structured task metadata is evidence, model names are not', () => {
 const parsed = parseOpenModels([{...model, tags:['license:custom'], cardData:{task_categories:['translation','summarization']}}])[0];
 assert.deepEqual(parsed.needs,['translation','documents']);
 assert.deepEqual(parseOpenModels([{...model,id:'publisher/best-coding-translation',tags:['license:custom']}])[0].needs,[]);
});
test('progressive metadata enrichment uses only fixed metadata endpoints', async () => {
 const calls: string[] = [];
 const load = createOpenModelCatalog((async input => {
  calls.push(String(input));
  return new Response(JSON.stringify(String(input).includes('?blobs=true') ? {...model, cardData:{task_categories:['translation']},siblings:[{rfilename:'model.safetensors',size:42}]} : [model]));
 }) as typeof fetch);
 const result = await load();
 assert.equal(result.models[0].files[0].bytes,42);
 assert.ok(result.models[0].metadataCheckedAt);
 assert.equal(calls.filter(url => url.endsWith('?blobs=true')).length,1);
});

test('ambiguous estimates stay unknown, unsupported variants cannot be selected', () => {
 const catalog={models:parseOpenModels([model]),checkedAt:new Date().toISOString(),stale:false,source:'Hugging Face',version:'2'};
 const estimate={model_id:model.id,aliases:[],variant:'q4',state:'compatible' as const,reason:'estimated'};
 assert.equal(rankOpenModels(catalog,'writing','recommended',[estimate,{...estimate,variant:'q8'}])[0].selectedVariant,null);
 for(const reason of ['unsupported_format','insufficient_memory']) {
  const result=rankOpenModels(catalog,'writing','recommended',[{...estimate,state:'insufficient',reason}])[0];
  assert.equal(result.compatibility,'insufficient');assert.equal(result.selectedVariant,null);
 }
});
test('restricted canonical model does not gain estimated fit from an unrestricted conversion', () => {
 const models=parseOpenModels([{...model,gated:true},{...model,id:'publisher/quant',tags:[...model.tags,'base_model:quantized:publisher/model']}]);
 const catalog={models,checkedAt:new Date().toISOString(),stale:false,source:'Hugging Face',version:'2'};
 const result=rankOpenModels(catalog,'writing','recommended',[{model_id:'publisher/quant',aliases:[],variant:'q4',state:'compatible',reason:'estimated'}])[0];
 assert.equal(result.access,'restricted');assert.equal(result.selectedVariant,null);
});
test('Established excludes orphan conversions and never adds their adoption to the original', () => {
 const models=parseOpenModels([{...model,id:'publisher/orphan',tags:[...model.tags,'base_model:quantized:publisher/missing']}]);
 assert.equal(rankOpenModels({models,checkedAt:new Date().toISOString(),stale:false,source:'Hugging Face',version:'2'},'writing','established').length,0);
});
