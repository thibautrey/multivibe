import test from "node:test";
import assert from "node:assert/strict";
import {providerTokenUsage} from "./usage.js";
const base={prompt_tokens:100,completion_tokens:20,total_tokens:120};
test("managed usage preserves DeepSeek cache partitions and Responses detail aliases",()=>{
 assert.deepEqual(providerTokenUsage({usage:{...base,prompt_cache_hit_tokens:70,prompt_cache_miss_tokens:30}}),
  {inputTokens:"100",outputTokens:"20",totalTokens:"120",cachedInputTokens:"70"});
 assert.deepEqual(providerTokenUsage({usage:{input_tokens:"100",output_tokens:20,input_tokens_details:{cached_tokens:70},output_tokens_details:{reasoning_tokens:5}}}),
  {inputTokens:"100",outputTokens:"20",cachedInputTokens:"70",reasoningTokens:"5"});
 assert.deepEqual(providerTokenUsage({usage:{...base,input_tokens:"100",prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100,prompt_tokens_details:{cached_tokens:"0"}}}),
  {inputTokens:"100",outputTokens:"20",totalTokens:"120",cachedInputTokens:"0"});
});
test("contradictory aliases and missing or inconsistent cache partitions remain uncertain",()=>{
 for(const fields of [{input_tokens:99},{output_tokens:21},{prompt_tokens:null,input_tokens:100},
  {prompt_cache_hit_tokens:70,prompt_tokens_details:{cached_tokens:60}},
  {completion_tokens_details:{reasoning_tokens:5},reasoning_tokens:6},
  {prompt_cache_hit_tokens:101},{prompt_cache_hit_tokens:70,prompt_cache_miss_tokens:31},
  {prompt_cache_miss_tokens:30},{prompt_cache_hit_tokens:null},{prompt_tokens_details:[]},
  {cache_creation_input_tokens:1},{cache_read_input_tokens:1},{input_tokens_details:{cache_write_tokens:2}}]) {
  assert.equal(providerTokenUsage({usage:{...base,...fields}}),null,JSON.stringify(fields));
 }
});
