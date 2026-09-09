import test from "node:test";
import assert from "node:assert/strict";
import {managedProviderRequest} from "./request.js";
import type {ExecutionGrant} from "./authorization.js";
const grant:ExecutionGrant={version:1,audience:"multivibe-core-managed",attemptId:"attempt",reservationId:"reservation",routeVersionId:"route",providerId:"mistral",credentialRef:"account",model:"public/model",upstreamModel:"model",operation:"chat_completions",stream:false,bodySha256:"a".repeat(64),maximumOutputTokens:10,issuedAt:1000,expiresAt:2000};
test("provider projection cannot multiply a per-choice output grant",()=>{
 for(const n of [2,10,0,null,"1"]){
  assert.throws(()=>managedProviderRequest(grant,Buffer.from(JSON.stringify({model:grant.model,messages:[],n}))),/single_output_required/);
 }
 for(const n of [undefined,1]){
  const result=JSON.parse(Buffer.from(managedProviderRequest(grant,Buffer.from(JSON.stringify({model:grant.model,messages:[],n})))).toString());
  assert.equal(result.max_tokens,10);
 }
});

test("OpenAI projection bounds completion and reasoning for both incoming operations",()=>{
 for(const operation of ["responses","chat_completions"] as const){
  for(const providerId of ["openai","mistral","xai","deepseek"]){
   for(const limit of [undefined,"max_tokens","max_output_tokens","max_completion_tokens"]){
    const body={model:grant.model,...(operation==="responses"?{input:"hello"}:{messages:[{role:"user",content:"hello"}]}),...(limit?{[limit]:8}:{})};
    const result=JSON.parse(Buffer.from(managedProviderRequest({...grant,providerId,operation},Buffer.from(JSON.stringify(body)))).toString());
    const expected=providerId==="openai"?"max_completion_tokens":"max_tokens";
    assert.equal(result[expected],limit?8:10);
    assert.equal(result[providerId==="openai"?"max_tokens":"max_completion_tokens"],undefined);
    assert.equal(result.max_output_tokens,undefined);
    assert.equal(result.model,grant.upstreamModel);
   }
  }
 }
});
test("all supplied limit aliases must agree and fit the grant",()=>{
 for(const limits of [
  {max_tokens:5,max_output_tokens:6},
  {max_tokens:11,max_completion_tokens:5},
  {max_tokens:null,max_completion_tokens:5},
  {max_tokens:5,max_completion_tokens:"5"},
  {max_tokens:0},{max_output_tokens:-1},{max_completion_tokens:1.5},
 ])assert.throws(()=>managedProviderRequest(grant,Buffer.from(JSON.stringify({model:grant.model,...limits}))),/output_limit_mismatch/);
 const matching={model:grant.model,max_tokens:5,max_output_tokens:5,max_completion_tokens:5};
 assert.equal(JSON.parse(Buffer.from(managedProviderRequest({...grant,providerId:"openai"},Buffer.from(JSON.stringify(matching)))).toString()).max_completion_tokens,5);
});

test("managed requests cannot select an unquoted service tier",()=>{
 for(const operation of ["responses","chat_completions"] as const){
  for(const service_tier of ["priority","fast","flex","auto","scale",null,5]){
   assert.throws(()=>managedProviderRequest({...grant,providerId:"openai",operation},Buffer.from(JSON.stringify({model:grant.model,service_tier}))),/service_tier_not_authorized/);
  }
  for(const service_tier of [undefined,"default"]){
   const body=Buffer.from(JSON.stringify({model:grant.model,input:"hello",messages:[],service_tier}));
   assert.equal(JSON.parse(Buffer.from(managedProviderRequest({...grant,providerId:"openai",operation},body)).toString()).service_tier,"default");
   assert.equal(JSON.parse(Buffer.from(managedProviderRequest({...grant,operation},body)).toString()).service_tier,undefined);
  }
 }
});
