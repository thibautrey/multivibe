import test from "node:test";
import assert from "node:assert/strict";
import {managedProviderStream} from "./stream.js";
import type {ExecutionGrant} from "./authorization.js";
import type {ExecutionReceipt} from "./journal.js";
test("stream retains a nonstandard tier across later standard usage evidence",async()=>{
 const grant:ExecutionGrant={version:1,audience:"multivibe-core-managed",attemptId:"a",reservationId:"r",routeVersionId:"v",providerId:"openai",credentialRef:"c",model:"public",upstreamModel:"upstream",operation:"chat_completions",stream:true,bodySha256:"a".repeat(64),maximumOutputTokens:10,issuedAt:1000,expiresAt:2000};
 for(const service_tier of ["priority","default"]){
  const receipt:ExecutionReceipt={version:1,attemptId:"a",reservationId:"r",routeVersionId:"v",providerId:"openai",bodySha256:grant.bodySha256,state:"uncertain",usage:null,responseSha256:null,status:200,finishedAt:0};
  const frames=[{object:"chat.completion.chunk",service_tier,choices:[]},{object:"chat.completion.chunk",service_tier:"default",choices:[],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}];
  const body=frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join("")+"data: [DONE]\n\n";
  let saved:ExecutionReceipt|undefined;
  const result=managedProviderStream({response:new Response(body),grant,receipt,maximumBytes:10000,clock:()=>1001,async finish(value){saved=value;}});
  if(service_tier==="priority")await assert.rejects(result.response.text(),/provider_stream_incomplete/);
  else await result.response.text();
  const final=await result.receipt;
  assert.equal(final.state,service_tier==="default"?"completed":"uncertain");
  if(service_tier==="priority")assert.equal(final.usage,null);
  assert.equal(saved,final);
 }
});
