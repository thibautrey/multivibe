import test from "node:test";
import assert from "node:assert/strict";
import {createSdkModel} from "./models.js";
import {googleUsageEligible} from "./google-usage.js";
import {sdkCallOptions,chatResult,chatStream} from "./protocol.js";
const base={promptTokenCount:5,candidatesTokenCount:2,thoughtsTokenCount:3,totalTokenCount:10};
test("real Google SDK cannot turn missing or discarded native usage into priced totals",async()=>{
 for(const [usageMetadata,valid] of [
  [base,true],[{promptTokenCount:5,candidatesTokenCount:2,totalTokenCount:7},true],
  [{candidatesTokenCount:2,totalTokenCount:2},false],
  [{promptTokenCount:5,totalTokenCount:5},false],
  [{...base,totalTokenCount:11},false],
  [{...base,toolUsePromptTokenCount:1},false],
  [{...base,cachedContentTokenCount:6},false],
 ] as const){
  const model=createSdkModel({id:"fixture",provider:"ai-sdk",sdkProvider:"google",accessToken:"fixture",enabled:true},"test",
   async()=>Response.json({candidates:[{content:{role:"model",parts:[{text:"Hi"}]},finishReason:"STOP"}],usageMetadata}));
  const generated=await model.doGenerate(sdkCallOptions({messages:[{role:"user",content:"Hi"}],max_tokens:10},new AbortController().signal));
  const result=chatResult("google/test",generated,googleUsageEligible);
  assert.equal(result.usage!==null,valid,JSON.stringify(usageMetadata));
  const stream=new ReadableStream({start(controller){controller.enqueue({type:"finish" as const,usage:generated.usage,finishReason:generated.finishReason});controller.close();}});
  const frames=[];for await(const frame of chatStream("google/test",stream,true,googleUsageEligible))frames.push(frame);
  const usageFrame=frames.find(frame=>frame.includes('"usage":'));
  assert.ok(usageFrame);
  assert.equal(usageFrame.includes('"usage":null'),!valid);
 }
});
