import { modelArtifacts } from './model-variants.js';
import { parseOpenModels } from './open-model-catalog.js';
import type { OpenModel } from './open-model-ranking.js';

export type DiscoveryMemory = { requiredMiB: number; weightsMiB: number; cacheMiB: number; overheadMiB: number; variant: string; artifact: string; contextTokens: number; source: 'metadata'; estimator: 'catalog-memory-v1' };
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
  const supported = ['llama','qwen2','qwen3','qwen3_moe','qwen3_next','qwen3_5_text','qwen3_5_moe_text'];
  if (!c || !supported.includes(c.model_type) || !positive(weights) || !positive(context) || context > c.max_position_embeddings) return null;
  const {hidden_size:e,num_hidden_layers:layers,num_attention_heads:heads,num_key_value_heads:kvHeads,vocab_size:vocab} = c;
  const dim = c.head_dim ?? e / heads;
  if (![e,layers,heads,kvHeads,vocab,dim,c.max_position_embeddings].every(positive) || heads % kvHeads || layers > 1024 || context > 1048576) return null;
  const hybrid = ['qwen3_next','qwen3_5_text','qwen3_5_moe_text'].includes(c.model_type);
  let attentionLayers = layers; let recurrent = 0;
  if (hybrid) {
    if (!Array.isArray(c.layer_types) || c.layer_types.length !== layers || c.layer_types.some((t: string)=>!['full_attention','linear_attention'].includes(t))) return null;
    attentionLayers = c.layer_types.filter((t: string)=>t === 'full_attention').length;
    const {linear_conv_kernel_dim:conv,linear_key_head_dim:key,linear_value_head_dim:value,linear_num_key_heads:keyHeads,linear_num_value_heads:valueHeads} = c;
    if (![conv,key,value,keyHeads,valueHeads].every(positive)) return null;
    recurrent = (layers-attentionLayers) * 4 * ((conv-1)*(2*keyHeads*key + valueHeads*value) + valueHeads*key*value);
  } else if (c.layer_types || c.sliding_window || c.use_sliding_window) return null;
  const cache = context * attentionLayers * kvHeads * dim * 2 * 2 + recurrent;
  const batch = Math.min(context, 512);
  const workspace = 4 * batch * (context * heads + 4 * e + vocab);
  const overhead = workspace + (weights + cache + workspace) * .25 + 1024 ** 3;
  const total = Math.ceil(weights + cache + overhead);
  if (!Number.isSafeInteger(total)) return null;
  return {requiredMiB:total/MiB,weightsMiB:weights/MiB,cacheMiB:cache/MiB,overheadMiB:overhead/MiB};
}

/** Fixed-origin, bounded metadata reads. No weights, remote code, or model-card URLs. */
export function createDiscoveryMemory(fetcher: typeof fetch = fetch, now = Date.now) {
  const cache = new Map<string,{at:number; value:DiscoveryMemory | null}>();
  const pending = new Map<string,Promise<DiscoveryMemory | null>>();
  async function json(url: string): Promise<any> {
    const response = await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(6000)});
    if (!response.ok || !response.body) {await response.body?.cancel();throw Error('Metadata unavailable');}
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try {for (;;) {const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>2*MiB)throw Error('Metadata too large');chunks.push(item.value);}}
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async function estimate(model: OpenModel, original: OpenModel): Promise<DiscoveryMemory | null> {
    if (![model.id,original.id].every(id=>/^[\w.-]+\/[\w.-]+$/.test(id)) || model.gated || original.gated) return null;
    const key=`${model.id}@${model.revision}:${original.id}@${original.revision}`;
    const saved=cache.get(key);if(saved && now()-saved.at < (saved.value ? 6*3600000 : 10*60000))return saved.value;
    if(pending.has(key))return pending.get(key)!;
    const operation=(async()=>{
      let value:DiscoveryMemory|null=null;
      try {
        const detail=await json(`https://huggingface.co/api/models/${model.id}?blobs=true`);
        const current=parseOpenModels([detail])[0];
        if (!current || current.id !== model.id || current.gated || !current.revision || (model.revision && current.revision !== model.revision)) return null;
        // Read the variant's own config first: conversions may change architecture.
        const configRevision=current.revision;
        let config;
        try {config=await json(`https://huggingface.co/${model.id}/raw/${configRevision}/config.json`);}
        catch {
          if(model.id===original.id || current.parent!==original.id || !['quantized','converted'].includes(current.relation ?? '') || !original.revision)return null;
          config=await json(`https://huggingface.co/${original.id}/raw/${original.revision}/config.json`);
        }
        const artifacts=modelArtifacts(current).filter(a=>positive(a.bytes));
        // Prefer a real, complete Q4_K_M artifact; never invent a quantized size.
        artifacts.sort((a,b)=>Number(b.quantization==='Q4_K_M')-Number(a.quantization==='Q4_K_M') || (a.bytes!-b.bytes!));
        const artifact=artifacts[0];
        const result=artifact && estimateDiscoveryMemory(config,artifact.bytes!);
        if(result)value={...result,variant:model.id,artifact:artifact.name,contextTokens:8192,source:'metadata',estimator:'catalog-memory-v1'};
      } catch { /* Absent or unsupported metadata remains unknown. */ }
      return value;
    })().then(value=>{if(cache.size>=512)cache.delete(cache.keys().next().value!);cache.set(key,{at:now(),value});return value;}).finally(()=>pending.delete(key));
    pending.set(key,operation);return operation;
  };
}
