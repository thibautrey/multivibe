import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnifiedModelCatalog } from "./catalog.js";
import { SOURCE_URLS, MODELS_DEV_V2_URL, normalizeSource } from "./sources.js";
import { parseProfiles } from "./python-literal.js";

const profilePath = "libs/partners/openai/langchain_openai/data/_profiles.py";
const python = '_PROFILES: dict = {"reasoner": {"text_inputs": True, "text_outputs": True, "reasoning_output": True, "reasoning_effort_levels": ["low", "high"], "reasoning_effort_default": "high", "max_output_tokens": 1234,},}\n';
function fixtures(url: string): Response {
  if (url === SOURCE_URLS["models.dev"]) return Response.json({ openai: { models: { reasoner: { id: "reasoner", canonical_model_id: "lab/reasoner", name: "Reasoner", reasoning: true, reasoning_options: [{type: "effort", values: ["low", "high"]}], limit: {context: 10000}, modalities: {input:["text"],output:["text"]}, cost:{input:2,output:5}, new_public_fact:"preserved" } } }, other: {models:{ reasoner:{id:"reasoner",reasoning:false} }} });
  if (url === MODELS_DEV_V2_URL) return Response.json({openai:{models:{reasoner:{capabilities:{reasoning:{supported:true,default:{type:"effort",value:"high"}}}}}}});
  if (url === SOURCE_URLS.litellm) return Response.json({ reasoner: {litellm_provider:"openai",supports_reasoning:true,supports_function_calling:true,max_output_tokens:2000,reasoning_effort_levels:["low","medium","high"]} });
  if (url === SOURCE_URLS.pi) return Response.json({openai:{reasoner:{id:"reasoner",name:"Reasoner",reasoning:true,input:["text"],thinkingLevelMap:{low:"low",high:"high",xhigh:null},contextWindow:12000,maxTokens:4000}}});
  if (url === SOURCE_URLS.langchain) return Response.json({sha:"abc123",tree:[{path:profilePath}]});
  if (url === `https://raw.githubusercontent.com/langchain-ai/langchain/abc123/${profilePath}`) return new Response(python);
  throw Error(`Unexpected URL ${url}`);
}

test("four source records consolidate once with provenance, conflicts and provider isolation", async () => {
  let requests = 0;
  const catalog = new UnifiedModelCatalog({fetch:(async u => { requests++;return fixtures(String(u)); }) as typeof fetch});
  const results = await Promise.all([catalog.refresh(),catalog.refresh()]);
  assert.deepEqual(results,[true,true]); assert.equal(requests,6);
  const model = catalog.catalogFor("openai")!.models[0] as any;
  assert.deepEqual(model.efforts,["low","high"]); assert.equal(model.defaultEffort,"high");
  assert.equal(model.context,10000); assert.equal(model.output,1234); assert.equal(model.tools,true);
  assert.equal(model.knowledge.sources.length,4); assert.equal(model.knowledge.canonicalId,"lab/reasoner");
  assert.equal(model.knowledge.sources[0].data.new_public_fact,"preserved");
  assert.equal(model.knowledge.conflicts.output.length,3);
  assert.equal(catalog.catalogFor("other")!.models[0].reasoning,false);
  assert.equal(catalog.catalogFor("not-a-provider"),undefined);
  assert.equal(Object.keys(catalog.state().sources).length,4);
});

test("partial outages preserve last good contributions across refresh and restart", async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),"unified-models-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const cachePath=path.join(root,"catalog.json"); let down=false;
  const fetcher=(async u => {if(down && String(u)===SOURCE_URLS.litellm) return new Response("down",{status:503}); return fixtures(String(u));}) as typeof fetch;
  const catalog=new UnifiedModelCatalog({fetch:fetcher,cachePath});
  assert.equal(await catalog.refresh(),true); down=true; assert.equal(await catalog.refresh(),true);
  assert.equal(catalog.state().stale,true);
  assert.equal(catalog.state().sources.litellm.modelCount,1);
  assert.equal((catalog.catalogFor("openai")!.models[0] as any).knowledge.sources.length,4);
  const disk=JSON.parse(await readFile(cachePath,"utf8")); assert.equal(disk.unifiedVersion,1);
  assert.equal(disk.providers.openai[0].knowledge.sources.length,4);
  const restored=new UnifiedModelCatalog({cachePath,fetch:(async()=>{throw Error("offline");}) as typeof fetch});
  await restored.ensure(); assert.equal(restored.catalogFor("openai")!.models[0].output,1234);
  assert.equal(await restored.refresh(),false);
  assert.equal((restored.catalogFor("openai")!.models[0] as any).knowledge.sources.length,4);
});

test("Python profile reader accepts literals and rejects executable or trailing code",()=>{
  assert.deepEqual(Object.keys(parseProfiles(python)),["reasoner"]);
  for(const payload of ['_PROFILES = __import__("os").system("echo unsafe")',python+'print("unsafe")','_PROFILES = {"a": object()}']) assert.throws(()=>parseProfiles(payload));
});

test("unknown capabilities stay unknown and isolated flags do not invent a complete effort list",()=>{
  const [record]=normalizeSource("litellm",{r:{litellm_provider:"openai",supports_xhigh_reasoning_effort:true}},1);
  assert.equal(record.facts.reasoning,undefined);assert.equal(record.facts.efforts,undefined);
  assert.equal(record.data.supports_xhigh_reasoning_effort,true);
  const [pi]=normalizeSource("pi",{openai:{r:{reasoning:true}}},1);
  assert.equal(pi.facts.efforts,undefined);
  const [partial]=normalizeSource("pi",{anthropic:{r:{reasoning:true,thinkingLevelMap:{max:"max"}}}},1);
  assert.equal(partial.facts.efforts,undefined);
});

test("oversized, malformed and empty source payloads keep catalog unavailable rather than fabricate models",async()=>{
  for (const response of [()=>new Response("invalid"),()=>Response.json({}),()=>new Response("x".repeat(24*1024*1024+1))]) {
    const catalog=new UnifiedModelCatalog({fetch:(async()=>response()) as typeof fetch});
    assert.equal(await catalog.refresh(),false); assert.equal(catalog.catalogFor("openai"),undefined);
  }
});


test("analytics readers reload the shared database without fetching or overwriting it", async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),"catalog-reader-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const cachePath=path.join(root,"models.json");
  const writer=new UnifiedModelCatalog({cachePath,fetch:(async u=>fixtures(String(u))) as typeof fetch});await writer.refresh();
  const before=await readFile(cachePath,"utf8");let requests=0;
  const reader=new UnifiedModelCatalog({cachePath,readOnly:true,fetch:(async()=>{requests++;throw Error("no network");}) as typeof fetch});
  await reader.ensure();await reader.refresh();assert.equal(requests,0);
  assert.equal(reader.catalogFor("openai")?.models[0].output,1234);assert.equal(await readFile(cachePath,"utf8"),before);
});

test("stable models.dev data survives optional v2 failure and exposes all four contributions to SDK consumers",async()=>{
  const {sdkAccountModels}=await import('../ai-sdk/catalog.js');
  const catalog=new UnifiedModelCatalog({fetch:(async u=>String(u)===MODELS_DEV_V2_URL ? new Response("unavailable",{status:503}) : fixtures(String(u))) as typeof fetch});
  assert.equal(await catalog.refresh(),true);
  const models=sdkAccountModels({id:"fixture",provider:"ai-sdk",sdkProvider:"openai",sdkModels:["reasoner"],enabled:true} as any,undefined,catalog);
  assert.equal(models[0].supports_reasoning,true);
  assert.deepEqual(models[0].reasoning_options?.find(o=>o.type==="effort")?.values,["low","high"]);
  assert.equal(models[0].default_reasoning_level,"high");
  assert.equal(models[0].model_knowledge?.sources.length,4);
  assert.equal(models[0].model_knowledge?.sources[0].data.new_public_fact,"preserved");
});


test("upgrade retains legacy cache metadata when every external source is unavailable",async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"legacy-models-"));t.after(()=>rm(root,{recursive:true,force:true}));const cachePath=path.join(root,"catalog.json");
 await writeFile(cachePath,JSON.stringify({version:2,fetchedAt:123456,providers:{openai:[{id:"legacy",name:"Legacy",input:["text"],reasoning:true,context:128000,cost:{input:2,output:3}}]}}));
 const catalog=new UnifiedModelCatalog({cachePath,fetch:(async()=>{throw Error("offline");}) as typeof fetch});
 await catalog.ensure();assert.equal(catalog.catalogFor("openai")?.models[0].context,128000);
 assert.equal(await catalog.refresh(),false);assert.equal(catalog.catalogFor("openai")?.models[0].cost?.input,2);
 assert.equal(catalog.state().stale,true);
});
