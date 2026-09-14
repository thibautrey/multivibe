import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLocalPreparationResolver} from './local-preparation-preflight.js';
import type {ProviderAgentControl} from './provider-agent-supervisor.js';
const GiB=1024**3;
function fixture() {
  const policy={revision:1,paused:false,automatic_downloads:true,allow_cloud_workloads:false,policy:{gpu_vram_percent:75,max_disk_bytes:30*GiB,reserve_free_disk_bytes:5*GiB,max_download_bytes_per_day:20*GiB}};
  const runtime={version:'0.33.2',runtime_installed:true};
  const resources={policy_revision:1,observed_at:new Date().toISOString(),free_storage_bytes:100*GiB,occupied_storage_bytes:0,free_runtime_storage_bytes:100*GiB,free_host_memory_bytes:16*GiB,free_accelerator_memory_bytes:16*GiB};
  const host={enabled:true,getCapacityPolicy:async()=>structuredClone(policy),getCapability:async()=>({supported:true,accelerator:'metal',accelerator_memory_bytes:32*GiB}),getManifest:async()=>({device_key_id:'host-key'}),getManagedOllamaStatus:async()=>({runtime}),getLocalPreparationResources:async()=>resources} as unknown as ProviderAgentControl;
  const metadata={id:'publisher/model',private:false,gated:false,pipeline_tag:'text-generation',sha:'a'.repeat(40),cardData:{license:'custom-license'},tags:[]};
  const variant={...metadata,id:'converter/model-GGUF',tags:['base_model:quantized:publisher/model'],gguf:{architecture:'qwen2'},siblings:[{rfilename:'model-Q4_K_M.gguf',lfs:{size:500_000_000,sha256:'b'.repeat(64)}}]};
  const config={model_type:'qwen2',hidden_size:896,num_hidden_layers:24,num_attention_heads:14,num_key_value_heads:2,vocab_size:151936,max_position_embeddings:32768};
  const urls:string[]=[];
  const fetcher=(async(url: string,init:RequestInit)=>{urls.push(url);assert.equal(init.redirect,'error');assert.ok(!init.method || init.method==='GET');
    let data:unknown;
    if(url.includes('/raw/')) {assert.ok(url.includes('/'+'a'.repeat(40)+'/config.json'));data=config;}
    else if(url.includes('?filter=')) data=[variant];
    else if(url.includes('/converter/')) data=variant;
    else data=metadata;
    return new Response(JSON.stringify(data));
  }) as typeof fetch;
  return {host,resolve:createLocalPreparationResolver(host,fetcher),policy,runtime,resources,variant,config,urls};
}
test('real resolver produces exact artifact plan from bounded metadata, without downloading weights',async()=>{
  const f=fixture();const plan=await f.resolve('publisher/model');
  assert.equal(plan.artifact.sha256,'b'.repeat(64));assert.equal(plan.quote.requiredDiskBytes,1_000_000_000);
  assert.equal(plan.quote.downloadBytes,500_000_000);assert.equal(plan.contextTokens,2048);
  assert.equal(plan.quote.configurationKey.length,64);assert.equal(f.urls.length,4);
  assert.ok(f.urls.every(url=>!url.includes('/resolve/') && !url.endsWith('.gguf')));
});
test('paused policy and absent runtime stop before source access',async()=>{
  const f=fixture();f.policy.paused=true;await assert.rejects(f.resolve('publisher/model'),/host_permission_required/);
  f.policy.paused=false;f.runtime.runtime_installed=false;await assert.rejects(f.resolve('publisher/model'),/runtime_download_quote_required/);
  assert.equal(f.urls.length,0);
});
test('unknown resources, insufficient disk and daily limit never produce consent',async()=>{
  const f=fixture();f.resources.free_host_memory_bytes=NaN;await assert.rejects(f.resolve('publisher/model'),/resources_unknown/);
  f.resources.free_host_memory_bytes=16*GiB;f.resources.free_storage_bytes=GiB;await assert.rejects(f.resolve('publisher/model'),/insufficient_disk/);
  f.resources.free_storage_bytes=100*GiB;f.policy.policy.max_download_bytes_per_day=1;await assert.rejects(f.resolve('publisher/model'),/download_budget_exceeded/);
});
test('unsupported architecture, restricted conversion and unrelated conversion stay unverified',async()=>{
  const f=fixture();f.config.model_type='qwen3_5';await assert.rejects(f.resolve('publisher/model'),/compatibility_not_established/);
  f.config.model_type='qwen2';f.variant.gated=true;await assert.rejects(f.resolve('publisher/model'),/compatibility_not_established/);
  f.variant.gated=false;f.variant.tags=['base_model:finetune:publisher/model'];await assert.rejects(f.resolve('publisher/model'),/compatibility_not_established/);
});

test('absent runtime includes exact archive consent and separate filesystem reservation',async()=>{
 const f=fixture(); f.runtime.runtime_installed=false;
 f.host.getLocalPreparationRuntimeQuote=async()=>({version:'0.33.2',platform:'darwin-arm64',sha256:'c'.repeat(64),bytes:GiB});
 const plan=await f.resolve('publisher/model');
 assert.equal(plan.quote.downloadBytes,500_000_000+GiB);
 assert.equal(plan.quote.requiredDiskBytes,1_000_000_000+5*GiB);
 assert.equal(plan.quote.runtimeDownload?.bytes,GiB);
 f.resources.free_runtime_storage_bytes=GiB;
 await assert.rejects(f.resolve('publisher/model'),/insufficient_disk/);
 f.resources.free_runtime_storage_bytes=NaN;
 await assert.rejects(f.resolve('publisher/model'),/resources_unknown/);
});
