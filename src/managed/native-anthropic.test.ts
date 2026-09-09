import test from "node:test";
import assert from "node:assert/strict";
import {createManagedAnthropicAccount} from "./native-anthropic.js";
import {providerTokenUsage} from "./usage.js";
const body=Buffer.from(JSON.stringify({model:"claude-sonnet-4-6",messages:[{role:"user",content:"Hello"}],max_tokens:25}));
const authorization={token:"fixture",originalBody:body};
test("native managed connector reuses Anthropic SDK codec with bounded credential egress",async()=>{
 let calls=0,reads=0;
 const account=createManagedAnthropicAccount({credentialRef:"account",models:new Set(["claude-sonnet-4-6"]),async readCredential(){reads++;return "fixture-key";},
 fetchViaEgress:async(url,init)=>{
  calls++;assert.equal(String(url),"https://api.anthropic.com/v1/messages");assert.equal(new Headers(init?.headers).get("x-api-key"),"fixture-key");
  assert.equal(init?.redirect,"error");const native=JSON.parse(String(init?.body));assert.equal(native.max_tokens,25);assert.equal(native.messages[0].content[0].text,"Hello");
  return Response.json({id:"msg_fixture",type:"message",role:"assistant",model:native.model,content:[{type:"text",text:"Hi"}],stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:5,output_tokens:2}});
 }});
 const result=await account.chatCompletions(body,AbortSignal.timeout(1000),authorization);
 const payload=await result.json();assert.equal(payload.choices[0].message.content,"Hi");assert.equal(payload.provider_metadata,undefined);
 assert.deepEqual(providerTokenUsage(payload),{inputTokens:"5",outputTokens:"2",totalTokens:"7",cachedInputTokens:"0"});
 assert.equal(calls,1);assert.equal(reads,1);
});
test("invalid native options never read a credential; upstream failure is not retried",async()=>{
 let calls=0,reads=0;
 const account=createManagedAnthropicAccount({credentialRef:"account",models:new Set(["claude-sonnet-4-6"]),async readCredential(){reads++;return "fixture-key";},fetchViaEgress:async()=>{calls++;return new Response("unavailable",{status:503});}});
 for(const fields of [{model:"another"},{provider_options:{}},{tools:[]},{service_tier:"priority"},{max_tokens:0},{messages:[{role:"user",content:[{type:"image_url",image_url:{url:"https://private.invalid"}}]}]}]){
  await assert.rejects(account.chatCompletions(Buffer.from(JSON.stringify({...JSON.parse(body.toString()),...fields})),AbortSignal.timeout(1000),authorization));
 }
 assert.equal(reads,0);assert.equal(calls,0);
 await assert.rejects(account.chatCompletions(body,AbortSignal.timeout(1000),authorization));
 assert.equal(reads,1);assert.equal(calls,1);
});
