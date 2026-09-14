/** Versioned, conservative dense-transformer estimate, not a successful runtime test.
 * Graph terms follow Ollama v0.33.2 fs/ggml/ggml.go GraphSize. Only documented
 * dense llama/qwen2 conversions are supported; hybrid/recurrent/MoE stay unknown.
 */
export const PREPARATION_MEMORY_VERSION = 'ollama-0.33.2-dense-v1';
export const PREPARATION_BATCH = 512;
export function estimatePreparationMemory(config: Record<string, unknown>, architecture: string, weights: number, context: number): number | null {
  if (!['llama', 'qwen2'].includes(architecture) || config.model_type !== architecture ||
      config.text_config || config.quantization_config || config.sliding_window ||
      config.use_sliding_window || config.num_local_experts || config.num_experts ||
      config.rope_scaling || config.layer_types) return null;
  const keys = ['hidden_size', 'num_hidden_layers', 'num_attention_heads', 'num_key_value_heads', 'vocab_size', 'max_position_embeddings'];
  if (keys.some(key => !Number.isSafeInteger(config[key]) || Number(config[key]) <= 0)) return null;
  const [embedding, layers, heads, kvHeads, vocab, maxContext] = keys.map(key => Number(config[key]));
  const dim = Number(config.head_dim ?? embedding / heads);
  if (!Number.isSafeInteger(dim) || dim <= 0 || embedding !== heads * dim || heads % kvHeads !== 0 ||
      !Number.isSafeInteger(weights) || weights <= 0 || !Number.isSafeInteger(context) || context < 512 || context > maxContext) return null;
  const batch = Math.min(PREPARATION_BATCH, context);
  const kv = context * 2 * dim * kvHeads * 2 * layers; // f16, one parallel sequence
  const full = architecture === 'llama'
    ? Math.max(4*batch*(1+4*embedding+context*(1+heads)), 4*batch*(embedding+vocab))
    : Math.max(4*batch*(embedding+vocab), 4*batch*(1+2*embedding+context+context*heads));
  const partial = architecture === 'llama'
    ? 4*batch*embedding + Math.max(4*batch*(1+embedding+Math.max(context,embedding))+embedding*embedding*9/16+4*context*(batch*heads+dim*kvHeads), 4*batch*(embedding+vocab)+embedding*vocab*105/128)
    : Math.max(4*batch*(embedding+vocab)+embedding*vocab*105/128, 4*(batch*(1+2*embedding+context*(1+heads))+embedding*(1+context)));
  // Reserve 25% for allocation/alignment plus 1 GiB runtime overhead. This is
  // deliberately not weights-only and never substitutes total RAM for free RAM.
  const bytes = Math.ceil((weights + kv + Math.max(full, partial)) * 1.25 + 1024**3);
  return Number.isSafeInteger(bytes) ? bytes : null;
}
