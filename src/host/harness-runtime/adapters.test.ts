import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpAdapter, PiAdapter, CodexAdapter, ClaudeAdapter, OpenCodeAdapter } from "./adapters.js";
import { capabilities, type AdapterContext, type AdapterEvent, type HarnessSession } from "./types.js";

const fixtureProgram=String.raw`#!/usr/bin/env node
const fs=require('node:fs');const readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const codex=process.argv.includes('app-server');let compacting=false,thinkingLevel='low';
const effortConfig=value=>[{id:'thought',category:'thought_level',type:'select',currentValue:value,options:[{value:'low',name:'Light'},{value:'ultra',name:'Thorough'}]}];
const reply=(v,result)=>send(v.type?{type:'response',id:v.id,command:v.type,success:true,data:result}:{jsonrpc:'2.0',id:v.id,result});
const notify=(method,params)=>send({jsonrpc:'2.0',method,params});
if(process.argv.includes('serve')){
 const http=require('node:http');let stream;const expected='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
 const server=http.createServer(async(req,res)=>{
  if(req.headers.authorization!==expected){res.writeHead(401).end();return;}
  if(req.url.startsWith('/event')){stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();return;}
  if(req.url.startsWith('/session') && req.method==='POST' && !req.url.includes('/prompt_async')){res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'open-session'}));return;}
  if(req.url.startsWith('/provider')){res.setHeader('content-type','application/json');res.end(JSON.stringify({connected:['native'],all:[{id:'native',models:{reasoner:{variants:{low:{},deep:{}}}}}]}));return;}
  if(req.url.includes('/prompt_async')){
   let raw='';for await(const part of req)raw+=part;fs.writeFileSync('prompt.json',raw);
   res.writeHead(204).end();setTimeout(()=>{
    for(const v of [{type:'message.updated',properties:{info:{id:'u',sessionID:'open-session',role:'user'}}},{type:'message.part.updated',properties:{part:{id:'up',messageID:'u',sessionID:'open-session',type:'text',text:'MUST NOT ECHO USER'}}},{type:'message.part.updated',properties:{part:{id:'p',sessionID:'another-session',type:'text',text:'MUST NOT LEAK'}}},{type:'message.updated',properties:{info:{id:'a',sessionID:'open-session',role:'assistant'}}},{type:'message.part.updated',properties:{part:{id:'p',messageID:'a',sessionID:'open-session',type:'text',text:'hello'}}},{type:'session.status',properties:{sessionID:'open-session',status:{type:'idle'}}}])stream.write('data: '+JSON.stringify(v)+'\n\n');
   },15);return;
  }
  res.setHeader('content-type','application/json');res.end('{}');
 });server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));
}else readline.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line),m=v.method??v.type,p=v.params??v;
 fs.appendFileSync('requests.jsonl',JSON.stringify({method:m,params:p})+'\n');
 if(m==='initialize')reply(v,codex?{}:{protocolVersion:1,agentInfo:process.env.LLM_PROVIDER?{name:[process.env.LLM_PROVIDER,process.env.LLM_MODEL,process.env.OPENAI_BASE_URL,process.env.CUSTOM_BASE_URL,process.env.OPENAI_API_KEY==='fixture-proxy-key'].join('|')}:undefined,agentCapabilities:{loadSession:true,promptCapabilities:{embeddedContext:!process.argv.includes('no-resources')}}});
 else if(m==='session/new')reply(v,{sessionId:'acp-session',models:{currentModelId:process.env.LLM_MODEL??'native-default',availableModels:[{modelId:process.env.LLM_MODEL??'native-default',name:'Native'}]},...(process.argv.includes('effort')?{configOptions:effortConfig('low')}:{})});
 else if(m==='session/set_config_option')reply(v,{configOptions:effortConfig(p.value)});
 else if(m==='session/set_model')reply(v,{selected:p.modelId});
 else if(m==='model/list')reply(v,p.cursor?{data:[{id:'second',model:'second'}]}:{data:[{id:'first',model:'first',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Fast'},{reasoningEffort:'ultra',description:'Thorough'}],defaultReasoningEffort:'low'}],nextCursor:'page-two'});
 else if(m==='thread/start')reply(v,{thread:{id:'codex-thread'}});
 else if(m==='session/prompt'){
  if(process.argv.includes('echo-prompt')){notify('session/update',{sessionId:'acp-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(p.prompt)}}});reply(v,{stopReason:'end_turn'});return;}
  notify('session/update',{sessionId:'acp-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP text'}}});
  send({jsonrpc:'2.0',id:'approval',method:'session/request_permission',params:{sessionId:'acp-session',toolCall:{title:'write'},options:[{optionId:'deny',kind:'reject_once'}]}});
  global.prompt=v;
 }else if(v.id==='approval'){
  if(v.result.outcome.optionId!=='deny')process.exit(9);
  notify('session/update',{sessionId:'acp-session',update:{sessionUpdate:'tool_call_update',toolCallId:'tool',status:'failed'}});reply(global.prompt,{stopReason:'end_turn'});
 }else if(m==='get_available_thinking_levels')reply(v,{levels:['off','low','high']});
 else if(m==='set_thinking_level'){thinkingLevel=p.level;reply(v,{level:thinkingLevel});}
 else if(m==='get_state')reply(v,{thinkingLevel,sessionFile:'/tmp/pi-fixture.jsonl',isStreaming:false,isCompacting:compacting,pendingMessageCount:0});
 else if(m==='prompt'){
  if(p.message==='interrupt'){reply(v,{});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'partial'}});return;}
  if(p.message==='reject'){reply(v,{});send({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'401 authentication required'}});send({type:'agent_settled'});return;}
  reply(v,{});compacting=true;
  send({type:'extension_ui_request',id:'ui-confirm',method:'confirm',title:'Continue?'});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi text'}});send({type:'agent_end'});
  setTimeout(()=>{compacting=false;send({type:'compaction_end',result:{summary:'retained'}});send({type:'agent_settled'});},25);
 }else if(m==='turn/start'){
  if(p.input[0]?.text==='final-only'){reply(v,{turn:{id:'final-turn'}});notify('item/completed',{threadId:'codex-thread',item:{type:'agentMessage',id:'final-message',text:'Authoritative final text',phase:'final_answer'}});notify('turn/completed',{threadId:'codex-thread',turn:{id:'final-turn',status:'completed'}});return;}
  reply(v,{turn:{id:'native-turn'}});notify('turn/started',{threadId:'codex-thread',turn:{id:'native-turn'}});notify('item/agentMessage/delta',{threadId:'codex-thread',itemId:'a',delta:'Codex text'});
 }else if(m==='turn/steer'){
  if(p.expectedTurnId!=='native-turn')process.exit(8);reply(v,{turnId:'native-turn'});notify('turn/completed',{threadId:'codex-thread',turn:{id:'native-turn',status:'completed'}});
 }else if(m==='thread/compact/start'){reply(v,{});setTimeout(()=>notify('thread/compacted',{threadId:'codex-thread'}),25);}
 else if(v.id && m!=='initialized')reply(v,{});
});
`;
function fixture(t:any,harnessId:string) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-adapter-test-"));const executable=path.join(root,"harness.cjs");fs.writeFileSync(executable,fixtureProgram,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const events:AdapterEvent[]=[];const session={id:"test-session",harnessId,targetId:"local",workspace:root,title:"fixture",authMode:"native",state:"idle",queuePaused:false,revision:0,archived:false,pinned:false,createdAt:1,updatedAt:1,capabilities:capabilities()} as HarnessSession;
  const questions:any[]=[];
  const ctx:AdapterContext={session,root,executable,target:{id:"local",name:"test",kind:"local"},emit:e=>events.push(e),nativeSession:id=>{session.nativeSessionId=id;},capabilities:c=>Object.assign(session.capabilities,c),attachment:()=>{throw new Error("not requested");},ask:async(kind,title,detail)=>{questions.push({kind,title,detail});return {optionId:"deny"};}};
  return {ctx,events,questions};
}
test("ACP negotiates capabilities, normalizes events and roundtrips a denied permission",async t=>{
  const f=fixture(t,"hermes-agent");const adapter=new AcpAdapter(f.ctx,["acp"]);t.after(()=>adapter.close());await adapter.start();
  assert.equal(f.ctx.session.capabilities.images.support,"unsupported");assert.equal(f.ctx.session.capabilities.steer.support,"unknown");
  await adapter.prompt([{type:"text",text:"read only"}]);
  assert.equal(f.questions.length,1);assert.ok(f.events.some(e=>e.type==="message.delta" && (e.payload as any).text==="ACP text"));assert.ok(f.events.some(e=>e.type==="tool" && (e.payload as any).status==="failed"));
  await assert.rejects(adapter.prompt([{type:"text",text:"steer"}],true),/steering/u);
});
test("Hermes ACP receives the loopback MultiVibe model connection",async t=>{
  const f=fixture(t,"hermes-agent");f.ctx.session.authMode="multivibe";f.ctx.session.model="gpt-test";
  f.ctx.modelConnection={baseUrl:"http://127.0.0.1:1455/",apiKey:"fixture-proxy-key"};
  const adapter=new AcpAdapter(f.ctx,["acp"]);t.after(()=>adapter.close());await adapter.start();
  const metadata=f.events.find(e=>e.type==="harness.metadata")!;
  assert.equal((metadata.payload as any).name,"openai|gpt-test|http://127.0.0.1:1455/v1|http://127.0.0.1:1455/v1|true");
  assert.deepEqual(await adapter.configure({model:"gpt-other"}),{selected:"custom:gpt-other"});
  assert.equal(f.ctx.session.model,"gpt-other");
  const environment=path.join(f.ctx.root,"hermes-home/.env");
  assert.match(fs.readFileSync(environment,"utf8"),/CUSTOM_BASE_URL="http:\/\/127\.0\.0\.1:1455\/v1"/u);
  assert.equal(fs.statSync(environment).mode & 0o777,0o600);
  assert.equal(fs.lstatSync(environment).isSymbolicLink(),false);
  const config=JSON.parse(fs.readFileSync(path.join(f.ctx.root,"hermes-home/config.yaml"),"utf8"));
  assert.deepEqual(config.model,{provider:"custom",default:"gpt-test",base_url:"http://127.0.0.1:1455/v1",api_mode:"chat_completions"});
  assert.ok(!JSON.stringify(config).includes("fixture-proxy-key"));
  assert.ok(!JSON.stringify(f.events).includes("fixture-proxy-key"));
});
test("Gemini uses the same negotiated ACP contract without assuming extra capabilities",async t=>{
  const f=fixture(t,"gemini-cli");const adapter=new AcpAdapter(f.ctx,["--acp"]);t.after(()=>adapter.close());await adapter.start();await adapter.prompt([{type:"text",text:"hello"}]);assert.equal(f.ctx.session.nativeSessionId,"acp-session");
});
test("ACP text attachments remain usable without embedded resources while binary input stays gated",async t=>{
  const f=fixture(t,"hermes-agent");
  let mimeType="text/plain";
  f.ctx.attachment=()=>({info:{id:"file",name:"notes.txt",mimeType,size:5,sha256:"fixture"},path:"unused",data:Buffer.from("été")});
  const adapter=new AcpAdapter(f.ctx,["no-resources","echo-prompt"]);t.after(()=>adapter.close());await adapter.start();
  for(const mime of ["text/plain","application/json","application/xml","application/javascript"]){
    mimeType=mime;await adapter.prompt([{type:"text",text:"Read the attachment"},{type:"attachment",attachmentId:"file"}]);
    const event=f.events.filter(e=>e.type==="message.delta").at(-1)!;
    assert.deepEqual(JSON.parse((event.payload as any).text),[{type:"text",text:"Read the attachment"},{type:"text",text:"[notes.txt]\nété"}]);
  }
  mimeType="application/pdf";
  await assert.rejects(adapter.prompt([{type:"attachment",attachmentId:"file"}]),/embedded resources/u);
  mimeType="image/png";
  await assert.rejects(adapter.prompt([{type:"attachment",attachmentId:"file"}]),/image input/u);
});
test("ACP preserves embedded text resources when negotiated",async t=>{
  const f=fixture(t,"hermes-agent");
  f.ctx.attachment=()=>({info:{id:"file",name:"notes.txt",mimeType:"text/plain",size:5,sha256:"fixture"},path:"unused",data:Buffer.from("été")});
  const adapter=new AcpAdapter(f.ctx,["echo-prompt"]);t.after(()=>adapter.close());await adapter.start();
  await adapter.prompt([{type:"attachment",attachmentId:"file"}]);
  const event=f.events.find(e=>e.type==="message.delta")!;
  assert.deepEqual(JSON.parse((event.payload as any).text),[{type:"resource",resource:{uri:"attachment:file",mimeType:"text/plain",text:"été"}}]);
});
test("Pi waits for compaction/settlement rather than treating agent_end as completion",async t=>{
  const f=fixture(t,"pi");const adapter=new PiAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();await adapter.prompt([{type:"text",text:"hello"}]);
  const compact=f.events.findIndex(e=>e.type==="compaction");const settled=f.events.findIndex(e=>e.type==="turn.status");assert.ok(compact>=0 && settled>compact);
  assert.ok(f.questions.some(q=>q.title==="Continue?"));
});
test("Pi reports native provider errors as failure instead of successful empty output",async t=>{
  const f=fixture(t,"pi");const adapter=new PiAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();
  await assert.rejects(adapter.prompt([{type:"text",text:"reject"}]),(e:any)=>e.status===422 && /401/u.test(e.message));
});
test("Pi abort does not wait for unsupported queue commands or a separate settlement event",async t=>{
  const f=fixture(t,"pi");const adapter=new PiAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();
  const turn=adapter.prompt([{type:"text",text:"interrupt"}]);const cancelled=assert.rejects(turn,(e:any)=>e.status===499);
  const deadline=Date.now()+2000;while(!f.events.some(e=>e.type==="message.delta")){if(Date.now()>deadline)assert.fail("No partial Pi output");await new Promise(r=>setTimeout(r,10));}
  await adapter.interrupt();await cancelled;assert.equal(adapter.restartAfterInterrupt,true);
});
test("Codex steering targets the actual native turn and manual compaction waits for completion",async t=>{
  const f=fixture(t,"openai-codex");const adapter=new CodexAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();
  const turn=adapter.prompt([{type:"text",text:"hello"}]);
  const deadline=Date.now()+2000;while(!f.events.some(e=>e.type==="message.delta")){if(Date.now()>deadline)assert.fail("No Codex delta");await new Promise(r=>setTimeout(r,10));}
  await adapter.prompt([{type:"text",text:"direction"}],true);await turn;
  await adapter.compact();assert.ok(f.events.some(e=>e.type==="compaction"));
});
test("Codex renders the authoritative completed message when no deltas are emitted",async t=>{
  const f=fixture(t,"openai-codex");const adapter=new CodexAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();await adapter.prompt([{type:"text",text:"final-only"}]);
  assert.ok(f.events.some(e=>e.type==="message.part" && e.itemId==="final-message" && (e.payload as any).text==="Authoritative final text"));
});
test("Claude SDK preserves continuous input and surfaces native usage/tool events",async t=>{
  const f=fixture(t,"claude-code");let settings:any;
  const sdk={query:(options:any)=>{settings=options.options;return {
    async *[Symbol.asyncIterator](){for await(const input of options.prompt){assert.equal(input.message.content[0].text,"hello");yield {type:"system",session_id:"claude-native"};yield {type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"Claude text"}}};yield {type:"result",is_error:false,usage:{input_tokens:2},total_cost_usd:0};}},
    close(){},interrupt:async()=>{},supportedModels:async()=>[],
  };}};
  const adapter=new ClaudeAdapter(f.ctx,async()=>sdk);t.after(()=>adapter.close());await adapter.start();await adapter.prompt([{type:"text",text:"hello"}]);
  assert.equal(settings.permissionMode,"default");assert.deepEqual(settings.settingSources,["user","project","local"]);assert.equal(f.ctx.session.nativeSessionId,"claude-native");assert.ok(f.events.some(e=>e.type==="usage"));
});
test("Claude MultiVibe credentials stay in a private transient settings file, never command/event metadata",async t=>{
  const f=fixture(t,"claude-code");f.ctx.modelConnection={baseUrl:"http://127.0.0.1:1455",apiKey:"test-session-proxy-key"};let settingsFile="";
  const sdk={query:(options:any)=>{settingsFile=options.options.settings;assert.equal(fs.statSync(settingsFile).mode&0o777,0o600);assert.equal(JSON.parse(fs.readFileSync(settingsFile,"utf8")).env.ANTHROPIC_AUTH_TOKEN,"test-session-proxy-key");return {async *[Symbol.asyncIterator](){for await(const _ of options.prompt)yield {type:"result",is_error:false};},close(){}};}};
  const adapter=new ClaudeAdapter(f.ctx,async()=>sdk);await adapter.start();await adapter.prompt([{type:"text",text:"test"}]);adapter.close();assert.equal(fs.existsSync(settingsFile),false);assert.ok(!JSON.stringify(f.events).includes("test-session-proxy-key"));
});
test("OpenCode authenticates its loopback API and filters events from other sessions",async t=>{
  const f=fixture(t,"opencode");const adapter=new OpenCodeAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();await adapter.prompt([{type:"text",text:"hello"}]);
  assert.ok(f.events.some(e=>e.type==="message.part" && (e.payload as any).text==="hello"));assert.ok(!JSON.stringify(f.events).includes("MUST NOT LEAK"));assert.ok(!JSON.stringify(f.events).includes("MUST NOT ECHO USER"));
});

test("Claude preserves result-only output and keeps child-agent text out of the parent reply",async t=>{
  const f=fixture(t,"claude-code");
  const sdk={query:({prompt}:any)=>({
    async *[Symbol.asyncIterator](){for await(const _ of prompt){yield {type:"assistant",parent_tool_use_id:"child-tool",message:{id:"child-message",content:[{type:"text",text:"child private response"}]}};yield {type:"result",is_error:false,result:"Final parent response"};}},
    close(){},
  })};
  const adapter=new ClaudeAdapter(f.ctx,async()=>sdk);t.after(()=>adapter.close());await adapter.start();await adapter.prompt([{type:"text",text:"read only"}]);
  assert.deepEqual(f.events.filter(e=>e.type==="message.part").map(e=>(e.payload as any).text),["Final parent response"]);
  assert.ok(f.events.some(e=>e.type==="agent" && e.itemId==="child-tool"));
});

test("ACP applies a chosen native model before the first prompt and updates it between turns",async t=>{
  const f=fixture(t,"hermes-agent");f.ctx.session.model="native-chosen";
  const adapter=new AcpAdapter(f.ctx,["acp"]);t.after(()=>adapter.close());await adapter.start();
  assert.equal(f.ctx.session.model,"native-chosen");
  assert.deepEqual(await adapter.configure({model:"next-model"}),{selected:"next-model"});
  assert.equal(f.ctx.session.model,"next-model");
});
test("Codex discovery reads every model page without creating a thread",async t=>{
  const f=fixture(t,"openai-codex");f.ctx.modelDiscovery=true;
  const adapter=new CodexAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();
  assert.equal(f.ctx.session.nativeSessionId,undefined);
  assert.deepEqual(((await adapter.inspect("models")) as any).data.map((v:any)=>v.model),["first","second"]);
});

function requests(root:string){return fs.readFileSync(path.join(root,"requests.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));}
test("ACP exposes native effort choices and consumes configuration responses without notifications",async t=>{
  const f=fixture(t,"hermes-agent"),adapter=new AcpAdapter(f.ctx,["effort"]);t.after(()=>adapter.close());await adapter.start();
  assert.deepEqual(await adapter.inspect("effort"),{options:[{value:"low",label:"Light"},{value:"ultra",label:"Thorough"}],currentValue:"low"});
  await adapter.configure({effort:"ultra"});
  assert.equal((await adapter.inspect("effort") as any).currentValue,"ultra");
  await assert.rejects(adapter.configure({effort:"invented"}),/not advertised/);
  assert.deepEqual(requests(f.ctx.root).filter(r=>r.method==="session/set_config_option").map(r=>r.params),[{sessionId:"acp-session",configId:"thought",value:"ultra"}]);
});
test("Pi applies only the thinking levels reported by its RPC",async t=>{
  const f=fixture(t,"pi"),adapter=new PiAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();
  assert.deepEqual((await adapter.inspect("effort") as any).options.map((o:any)=>o.value),["off","low","high"]);
  await adapter.configure({effort:"high"});assert.equal((await adapter.inspect("effort") as any).currentValue,"high");
  await assert.rejects(adapter.configure({effort:"ultra"}),/not advertised/);
});
test("Codex validates model-specific levels and forwards effort on the next turn",async t=>{
  const f=fixture(t,"openai-codex");f.ctx.session.model="first";const adapter=new CodexAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();
  assert.equal((await adapter.inspect("effort") as any).currentValue,"low");
  await adapter.configure({effort:"ultra"});await assert.rejects(adapter.configure({effort:"high"}),/not advertised/);
  await adapter.prompt([{type:"text",text:"final-only"}]);
  assert.equal(requests(f.ctx.root).find(r=>r.method==="turn/start").params.effort,"ultra");
  await adapter.configure({model:"second"});assert.equal(await adapter.inspect("effort"),null);
  await adapter.prompt([{type:"text",text:"final-only"}]);
  assert.equal(requests(f.ctx.root).filter(r=>r.method==="turn/start").at(-1).params.effort,undefined);
});
test("Claude uses session flag settings only when the SDK and model advertise effort",async t=>{
  const f=fixture(t,"claude-code");f.ctx.session.model="claude-exact";const applied:any[]=[];
  const query:any={close(){},async *[Symbol.asyncIterator](){await new Promise(()=>{});},supportedCommands:async()=>[],supportedModels:async()=>[{value:"alias",resolvedModel:"claude-exact",supportedEffortLevels:["low","max"]}],applyFlagSettings:async(value:any)=>{applied.push(value);}};
  const adapter=new ClaudeAdapter(f.ctx,async()=>({query:()=>query}));t.after(()=>adapter.close());await adapter.start();
  await adapter.configure({effort:"max"});await assert.rejects(adapter.configure({effort:"high"}),/not advertised/);
  assert.deepEqual(applied,[{effortLevel:"max"}]);
  delete query.applyFlagSettings;assert.equal(await adapter.inspect("effort"),null);
});

test("OpenCode publishes exact model variants and sends the chosen variant with prompts",async t=>{
  const f=fixture(t,"opencode");f.ctx.session.model="native/reasoner";const adapter=new OpenCodeAdapter(f.ctx);t.after(()=>adapter.close());await adapter.start();
  assert.deepEqual((await adapter.inspect("effort") as any).options.map((o:any)=>o.value),["low","deep"]);
  await adapter.configure({effort:"deep"});await assert.rejects(adapter.configure({effort:"max"}),/not advertised/);
  await adapter.prompt([{type:"text",text:"hello"}]);assert.equal(JSON.parse(fs.readFileSync(path.join(f.ctx.root,"prompt.json"),"utf8")).variant,"deep");
});
