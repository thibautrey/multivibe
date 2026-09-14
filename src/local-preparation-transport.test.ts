import assert from 'node:assert/strict';
import test from 'node:test';
import {readHostPreparationOperation,type HostPreparationOperation} from './local-preparation-transport.js';
const input:HostPreparationOperation={operation:'download',policy_revision:1,context_tokens:2048,artifact:{model_id:'author/model',revision:'a'.repeat(40),filename:'model.gguf',sha256:'b'.repeat(64),bytes:10}};
function response(events:unknown[]){return new Response(events.map(e=>JSON.stringify(e)+'\n').join(''),{headers:{'content-type':'application/x-ndjson'}});}
test('Host progress is delivered before verified completion',async()=>{
 const seen:number[]=[];const result=await readHostPreparationOperation(response([{type:'progress',total_bytes:10},{type:'progress',completed_bytes:10,total_bytes:10},{type:'complete'}]),input,new AbortController().signal,async n=>{seen.push(n);});assert.deepEqual(result,{});assert.deepEqual(seen,[0,10]);
});
test('truncated, regressing, over-budget and post-completion streams fail',async()=>{
 for(const events of [[{type:'progress',completed_bytes:5,total_bytes:10}],[{type:'complete'}],[{type:'progress',completed_bytes:11,total_bytes:10}],[{type:'progress',completed_bytes:5,total_bytes:10},{type:'progress',completed_bytes:4,total_bytes:10}],[{type:'progress',completed_bytes:10,total_bytes:10},{type:'complete'},{type:'complete'}]])await assert.rejects(readHostPreparationOperation(response(events),input,new AbortController().signal,async()=>{}));
});
test('errors are sanitized and cancellation rejects',async()=>{
 await assert.rejects(readHostPreparationOperation(response([{type:'error',error:'secret'}]),input,new AbortController().signal,async()=>{}),/local_preparation_failed/);
 const abort=new AbortController();abort.abort();await assert.rejects(readHostPreparationOperation(response([{type:'complete'}]),input,abort.signal,async()=>{}));
});
test('import requires a private runtime identity, not an arbitrary route',async()=>{
 const name='multivibe-local-'+ 'a'.repeat(32)+':latest';const imported={...input,operation:'import' as const};assert.deepEqual(await readHostPreparationOperation(response([{type:'complete',runtime_model:name}]),imported,new AbortController().signal,async()=>{}),{runtimeModel:name});
 await assert.rejects(readHostPreparationOperation(response([{type:'complete',runtime_model:'cloud/model'}]),imported,new AbortController().signal,async()=>{}));
});
