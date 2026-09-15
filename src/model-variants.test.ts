import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupModels} from './open-model-ranking.js';
import {parseOpenModels,createOpenModelCatalog} from './open-model-catalog.js';
import {modelArtifacts} from './model-variants.js';
const raw=(id:string,extra:Record<string,unknown>={})=>({id,private:false,gated:false,pipeline_tag:'text-generation',tags:['code','license:mit'],...extra});
const models=(...rows:ReturnType<typeof raw>[])=>parseOpenModels(rows);
test('conversion chains resolve to the original while fine-tunes retain separate identities',()=>{
 const rows=models(raw('org/original'),raw('other/q4',{cardData:{base_model:'org/original',base_model_relation:'quantized'}}),raw('third/converted',{cardData:{base_model:'other/q4',base_model_relation:'converted'}}),raw('org/tune',{cardData:{base_model:'org/original',base_model_relation:'finetune'}}));
 const families=groupModels(rows);assert.equal(families.length,2);assert.equal(families[0].model.id,'org/original');assert.equal(families[0].variants.length,3);assert.equal(families[0].familyStatus,'resolved');assert.equal(families[1].model.id,'org/tune');
});
test('missing, cyclic and contradictory parents are unresolved instead of guessed',()=>{
 const rows=models(raw('org/a',{cardData:{base_model:'org/b',base_model_relation:'quantized'}}),raw('org/b',{cardData:{base_model:'org/a',base_model_relation:'quantized'}}),raw('org/c',{tags:['code','license:mit','base_model:quantized:org/original'],cardData:{base_model:'org/another'}}),raw('other/model-GGUF'));
 assert.ok(groupModels(rows).every(g=>g.familyStatus==='unresolved'));assert.equal(rows[2].lineageAmbiguous,true);
});
test('structured quantization metadata establishes a conversion only with one declared parent',()=>{
 const [model]=models(raw('org/weights',{cardData:{base_model:'org/original'},config:{quantization_config:{quant_method:'awq',bits:4}}}));assert.equal(model.quantization,'awq 4-bit');assert.equal(model.relation,'quantized');
});
test('GGUF artifacts remain separate by level and complete shards combine without counting projector weights',()=>{
 const [model]=models(raw('org/model-GGUF',{siblings:[{rfilename:'model-Q4_K_M-00001-of-00002.gguf',size:100},{rfilename:'model-Q4_K_M-00002-of-00002.gguf',size:200},{rfilename:'model-Q8_0.gguf',size:600},{rfilename:'mmproj-F16.gguf',size:50}]}));
 assert.deepEqual(modelArtifacts(model).map(a=>[a.quantization,a.bytes]),[['Q4_K_M',300],['Q8_0',600]]);
 model.files.shift();assert.equal(modelArtifacts(model)[0].bytes,null);
});
test('safetensors size does not add alternative bin weights or incomplete shards',()=>{
 const [model]=models(raw('org/original',{siblings:[{rfilename:'model.safetensors',size:100},{rfilename:'pytorch_model.bin',size:200}]}));assert.equal(modelArtifacts(model)[0].bytes,100);
 model.files=[{name:'model-00001-of-00002.safetensors',bytes:50}];assert.equal(modelArtifacts(model)[0].bytes,null);
});
test('family discovery uses declared identities and caches metadata across repeated opens',async()=>{
 let calls=0;
 const load=createOpenModelCatalog((async input=>{calls++;const u=new URL(String(input));const filter=u.searchParams.get('filter');
 if(u.pathname==='/api/models/org/original')return new Response(JSON.stringify(raw('org/original')));
 if(u.pathname==='/api/models/other/quant')return new Response(JSON.stringify(raw('other/quant',{cardData:{base_model:'org/original',base_model_relation:'quantized'},siblings:[{rfilename:'weights-Q4_K_M.gguf',size:100}]})));
 if(filter?.startsWith('base_model:'))return new Response(JSON.stringify([raw('other/quant',{cardData:{base_model:'org/original',base_model_relation:'quantized'}})]));
 if(u.pathname==='/api/models')return new Response(JSON.stringify([raw('org/original')]));
 return new Response('{}',{status:503});
 }) as typeof fetch);
 await load();const family=await load.family('org/original');assert.equal(family.length,2);assert.equal(family[1].files[0].bytes,100);const before=calls;await load.family('org/original');assert.equal(calls,before);await assert.rejects(load.family('../secret'));
});
