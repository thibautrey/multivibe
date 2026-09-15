import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoveryMemory,estimateDiscoveryMemory} from './model-discovery-memory.js';
import {parseOpenModels} from './open-model-catalog.js';
import {rankOpenModels} from './open-model-ranking.js';
const config={model_type:'qwen2',hidden_size:4096,num_hidden_layers:32,num_attention_heads:32,num_key_value_heads:8,vocab_size:151936,max_position_embeddings:32768};
test('memory includes full weights, f16 GQA cache, compute reserve and context growth',()=>{
 const a=estimateDiscoveryMemory(config,4*1024**3,8192)!;
 assert.equal(a.cacheMiB,8192*32*8*128*4/1024**2);
 assert.ok(a.requiredMiB>a.weightsMiB+a.cacheMiB);
 assert.ok(estimateDiscoveryMemory(config,4*1024**3,16384)!.requiredMiB>a.requiredMiB);
 assert.ok(estimateDiscoveryMemory(config,8*1024**3)!.requiredMiB>a.requiredMiB);
 assert.equal(estimateDiscoveryMemory({...config,model_type:'unknown'},4*1024**3),null);
 assert.equal(estimateDiscoveryMemory(config,NaN),null);
 assert.equal(estimateDiscoveryMemory(config,4*1024**3,65536),null);
});
test('hybrid cache separates attention and recurrent layers; malformed metadata stays unknown',()=>{
 const hybrid={...config,model_type:'qwen3_5_text',num_hidden_layers:4,layer_types:['linear_attention','linear_attention','linear_attention','full_attention'],linear_conv_kernel_dim:4,linear_key_head_dim:128,linear_value_head_dim:128,linear_num_key_heads:16,linear_num_value_heads:48};
 const result=estimateDiscoveryMemory({text_config:hybrid},4*1024**3)!;
 const recurrent=3*4*(3*(2*16*128+48*128)+48*128*128);
 assert.equal(result.cacheMiB,(8192*8*128*4+recurrent)/1024**2);
 assert.equal(estimateDiscoveryMemory({...hybrid,layer_types:['other']},100),null);
 assert.equal(estimateDiscoveryMemory({...hybrid,linear_key_head_dim:null},100),null);
});
test('metadata-only resolver selects complete Q4 artifact and caches without reading weights',async()=>{
 const raw={id:'owner/model',sha:'a'.repeat(40),private:false,gated:false,pipeline_tag:'text-generation',tags:['license:mit','code'],siblings:[{rfilename:'model-Q4_K_M.gguf',size:4*1024**3},{rfilename:'model-Q8_0.gguf',size:8*1024**3}]};
 const model=parseOpenModels([raw])[0];const urls:string[]=[];
 const resolve=createDiscoveryMemory((async(input)=>{const url=String(input);urls.push(url);return Response.json(url.includes('/api/models/')?raw:config);}) as typeof fetch);
 const memory=await resolve(model,model);assert.equal(memory?.artifact,'model-Q4_K_M.gguf');assert.equal(memory?.source,'metadata');
 await resolve(model,model);assert.equal(urls.length,2);assert.ok(urls.every(url=>url.includes('/api/models/')||url.endsWith('/config.json')));
 const catalog={models:[model],checkedAt:'2026-09-15',stale:false,source:'test',version:'7'};
 const evidence={scores:new Map(),discoveryMemory:new Map([[model.id,memory!]])};
 let row=rankOpenModels(catalog,'coding','recommended',[],Date.now(),evidence)[0];
 assert.ok(row.memory?.requiredMiB);assert.equal(row.compatibility,'unknown');
 row=rankOpenModels(catalog,'coding','recommended',[],Date.now(),{...evidence,memory:{budgetMiB:32768}})[0];assert.equal(row.compatibility,'compatible');
 row=rankOpenModels(catalog,'coding','recommended',[],Date.now(),{...evidence,memory:{budgetMiB:1024}})[0];assert.equal(row.compatibility,'insufficient');
 row=rankOpenModels(catalog,'coding','recommended',[{model_id:model.id,aliases:[],variant:'downloaded',state:'unknown',reason:'runtime',memory:[{device:'Host',model_mib:100,context_mib:10,compute_mib:5}]}],Date.now(),evidence)[0];
 assert.equal(row.memory?.requiredMiB,115);assert.equal(row.memory?.source,'runtime');
});
