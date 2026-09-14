import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePreparationMemory } from './local-preparation-memory.js';
const config = {model_type:'qwen2', hidden_size:896, num_hidden_layers:24, num_attention_heads:14, num_key_value_heads:2, vocab_size:151936, max_position_embeddings:32768};
test('dense estimate includes KV, graph and overhead, grows with context and weights', () => {
  const small = estimatePreparationMemory(config, 'qwen2', 500_000_000, 2048)!;
  assert.ok(small > 500_000_000 + 1024**3);
  assert.ok(estimatePreparationMemory(config, 'qwen2', 600_000_000, 2048)! > small);
  assert.ok(estimatePreparationMemory(config, 'qwen2', 500_000_000, 8192)! > small);
  assert.ok(estimatePreparationMemory({...config, model_type:'llama'}, 'llama', 500_000_000, 2048)! > 0);
});
test('unknown, hybrid, MoE, transformed or inconsistent metadata cannot establish fit', () => {
  for (const change of [{model_type:'qwen3_5'}, {text_config:{}}, {quantization_config:{}}, {layer_types:[]}, {num_experts:8}, {rope_scaling:{}}, {sliding_window:4096}, {head_dim:128}, {num_hidden_layers:undefined}, {hidden_size:NaN}]) {
    assert.equal(estimatePreparationMemory({...config,...change}, 'qwen2', 500_000_000, 2048), null);
  }
  for (const weights of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER]) assert.equal(estimatePreparationMemory(config,'qwen2',weights,2048),null);
  assert.equal(estimatePreparationMemory(config,'qwen2',500_000_000,65536),null);
});
