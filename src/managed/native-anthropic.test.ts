import test from "node:test";
import assert from "node:assert/strict";
import {createManagedAnthropicAccount} from "./native-anthropic.js";
import {createManagedProviderAccount} from "./provider.js";
import {providerTokenUsage} from "./usage.js";
const body=Buffer.from(JSON.stringify({model:"claude-sonnet-4-6",messages:[{role:"user",content:"Hello"}],max_tokens:25}));
const authorization={token:"fixture",originalBody:body};
test("native managed connector reuses Anthropic SDK codec with bounded credential egress",async()=>{
 let calls=0,reads=0;
 const account=createManagedAnthropicAccount({credentialRef:"account",maximumResponseBytes:8192,models:new Set(["claude-sonnet-4-6"]),async readCredential(){reads++;return "fixture-key";},
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
 const account=createManagedAnthropicAccount({credentialRef:"account",maximumResponseBytes:8192,models:new Set(["claude-sonnet-4-6"]),async readCredential(){reads++;return "fixture-key";},fetchViaEgress:async()=>{calls++;return new Response("unavailable",{status:503});}});
 for(const fields of [{model:"another"},{provider_options:{}},{tools:[]},{service_tier:"priority"},{max_tokens:0},{messages:[{role:"user",content:[{type:"image_url",image_url:{url:"https://private.invalid"}}]}]}]){
  await assert.rejects(account.chatCompletions(Buffer.from(JSON.stringify({...JSON.parse(body.toString()),...fields})),AbortSignal.timeout(1000),authorization));
 }
 assert.equal(reads,0);assert.equal(calls,0);
 await assert.rejects(account.chatCompletions(body,AbortSignal.timeout(1000),authorization));
 assert.equal(reads,1);assert.equal(calls,1);
});

test("native response bytes are bounded before SDK buffering",async()=>{
 const account=createManagedAnthropicAccount({credentialRef:"account",maximumResponseBytes:32,models:new Set(["claude-sonnet-4-6"]),async readCredential(){return "fixture-key";},fetchViaEgress:async()=>new Response("x".repeat(100))});
 await assert.rejects(account.chatCompletions(body,AbortSignal.timeout(1000),authorization));
});
test("native Anthropic SSE reuses the SDK streaming codec and preserves usage",async()=>{
 const events=[
  ["message_start",{type:"message_start",message:{id:"msg_stream",type:"message",role:"assistant",model:"claude-sonnet-4-6",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}}],
  ["content_block_start",{type:"content_block_start",index:0,content_block:{type:"text",text:""}}],
  ["content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Hi"}}],
  ["content_block_stop",{type:"content_block_stop",index:0}],
  ["message_delta",{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:2}}],
  ["message_stop",{type:"message_stop"}],
 ];
 let calls=0;
 const account=createManagedAnthropicAccount({credentialRef:"account",maximumResponseBytes:8192,models:new Set(["claude-sonnet-4-6"]),async readCredential(){return "fixture-key";},fetchViaEgress:async(_url,init)=>{
  calls++;assert.equal(JSON.parse(String(init?.body)).stream,true);
  return new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
 }});
 const result=await account.chatCompletions(Buffer.from(JSON.stringify({...JSON.parse(body.toString()),stream:true})),AbortSignal.timeout(1000),authorization);
 const text=await result.text();assert.match(text,/Hi/);assert.match(text,/\[DONE\]/);
 const usageFrame=text.split("\n\n").filter(line=>line.startsWith("data: {")).map(line=>JSON.parse(line.slice(6))).find(frame=>frame.usage);
 assert.equal(usageFrame.usage.prompt_tokens,5);assert.equal(usageFrame.usage.completion_tokens,2);assert.equal(calls,1);
});

test("registered native account uses Anthropic discovery authentication",async()=>{
 let requests=0;
 const account=createManagedProviderAccount({providerId:"anthropic",credentialRef:"account",models:new Set(["claude-sonnet-4-6"]),maximumResponseBytes:8192,async readCredential(){return "fixture-key";},fetchViaEgress:async(url,init)=>{
  requests++;assert.equal(String(url),"https://api.anthropic.com/v1/models");
  assert.equal(new Headers(init?.headers).get("x-api-key"),"fixture-key");
  assert.equal(new Headers(init?.headers).get("anthropic-version"),"2023-06-01");
  assert.equal(new Headers(init?.headers).get("authorization"),null);
  return Response.json({data:[{id:"claude-sonnet-4-6"}],has_more:false});
 }});
 assert.deepEqual(await account.discoverModels(AbortSignal.timeout(1000)),["claude-sonnet-4-6"]);assert.equal(requests,1);
});
