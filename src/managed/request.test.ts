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
