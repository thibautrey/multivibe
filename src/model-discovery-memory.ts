import { modelArtifacts,isModelWeightArtifact } from './model-variants.js';
import { parseOpenModels } from './open-model-catalog.js';
import type { OpenModel } from './open-model-ranking.js';

export type DiscoveryMemory = { requiredMiB: number; weightsMiB: number; cacheMiB: number; overheadMiB: number; variant: string; artifact: string; contextTokens: number; source: 'metadata'; estimator: 'catalog-memory-v1' | 'catalog-memory-v2' };
const MiB = 1024 ** 2;
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
/** Approximate text-generation budget, not a runtime allocation or installation approval.
 * Cache layout follows Ollama v0.33.2 fs/ggml/ggml.go GraphSize (f16 KV,
 * f32 recurrent state). Compute reserve is our conservative heuristic, not an
 * Ollama/LM Studio prediction: non-flash attention workspace, 25% + 1 GiB.
 * All expert weights remain resident. Vision/audio processing is not estimated.
 */
export function estimateDiscoveryMemory(raw: Record<string, any>, weights: number, context = 8192) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw.text_config ?? raw;
  const supported = SUPPORTED_MEMORY_ARCHITECTURES;
  if (!c || !supported.includes(c.model_type) || !positive(weights) || !positive(context) || context > c.max_position_embeddings) return null;
  const {hidden_size:e,num_hidden_layers:layers,num_attention_heads:heads,num_key_value_heads:kvHeads,vocab_size:vocab} = c;
  const dim = c.head_dim ?? e / heads;
  if (![e,layers,heads,kvHeads,vocab,dim,c.max_position_embeddings].every(positive) || heads % kvHeads || layers > 1024 || context > 1048576) return null;
  // Even one-bit embeddings require this much storage; smaller artifacts cannot be full weights.
  if(weights < e*vocab/8)return null;
  const hybrid = ['qwen3_next','qwen3_5_text','qwen3_5_moe_text'].includes(c.model_type);
  let attentionLayers = layers; let recurrent = 0;
  if (hybrid) {
    if (!Array.isArray(c.layer_types) || c.layer_types.length !== layers || c.layer_types.some((t: string)=>!['full_attention','linear_attention'].includes(t))) return null;
    attentionLayers = c.layer_types.filter((t: string)=>t === 'full_attention').length;
    const {linear_conv_kernel_dim:conv,linear_key_head_dim:key,linear_value_head_dim:value,linear_num_key_heads:keyHeads,linear_num_value_heads:valueHeads} = c;
    if (![conv,key,value,keyHeads,valueHeads].every(positive)) return null;
    recurrent = (layers-attentionLayers) * 4 * ((conv-1)*(2*keyHeads*key + valueHeads*value) + valueHeads*key*value);
  } else if (c.layer_types && (!Array.isArray(c.layer_types) || c.layer_types.length !== layers || c.layer_types.some((t:string)=>!['full_attention','sliding_attention'].includes(t)))) return null;
  // For sliding-window attention, full-context KV is a conservative upper bound.
  const cache = context * attentionLayers * kvHeads * dim * 2 * 2 + recurrent;
  const batch = Math.min(context, 512);
  const workspace = 4 * batch * (context * heads + 4 * e + vocab);
  const overhead = workspace + (weights + cache + workspace) * .25 + 1024 ** 3;
  const total = Math.ceil(weights + cache + overhead);
  if (!Number.isSafeInteger(total)) return null;
  return {requiredMiB:total/MiB,weightsMiB:weights/MiB,cacheMiB:cache/MiB,overheadMiB:overhead/MiB};
}

export const SUPPORTED_MEMORY_ARCHITECTURES = ['llama','qwen2','qwen3','qwen3_moe','qwen3_next','qwen3_5_text','qwen3_5_moe_text','mistral','mixtral','phi3','phi','gemma','gemma2','gemma3_text','starcoder2'];
export type MemoryEstimateReason = 'ready'|'queued'|'estimating'|'unsupported_architecture'|'missing_config'|'incomplete_metadata'|'incomplete_weights'|'context_unsupported'|'access_required'|'revision_changed'|'temporary_failure';
export type MemoryEstimateReport = {reason:MemoryEstimateReason; estimates:DiscoveryMemory[]; artifactReasons?:Record<string,MemoryEstimateReason>; revision?:string; httpStatus?:number;retryAfterMs?:number; checkedAt:string};
class MetadataError extends Error {constructor(readonly status:number,readonly retryAfterMs?:number){super('Metadata unavailable');}}
/** Shared immutable-config cache: one config read can estimate every quantization. */
export function createDiscoveryMemory(fetcher: typeof fetch = fetch, now = Date.now) {
  const cache = new Map<string,{at:number; value:MemoryEstimateReport}>();
  const pending = new Map<string,Promise<MemoryEstimateReport>>();
  const configs = new Map<string,Promise<any>>();
  let nextRequest=0;
  async function json(url: string): Promise<any> {
    const delay=Math.max(0,nextRequest-now());nextRequest=Math.max(nextRequest,now())+200;
    if(delay)await new Promise(r=>setTimeout(r,delay));
    const response = await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(6000)});
    if (!response.ok || !response.body) {await response.body?.cancel();const retry=response.headers.get('retry-after');const seconds=retry?Number(retry):NaN;const retryMs=retry?(Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-now()):60000;throw new MetadataError(response.status,Math.max(1000,Math.min(Number.isFinite(retryMs)?retryMs:60000,15*60000)));}
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try {for (;;) {const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>2*MiB)throw Error('Metadata too large');chunks.push(item.value);}}
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function configAt(id:string,revision:string){
    const key=`${id}@${revision}`;if(configs.has(key))return configs.get(key)!;
    if(configs.size>=256)configs.delete(configs.keys().next().value!);
    const task=json(`https://huggingface.co/${id}/raw/${revision}/config.json`).catch(error=>{configs.delete(key);throw error;});configs.set(key,task);return task;
  }
  async function inspect(model:OpenModel,original:OpenModel,context=8192):Promise<MemoryEstimateReport>{
    const report=(reason:MemoryEstimateReason,rest:Partial<MemoryEstimateReport>={}):MemoryEstimateReport=>({reason,estimates:[],checkedAt:new Date(now()).toISOString(),...rest});
    if(![model.id,original.id].every(id=>/^[\w.-]+\/[\w.-]+$/.test(id)))return report('incomplete_metadata');
    if(model.gated || original.gated)return report('access_required');
    if(!isModelWeightArtifact(model.id))return report('incomplete_weights');
    const key=`v2:${context}:${model.id}@${model.revision}:${original.id}@${original.revision}`;
    const saved=cache.get(key);if(saved && now()-saved.at< (saved.value.reason==='temporary_failure'?60000:6*3600000))return saved.value;
    if(pending.has(key))return pending.get(key)!;
    const operation=(async()=>{
      try{
        const revisionPath=model.revision && /^[a-f0-9]{40}$/.test(model.revision)?`/revision/${model.revision}`:'';
        const detail=await json(`https://huggingface.co/api/models/${model.id}${revisionPath}?blobs=true`);
        const current=parseOpenModels([detail])[0];
        if(!current || current.id!==model.id || !current.revision)return report('incomplete_metadata');
        if(current.gated)return report('access_required');
        if(model.revision && current.revision!==model.revision)return report('revision_changed');
        let config;
        try{config=await configAt(model.id,current.revision);}
        catch(error){
          if(!(error instanceof MetadataError) || error.status!==404)throw error;
          if(model.id===original.id || current.parent!==original.id || !['quantized','converted'].includes(current.relation??''))return report('missing_config');
          let originalRevision=original.revision;
          if(!originalRevision){const parent=await json(`https://huggingface.co/api/models/${original.id}`);originalRevision=parent.id===original.id && /^[a-f0-9]{40}$/.test(parent.sha)?parent.sha:null;}
          if(!originalRevision)return report('incomplete_metadata');
          try{config=await configAt(original.id,originalRevision);}catch(e){if(e instanceof MetadataError&&e.status===404)return report('missing_config');throw e;}
        }
        const c=config?.text_config??config;
        if(!c || typeof c!=='object')return report('missing_config');
        if(!SUPPORTED_MEMORY_ARCHITECTURES.includes(c.model_type))return report('unsupported_architecture',{revision:current.revision});
        if(positive(c.max_position_embeddings) && context>c.max_position_embeddings)return report('context_unsupported',{revision:current.revision});
        const artifacts=modelArtifacts(current);const estimates:DiscoveryMemory[]=[];const artifactReasons:Record<string,MemoryEstimateReason>={};
        for(const artifact of artifacts){
          if(!positive(artifact.bytes)){artifactReasons[artifact.name]='incomplete_weights';continue;}
          const result=estimateDiscoveryMemory(config,artifact.bytes,context);
          if(!result){artifactReasons[artifact.name]='incomplete_metadata';continue;}
          estimates.push({...result,variant:model.id,artifact:artifact.name,contextTokens:context,source:'metadata',estimator:'catalog-memory-v2'});artifactReasons[artifact.name]='ready';
        }
        estimates.sort((a,b)=>Number(/Q4_K_M/i.test(b.artifact))-Number(/Q4_K_M/i.test(a.artifact))||a.requiredMiB-b.requiredMiB);
        return report(estimates.length?'ready':Object.values(artifactReasons)[0]??'incomplete_weights',{estimates,artifactReasons,revision:current.revision});
      }catch(error){return report(error instanceof MetadataError && [401,403].includes(error.status)?'access_required':'temporary_failure',error instanceof MetadataError?{httpStatus:error.status,retryAfterMs:error.retryAfterMs}:{});}
    })().then(value=>{if(cache.size>=512)cache.delete(cache.keys().next().value!);cache.set(key,{at:now(),value});return value;}).finally(()=>pending.delete(key));
    pending.set(key,operation);return operation;
  }
  return Object.assign(async(model:OpenModel,original:OpenModel)=> (await inspect(model,original)).estimates[0]??null,{inspect});
}
