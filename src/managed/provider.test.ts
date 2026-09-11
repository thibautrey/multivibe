import test from "node:test";
import assert from "node:assert/strict";
import { createManagedProviderAccount } from "./provider.js";
test("discovery and execution use the same fixed provider corridor with one credential resolution per request", async () => {
  const calls: string[] = [];
  let reads = 0;
  const account = createManagedProviderAccount({ providerId: "mistral", credentialRef: "account-1", models: new Set(["model"]),
    readCredential: async () => { reads++; return "fixture-key"; },
    fetchViaEgress: (async (url, init) => {
      calls.push(String(url));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
      assert.equal(init?.redirect, "error");
      return Response.json({ data: [{ id: "model" }, { id: "model" }] });
    }) as typeof fetch,
  });
  assert.deepEqual(await account.discoverModels(AbortSignal.timeout(1000)), ["model"]);
  await account.chatCompletions(Buffer.from("{}"), AbortSignal.timeout(1000), {token:"unused-direct-connector-fixture",originalBody:Buffer.from("{}"),
    ownership:{ownerId:"11111111-1111-4111-8111-111111111111",epoch:1},async beforeDispatch(){}});
  assert.deepEqual(calls, ["https://api.mistral.ai/v1/models", "https://api.mistral.ai/v1/chat/completions"]);
  assert.equal(reads, 2);
});
test("upstream errors expose only bounded status classes and never retry", async () => {
  for (const [status, failure] of [[401, "authentication_rejected"], [403, "authentication_rejected"],
    [404, "endpoint_unavailable"], [429, "rate_limited"], [500, "upstream_unavailable"],
    [418, "unavailable"]] as const) {
    let calls = 0;
    const account = createManagedProviderAccount({ providerId: "mistral", credentialRef: "account-1", models: new Set(),
      readCredential: async () => "fixture-key", fetchViaEgress: (async () => {
        calls++; return new Response("secret diagnostic", { status });
      }) as typeof fetch });
    await assert.rejects(account.discoverModels(AbortSignal.timeout(1000)),
      new RegExp(`^Error: provider_discovery_${failure}$`));
    assert.equal(calls, 1);
  }
});

test("native discovery follows bounded Anthropic cursors and deduplicates complete inventory",async()=>{
 const urls:string[]=[];
 const account=createManagedProviderAccount({providerId:"anthropic",credentialRef:"account",models:new Set(),async readCredential(){return "fixture-key";},fetchViaEgress:async(url)=>{
  urls.push(String(url));return urls.length===1?Response.json({data:[{id:"model-z"},{id:"model/a"}],has_more:true,last_id:"model/a"}):Response.json({data:[{id:"model/a"},{id:"model-b"}],has_more:false,last_id:"model-b"});
 }});
 assert.deepEqual(await account.discoverModels(AbortSignal.timeout(1000)),["model-b","model-z","model/a"]);
 assert.deepEqual(urls,["https://api.anthropic.com/v1/models","https://api.anthropic.com/v1/models?after_id=model%2Fa"]);
});
test("native discovery rejects missing, mismatched and looping cursors without returning partial models",async()=>{
 for(const payload of [{data:[{id:"model"}]},{data:[],has_more:true,last_id:"model"},{data:[{id:"model"}],has_more:true,last_id:"other"},{data:[{id:"model"}],has_more:true,last_id:"model"}]){
  let calls=0;
  const account=createManagedProviderAccount({providerId:"anthropic",credentialRef:"account",models:new Set(),async readCredential(){return "fixture-key";},fetchViaEgress:async()=>{calls++;return Response.json(payload);}});
  await assert.rejects(account.discoverModels(AbortSignal.timeout(1000)),/provider_discovery_invalid/);
  assert.ok(calls<=2);
 }
});
test("native discovery has an aggregate byte limit and aborts without additional credential reads",async()=>{
 let calls=0,reads=0;
 const controller=new AbortController();
 const account=createManagedProviderAccount({providerId:"anthropic",credentialRef:"account",models:new Set(),async readCredential(){reads++;return "fixture-key";},fetchViaEgress:async()=>{
  calls++;return Response.json({data:[{id:`model-${calls}`}],padding:"x".repeat(1100000),has_more:true,last_id:`model-${calls}`});
 }});
 await assert.rejects(account.discoverModels(controller.signal),/discovery_too_large/);assert.equal(calls,2);
 controller.abort();await assert.rejects(account.discoverModels(controller.signal));assert.equal(reads,2);
});
test("discovery refuses page/model ceilings and a failed later page",async()=>{
 for(const scenario of ["pages","models","later-error"]){
  let calls=0;
  const account=createManagedProviderAccount({providerId:"anthropic",credentialRef:"account",models:new Set(),async readCredential(){return "fixture-key";},fetchViaEgress:async()=>{
   calls++;
   if(scenario==="later-error"&&calls===2)return new Response("private diagnostic",{status:503});
   const data=Array.from({length:scenario==="models"?6000:1},(_,i)=>({id:`model-${calls}-${i}`}));
   return Response.json({data,has_more:true,last_id:data.at(-1)!.id});
  }});
  await assert.rejects(account.discoverModels(AbortSignal.timeout(3000)),/provider_discovery_(incomplete|too_large|unavailable)/);
  assert.equal(calls,scenario==="pages"?100:2);
 }
});
