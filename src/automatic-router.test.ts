import assert from "node:assert/strict";
import test from "node:test";
import { createAutomaticRouter, automaticRouterManifest } from "./automatic-router.js";
import { AUTOMATIC_ROUTER_MODEL } from "./automatic-router-model.js";
import { inspectModuleConversation } from "./module-conversation.js";
import type { ModuleContext } from "./module-sdk.js";

const body = { model: AUTOMATIC_ROUTER_MODEL, messages: [{ role: "user", content: "Explain addition" }] };
function setup() {
  let calls = 0; let reply = '{"difficulty":"easy"}';
  const context: ModuleContext = {
    requestId: "r", application: "app", route: "/chat/completions", transport: "http", signal: new AbortController().signal,
    settings: { ...automaticRouterManifest.defaultSettings, classifierModel: "classifier", economyModel: "cheap", balancedModel: "mid", advancedModel: "big" },
    conversation: inspectModuleConversation(body, {}),
    log: { info() {}, warn() {}, error() {} },
    services: {
      listModels: async () => ["classifier", "cheap", "mid", "big", "original"].map((id) => ({ id, metadata: { supports_tools: true, context_window: 100_000 } })),
      complete: async () => { calls++; return reply; },
    },
  };
  return { context, hook: createAutomaticRouter()["request.received"]!, calls: () => calls, reply: (value: string) => { reply = value; } };
}
test("virtual model selects difficulty tiers for plain API requests and leaves explicit models alone", async () => {
  const s = setup();
  for (const [difficulty, model] of [["easy", "cheap"], ["medium", "mid"], ["hard", "big"]]) {
    s.reply(JSON.stringify({ difficulty }));
    assert.deepEqual(await s.hook(body, s.context), { action: "replace", value: { ...body, model } });
  }
  assert.equal(body.model, AUTOMATIC_ROUTER_MODEL);
  assert.deepEqual(await s.hook({...body, model:"original"},s.context),{action:"continue"});
  s.context.internal=true;
  assert.deepEqual(await s.hook(body,s.context),{action:"continue"});
  assert.equal(s.calls(),3);
});
test("multi-turn routing reuses model and rejects unknown continuations", async () => {
  const s=setup();s.context.conversation=inspectModuleConversation(body,{"x-multivibe-conversation-mode":"multi-turn"},"session");
  await s.hook(body,s.context);s.reply('{"difficulty":"hard"}');
  const continuation={...body,previous_response_id:"resp_1"};
  s.context.conversation=inspectModuleConversation(continuation,{},"session");
  assert.deepEqual(await s.hook(continuation,s.context),{action:"replace",value:{...continuation,model:"cheap"}});
  assert.equal(s.calls(),1);
  s.context.application="other";
  const result=await s.hook(continuation,s.context);
  assert.equal(result.action,"respond"); if(result.action==="respond")assert.equal(result.response.status,409);
});
test("malformed classification and classifier failure use sticky balanced fallback", async () => {
  const s=setup();s.context.conversation=inspectModuleConversation(body,{},"session");s.reply("invalid");
  assert.deepEqual(await s.hook(body,s.context),{action:"replace",value:{...body,model:"mid"}});
  s.context.conversation={...s.context.conversation,phase:"continuation"};
  assert.equal((await s.hook(body,s.context)).action,"replace");assert.equal(s.calls(),1);
  const failure=setup();failure.context.services!.complete=async()=>{throw new Error("offline")};
  assert.deepEqual(await failure.hook(body,failure.context),{action:"replace",value:{...body,model:"mid"}});
});
test("missing targets, recursive configuration and unsupported inputs never pass the virtual name upstream",async()=>{
  for(const change of [{economyModel:"missing"},{classifierModel:AUTOMATIC_ROUTER_MODEL},{balancedModel:AUTOMATIC_ROUTER_MODEL}]){
    const s=setup();s.context.settings={...s.context.settings,...change};assert.equal((await s.hook(body,s.context)).action,"respond");assert.equal(s.calls(),0);
  }
  const s=setup();s.context.route="/responses/compact";assert.equal((await s.hook(body,s.context)).action,"respond");
  s.context.route="/responses";s.context.conversation=inspectModuleConversation({tools:[{}]},{});
  assert.equal((await s.hook(body,s.context)).action,"respond");
  const image=setup();assert.equal((await image.hook({...body,messages:[{role:"user",content:[{type:"image_url"}]}]},image.context)).action,"respond");
});
test("parallel calls share classifier and settings changes invalidate affinity",async()=>{
  const s=setup();s.context.conversation=inspectModuleConversation(body,{},"session");
  await Promise.all([s.hook(body,s.context),s.hook(body,s.context)]);assert.equal(s.calls(),1);
  s.context.settings={...s.context.settings,economyModel:"mid"};await s.hook(body,s.context);assert.equal(s.calls(),2);
});
test("Responses text and tool requests require a compatible model and stable session",async()=>{
  const s=setup();const request={model:AUTOMATIC_ROUTER_MODEL,input:[{role:"user",content:[{type:"input_text",text:"Fix parser"}]}],tools:[{type:"function",name:"read_file"}]};
  s.context.route="/responses";s.context.conversation=inspectModuleConversation(request,{},"session");
  assert.equal((await s.hook(request,s.context)).action,"replace");
  s.context.conversation=inspectModuleConversation(request,{},"another-session");
  s.context.services!.listModels=async()=>["classifier","cheap","mid","big"].map(id=>({id,metadata:{supports_tools:false,context_window:100000}}));
  assert.equal((await s.hook(request,s.context)).action,"respond");
});
test("aborted classifier cannot establish affinity",async()=>{
  const s=setup();const controller=new AbortController();s.context.signal=controller.signal;s.context.conversation=inspectModuleConversation(body,{},"cancelled");
  s.context.services!.complete=async()=>{controller.abort();return '{"difficulty":"easy"}';};
  assert.equal((await s.hook(body,s.context)).action,"respond");
  s.context.signal=new AbortController().signal;s.context.conversation={...s.context.conversation,phase:"continuation"};
  assert.equal((await s.hook(body,s.context)).action,"respond");
});
