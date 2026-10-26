import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { HostHarnessRuntime } from "./runtime.js";
import { harnessRuntimeRoutes } from "./routes.js";
import { legacyHarnessRun } from "./legacy.js";
import { bridgeModelConnection } from "./bridge.js";
import { discoverHarnessProjects, discoverNativeSessions, readNativeSession } from "./discovery.js";
import { supported, type AdapterContext, type HarnessAdapter, type MessagePart } from "./types.js";

const prompt=(text:string,id=randomUUID())=>({id,type:"prompt",parts:[{type:"text",text}]});
const operation=(type:string,value?:unknown)=>({id:randomUUID(),type,...(value?{value}:{})});
async function eventually(check:()=>boolean) {const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)assert.fail("Timed out waiting for runtime state");await new Promise(r=>setTimeout(r,10));}}
class Fixture implements HarnessAdapter {
  calls:string[]=[];finish?:()=>void;reject?:(e:Error)=>void;steers:string[]=[];
  constructor(readonly ctx:AdapterContext){}
  async start(){this.ctx.nativeSession(`native-${this.ctx.session.id}`);this.ctx.capabilities({steer:supported(),compaction:supported()});}
  async prompt(parts:MessagePart[],steer=false) {
    const text=parts.filter(v=>v.type==="text").map(v=>(v as any).text).join("");
    if(steer){this.steers.push(text);return;}
    this.calls.push(text);this.ctx.emit({type:"message.delta",payload:{text:"partial"}});
    await new Promise<void>((resolve,reject)=>{this.finish=resolve;this.reject=reject;});
    this.ctx.emit({type:"message.delta",payload:{text:" complete"}});
  }
  async interrupt(){this.finish?.();}
  async compact(){this.ctx.emit({type:"compaction",payload:{state:"completed"}});return {summary:"retained"};}
  async inspect(subject:string){
    if(subject==="commands")return [{name:"review",description:"Review code"}];
    if(subject==="skills")return [{name:"documents",description:"Create documents"}];
    if(subject==="modes")return {data:[{id:"plan",name:"Plan mode"}]};
    return {subject};
  }
  async configure(value:Record<string,unknown>){return value;}
  async native(method:string){return {method};}
  close(){this.reject?.(new Error("connection closed"));}
}
function fixture(t:any) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-harness-runtime-test-"));
  const adapters=new Map<string,Fixture>();
  const integrations={list:async()=>[{id:"pi",name:"Pi",detected:true,configured:true}],executablePath:async(id:string)=>id==="pi"?process.execPath:null} as any;
  const runtime=new HostHarnessRuntime(root,integrations,ctx=>{const f=new Fixture(ctx);adapters.set(ctx.session.id,f);return f;});
  t.after(async()=>{await runtime.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,runtime,adapters,integrations};
}

test("queue edits, ordering and idempotency survive subscription changes",async t=>{
  const {runtime,adapters}=fixture(t);const s=await runtime.create({harnessId:"pi"});
  await runtime.command(s.id,operation("pause_queue"));
  const a=prompt("first"),b=prompt("second"),c=prompt("third");
  await runtime.command(s.id,a);await runtime.command(s.id,b);await runtime.command(s.id,c);
  assert.equal((await runtime.command(s.id,a)).id,a.id);
  await assert.rejects(runtime.command(s.id,{...a,parts:[{type:"text",text:"different"}]}),/different content/u);
  await runtime.command(s.id,operation("queue_edit",{commandId:b.id,parts:[{type:"text",text:"edited"}]}));
  await runtime.command(s.id,operation("queue_remove",{commandId:a.id}));
  await runtime.command(s.id,operation("queue_reorder",{ids:[c.id,b.id]}));
  const events:any[]=[];const off=runtime.subscribe(s.id,e=>events.push(e));
  await runtime.command(s.id,operation("resume_queue"));await eventually(()=>adapters.get(s.id)?.calls.length===1);
  off();assert.equal(s.state,"running");adapters.get(s.id)!.finish!();
  await eventually(()=>adapters.get(s.id)?.calls.length===2);assert.deepEqual(adapters.get(s.id)!.calls,["third","edited"]);
  adapters.get(s.id)!.finish!();await eventually(()=>s.state==="idle");
  assert.equal(runtime.snapshot(s.id).queue.length,0);assert.ok(events.length);
  assert.ok(runtime.store.events(s.id).some(e=>e.type==="turn.completed"));
});
test("sessions run independently and steering is bound to the current turn",async t=>{
  const {runtime,adapters}=fixture(t);const a=await runtime.create({harnessId:"pi"}),b=await runtime.create({harnessId:"pi"});
  await runtime.command(a.id,prompt("A"));await runtime.command(b.id,prompt("B"));await eventually(()=>adapters.size===2 && !!adapters.get(a.id)?.finish && !!adapters.get(b.id)?.finish);
  const stale=await runtime.command(a.id,{...operation("steer"),turnId:"old",parts:[{type:"text",text:"wrong"}]});assert.equal(stale.state,"failed");
  const accepted=await runtime.command(a.id,{...operation("steer"),turnId:a.activeTurnId,parts:[{type:"text",text:"new direction"}]});assert.equal(accepted.state,"accepted");
  assert.deepEqual(adapters.get(a.id)!.steers,["new direction"]);
  adapters.get(b.id)!.finish!();await eventually(()=>b.state==="idle");assert.equal(a.state,"running");
  await runtime.command(a.id,prompt("queued"));await runtime.command(a.id,operation("interrupt"));await eventually(()=>!a.activeTurnId);
  assert.equal(a.queuePaused,true);assert.equal(runtime.snapshot(a.id).queue.filter(c=>c.state==="queued").length,1);
});
test("pending interactions are session scoped and answered only once",async t=>{
  const {runtime,adapters}=fixture(t);const a=await runtime.create({harnessId:"pi"}),b=await runtime.create({harnessId:"pi"});
  await runtime.command(a.id,prompt("question"));await eventually(()=>!!adapters.get(a.id)?.finish);
  const answer=adapters.get(a.id)!.ctx.ask("permission","write?",{options:[{optionId:"allow"},{optionId:"deny"}],authorization:"Bearer secret"});
  const interaction=runtime.snapshot(a.id).interactions[0];assert.equal(a.state,"waiting_user");
  assert.equal((interaction.detail as any).authorization,"[private]");
  const wrong=await runtime.command(b.id,operation("respond",{interactionId:interaction.id,answer:{optionId:"allow"}}));assert.equal(wrong.state,"failed");
  const respond=operation("respond",{interactionId:interaction.id,answer:{optionId:"deny"}});assert.equal((await runtime.command(a.id,respond)).state,"completed");
  assert.deepEqual(await answer,{optionId:"deny"});assert.equal((await runtime.command(a.id,operation("respond",respond.value))).state,"failed");
  adapters.get(a.id)!.finish!();await eventually(()=>a.state==="idle");
});
test("Host restart marks dispatched work uncertain and never replays it",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-harness-recovery-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const integrations={list:async()=>[{id:"pi",name:"Pi",detected:true,configured:true}],executablePath:async()=>process.execPath} as any;
  let adapter:Fixture;const first=new HostHarnessRuntime(root,integrations,ctx=>(adapter=new Fixture(ctx)));const s=await first.create({harnessId:"pi"});
  await first.command(s.id,prompt("submitted"));await eventually(()=>!!adapter?.finish);await first.command(s.id,prompt("not submitted"));await first.close();
  let starts=0;const restored=new HostHarnessRuntime(root,integrations,ctx=>{starts++;return new Fixture(ctx);});
  const snapshot=restored.snapshot(s.id);assert.equal(snapshot.session.state,"uncertain");assert.equal(snapshot.session.queuePaused,true);assert.equal(starts,0);
  assert.equal(snapshot.queue.filter(c=>c.state==="queued").length,1);assert.equal(snapshot.queue.filter(c=>c.state==="uncertain").length,1);
  assert.equal((await restored.command(s.id,operation("resume_queue"))).state,"failed");await restored.close();
});
test("attachments verify checksum, ownership, size and preserve private permissions",async t=>{
  const {runtime}=fixture(t);const a=await runtime.create({harnessId:"pi"}),b=await runtime.create({harnessId:"pi"});
  const attachment=runtime.store.attach(a.id,"../notes.txt","text/plain",Buffer.from("hello").toString("base64"));
  assert.equal(attachment.name,"notes.txt");const file=runtime.store.attachment(a.id,attachment.id);assert.equal(file.data.toString(),"hello");
  assert.equal(runtime.store.attach(a.id,"notes.txt","text/plain",Buffer.from("hello").toString("base64")).id,attachment.id);
  assert.equal(fs.statSync(file.path).mode&0o777,0o600);
  assert.throws(()=>runtime.store.attachment(b.id,attachment.id),/belong/u);
  assert.throws(()=>runtime.store.attach(a.id,"x","text/plain","aGVsbG8=","wrong"),/checksum/u);
  await assert.rejects(runtime.command(b.id,{...prompt(""),parts:[{type:"attachment",attachmentId:attachment.id}]}),/belong/u);
  fs.writeFileSync(file.path,"tampered");assert.throws(()=>runtime.store.attachment(a.id,attachment.id),/integrity/u);
});
test("large native catalog events become downloadable artifacts instead of terminating the runtime",async t=>{
  const {runtime}=fixture(t);const session=await runtime.create({harnessId:"pi"});
  const payload={models:Array.from({length:256},(_,i)=>({name:`model-${i}`,description:"data".repeat(1200)}))};
  const event=runtime.store.event(session.id,"catalog",payload);
  assert.equal((event.payload as any).truncated,true);
  const artifact=runtime.store.attachment(session.id,(event.payload as any).attachment.id);
  assert.equal(JSON.parse(artifact.data.toString()).models.length,256);
});
test("capabilities remain unknown until advertised and a harness cannot change",async t=>{
  const {runtime}=fixture(t);const s=await runtime.create({harnessId:"pi"});
  assert.equal(s.capabilities.steer.support,"unknown");assert.equal(s.capabilities.queue.support,"multivibe");
  assert.equal(s.capabilities.projects.available,true);
  await assert.rejects(runtime.create({id:s.id,harnessId:"claude-code"}),/fixed/u);
  assert.equal((await runtime.command(s.id,operation("compact"))).state,"completed");assert.equal(s.capabilities.compaction.support,"native");
  assert.equal((await runtime.catalog()).find(v=>v.id==="gemini-cli")!.available,false);
});
test("Host schedules coalesce missed deadlines and never duplicate a pending execution",async t=>{
  const {runtime}=fixture(t);const s=await runtime.create({harnessId:"pi"});await runtime.command(s.id,operation("pause_queue"));
  const created=await runtime.command(s.id,operation("configure",{schedule:{name:"check",parts:[{type:"text",text:"scheduled"}],nextAt:1000,intervalMs:60_000}}));assert.equal(created.state,"completed");
  await runtime.tickSchedules(1000);await runtime.tickSchedules(180_000);
  assert.equal(runtime.snapshot(s.id).queue.length,1);assert.equal(runtime.store.schedules(s.id)[0].nextAt,181_000);
  await runtime.tickSchedules(180_000);assert.equal(runtime.snapshot(s.id).queue.length,1);
  const schedule=runtime.store.schedules(s.id)[0];await runtime.command(s.id,operation("configure",{schedule:{id:schedule.id,enabled:false}}));await runtime.tickSchedules(500_000);assert.equal(runtime.snapshot(s.id).queue.length,1);
});
test("native discovery only returns metadata and isolated-fork sources",t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-native-source-"));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const workspace=path.join(home,"workspaces","project");fs.mkdirSync(workspace,{recursive:true});
  const directory=path.join(home,".pi/agent/sessions/project");fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,"old.jsonl"),JSON.stringify({type:"session",id:"native-id",cwd:workspace})+"\n"+JSON.stringify({type:"message",secret:"never return transcript"}));
  fs.writeFileSync(path.join(directory,"new.jsonl"),JSON.stringify({type:"session",id:"native-id-2",cwd:workspace})+"\n"+JSON.stringify({type:"message",content:"never return project content"}));
  fs.writeFileSync(path.join(directory,"stale.jsonl"),JSON.stringify({type:"session",id:"native-id-3",cwd:path.join(home,"missing")}));
  fs.symlinkSync(path.join(directory,"old.jsonl"),path.join(directory,"alias.jsonl"));
  const sources=discoverNativeSessions("pi",home);assert.equal(sources.length,3);assert.equal(sources[0].strategy,"isolated_fork");assert.ok(!JSON.stringify(sources).includes("never return"));
  const projects=discoverHarnessProjects("pi",home);assert.deepEqual(projects.map(({name,path:harnessPath})=>({name,path:harnessPath})),[{name:"project",path:fs.realpathSync(workspace)}]);assert.ok(!JSON.stringify(projects).includes("never return"));
  assert.deepEqual(discoverHarnessProjects("librechat",home),[]);
  const oldSource=sources.find(source=>source.nativeSessionId.endsWith("old.jsonl"))!;
  const preview=readNativeSession("pi",oldSource.sourceId,home);assert.equal(preview.readOnly,true);assert.equal(preview.records.length,2);assert.ok(!JSON.stringify(preview).includes("never return"));assert.equal((preview.records[1] as any).secret,"[private]");
  assert.throws(()=>readNativeSession("pi","missing",home),/not found/u);
});
test("runtime project picker excludes Host generated conversation workspaces",async t=>{
  const {root,runtime}=fixture(t),home=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-project-picker-"));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const external=path.join(home,"project"),internal=path.join(root,"workspaces","mobile-fixture");
  fs.mkdirSync(external,{recursive:true});fs.mkdirSync(internal,{recursive:true});
  const directory=path.join(home,".pi/agent/sessions");fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,"external.jsonl"),JSON.stringify({type:"session",id:"external",cwd:external}));
  fs.writeFileSync(path.join(directory,"internal.jsonl"),JSON.stringify({type:"session",id:"internal",cwd:internal}));
  assert.deepEqual(runtime.projects({harnessId:"pi",targetId:"local"},home).projects.map(project=>project.path),[fs.realpathSync(external)]);
});
test("runtime HTTP replay is bounded, read-only and disconnect leaves generation running",async t=>{
  const {runtime,adapters}=fixture(t);const app=express();app.use(harnessRuntimeRoutes(runtime));const server=createServer(app);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>{server.closeAllConnections();server.close();});const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const post=async(route:string,value:unknown)=>fetch(origin+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
  const session=(await (await post("/sessions",{harnessId:"pi"})).json()).session;
  const command=prompt("hello");assert.equal((await post(`/sessions/${session.id}/commands`,command)).status,200);
  await eventually(()=>!!adapters.get(session.id)?.finish);
  const controller=new AbortController();const stream=await fetch(`${origin}/sessions/${session.id}/events`,{signal:controller.signal});const reader=stream.body!.getReader();const chunk=await reader.read();assert.ok(new TextDecoder().decode(chunk.value).includes("session.created"));controller.abort();
  assert.equal(runtime.session(session.id).state,"running");adapters.get(session.id)!.finish!();await eventually(()=>runtime.session(session.id).state==="idle");
  const batch=await (await fetch(`${origin}/sessions/${session.id}/events?poll=1&after=0`)).json();assert.ok(batch.events.length>0);assert.equal(batch.cursor,batch.events.at(-1).seq);
  assert.equal((await fetch(`${origin}/sessions/${session.id}/events?poll=1&after=-1`)).status,400);
});

test("completed controls release the session before dispatching queued messages",async t=>{
  const {runtime,adapters}=fixture(t);const s=await runtime.create({harnessId:"pi"});
  for(const command of [operation("compact"),operation("configure",{model:"test"}),operation("native",{method:"read"})])assert.equal((await runtime.command(s.id,command)).state,"completed");
  const adapter=adapters.get(s.id)!;let release!:(value:Record<string,unknown>)=>void;
  adapter.configure=async()=>new Promise<Record<string,unknown>>(resolve=>{release=resolve;});
  const configure=runtime.command(s.id,operation("configure",{model:"next"}));
  await eventually(()=>!!release);await runtime.command(s.id,prompt("after configuration"));
  assert.equal(adapter.calls.length,0);
  assert.equal((await runtime.command(s.id,operation("native",{method:"collision"}))).state,"failed");
  release({model:"next"});assert.equal((await configure).state,"completed");
  await eventually(()=>adapter.calls.length===1);adapter.finish!();await eventually(()=>s.state==="idle");
});

test("stop preserves a native completion or failure that races with cancellation",async t=>{
  const {runtime,adapters}=fixture(t);
  for(const status of ["completed","failed"]){
    const s=await runtime.create({harnessId:"pi"});const command=prompt(status);
    await runtime.command(s.id,command);await eventually(()=>!!adapters.get(s.id)?.finish);const adapter=adapters.get(s.id)!;
    adapter.interrupt=async()=>{adapter.ctx.emit({type:"turn.status",payload:{status,...(status==="failed"?{error:"native failure"}:{})}});adapter.finish!();};
    assert.equal((await runtime.command(s.id,operation("interrupt"))).state,"completed");await eventually(()=>!s.activeTurnId);
    assert.equal(runtime.store.receipt(command.id)!.state,status);assert.equal(s.queuePaused,true);
    assert.equal(runtime.store.receipt(command.id)!.cancelAcknowledged,true);
  }
});

test("native failure and cancellation remain terminal when a settlement event follows",async t=>{
  const {runtime,adapters}=fixture(t);
  for(const status of ["failed","interrupted"]){
    const s=await runtime.create({harnessId:"pi"});const command=prompt(status);
    await runtime.command(s.id,command);await eventually(()=>!!adapters.get(s.id)?.finish);const adapter=adapters.get(s.id)!;
    adapter.ctx.emit({type:"turn.status",payload:{status,error:status==="failed"?"authentication failed":undefined}});
    adapter.ctx.emit({type:"turn.status",payload:{type:"agent_settled"}});adapter.finish!();
    await eventually(()=>!s.activeTurnId);assert.equal(runtime.store.receipt(command.id)!.state,status==="failed"?"failed":"cancelled");assert.equal(s.state,status);
  }
});

test("late native completion reconciles an uncertain command without replay",async t=>{
  const {runtime,adapters}=fixture(t);const s=await runtime.create({harnessId:"pi"});await runtime.inspect(s.id,"settings");const adapter=adapters.get(s.id)!;
  adapter.prompt=async()=>{throw new Error("Connection lost after submission");};
  const command=prompt("uncertain");await runtime.command(s.id,command);await eventually(()=>s.state==="uncertain");
  assert.equal(s.activeTurnId,command.id);assert.equal((await runtime.command(s.id,operation("resume_queue"))).state,"failed");
  adapter.ctx.emit({type:"turn.status",payload:{status:"completed"}});
  assert.equal(runtime.store.receipt(command.id)!.state,"completed");assert.equal(s.state,"idle");assert.equal(s.activeTurnId,undefined);assert.equal(s.queuePaused,true);
  assert.ok(runtime.store.events(s.id).some(e=>e.type==="turn.completed" && (e.payload as any).reconciled));
});

test("parallel interactions stay pending until every question has been answered",async t=>{
  const {runtime,adapters}=fixture(t);const s=await runtime.create({harnessId:"pi"});await runtime.inspect(s.id,"settings");const adapter=adapters.get(s.id)!;
  const first=adapter.ctx.ask("question","first",{}),second=adapter.ctx.ask("question","second",{});
  const [a,b]=runtime.snapshot(s.id).interactions;
  await runtime.command(s.id,operation("respond",{interactionId:a.id,answer:{text:"a"}}));await first;assert.equal(s.state,"waiting_user");
  await runtime.command(s.id,operation("respond",{interactionId:b.id,answer:{text:"b"}}));await second;assert.equal(s.state,"idle");
});

test("authentication challenges are available after reconnect without entering the journal or export",async t=>{
  const {runtime,adapters}=fixture(t);const s=await runtime.create({harnessId:"pi"});await runtime.inspect(s.id,"settings");
  const url="https://example.test/login?code=temporary-code";
  const answer=adapters.get(s.id)!.ctx.ask("authentication","Connect",{url,mode:"url"});
  const interaction=runtime.snapshot(s.id).interactions[0];assert.equal((interaction.detail as any).url,url);
  assert.ok(!JSON.stringify(runtime.store.events(s.id)).includes(url));assert.ok(!JSON.stringify(runtime.store.interactions(s.id)).includes(url));
  await runtime.command(s.id,operation("respond",{interactionId:interaction.id,answer:{action:"cancel"}}));await answer;
  assert.equal(runtime.snapshot(s.id).interactions.length,0);
});

test("binary tool results become intact session-owned downloadable artifacts",async t=>{
  const {runtime,adapters}=fixture(t);const s=await runtime.create({harnessId:"pi"});await runtime.inspect(s.id,"settings");
  const bytes=Buffer.alloc(256*1024,42);
  adapters.get(s.id)!.ctx.emit({type:"tool",itemId:"image-tool",payload:{content:[{type:"image",mimeType:"image/png",data:bytes.toString("base64")}]}});
  const event=runtime.store.events(s.id).find(e=>e.type==="tool")!;const file=(event.payload as any).artifacts[0];
  assert.equal(event.itemId,"image-tool");assert.deepEqual(runtime.store.attachment(s.id,file.id).data,bytes);
  assert.ok(!JSON.stringify(event).includes(bytes.toString("base64")));
});

test("event replay bounds page bytes without losing records between cursors",async t=>{
  const {runtime}=fixture(t);const s=await runtime.create({harnessId:"pi"});
  for(let index=0;index<10;index++)runtime.store.event(s.id,"tool",{index,values:Array.from({length:7},()=>"x".repeat(120_000))});
  const first=runtime.store.events(s.id,0,500);assert.ok(first.length<10);
  const all=[];let cursor=0;for(;;){const page=runtime.store.events(s.id,cursor,500);if(!page.length)break;all.push(...page);cursor=page.at(-1)!.seq;}
  assert.equal(all.filter(e=>e.type==="tool").length,10);assert.equal(new Set(all.map(e=>e.seq)).size,all.length);
});

test("stopping expires pending interactions and keeps queued attachments intact",async t=>{
  const {runtime,adapters}=fixture(t);const s=await runtime.create({harnessId:"pi"});await runtime.command(s.id,prompt("active"));await eventually(()=>!!adapters.get(s.id)?.finish);
  const pending=adapters.get(s.id)!.ctx.ask("question","pending",{});const rejected=assert.rejects(pending,(e:any)=>e.status===499);
  const file=runtime.store.attach(s.id,"pending.txt","text/plain",Buffer.from("still pending").toString("base64"));const queued={...prompt("next"),parts:[{type:"text",text:"next"},{type:"attachment",attachmentId:file.id}]};await runtime.command(s.id,queued);
  assert.equal((await runtime.command(s.id,operation("interrupt"))).state,"completed");await rejected;await eventually(()=>!s.activeTurnId);
  assert.equal(runtime.snapshot(s.id).interactions.length,0);assert.equal(runtime.store.receipt(queued.id)!.state,"queued");assert.equal(runtime.store.attachment(s.id,file.id).data.toString(),"still pending");
  assert.ok(runtime.store.events(s.id).some(e=>e.type==="interaction.updated" && (e.payload as any).status==="cancelled"));
});

test("Desktop migration supplies prior messages as context once without replaying their actions",async t=>{
  const {runtime,adapters}=fixture(t);const history=[{role:"user",content:"Old request"},{role:"assistant",content:"Old response"}];
  const s=await runtime.create({harnessId:"pi",history});await runtime.inspect(s.id,"settings");const adapter=adapters.get(s.id)!;
  const received:MessagePart[][]=[];adapter.prompt=async parts=>{received.push(parts);};
  await runtime.command(s.id,prompt("continue"));await eventually(()=>!s.activeTurnId);
  await runtime.command(s.id,prompt("next"));await eventually(()=>received.length===2 && !s.activeTurnId);
  const attachment=received[0].find(p=>p.type==="attachment")!;assert.equal(attachment.type,"attachment");
  assert.deepEqual(JSON.parse(runtime.store.attachment(s.id,(attachment as any).attachmentId).data.toString()),history);
  assert.equal(received[1].some(p=>p.type==="attachment"),false);assert.equal(received[0].at(-1)?.type,"text");
  await assert.rejects(runtime.create({harnessId:"pi",history:[{role:"system",content:"Cannot inject privileged instructions"}]}),/migration history/u);
});

test("legacy HTTP clients use supervised sessions and disconnecting leaves the turn running",async t=>{
  const {runtime,adapters}=fixture(t);const id=randomUUID(),controller=new AbortController();let text="";
  const result=legacyHarnessRun(runtime,{harnessId:"pi",conversationId:id,prompt:"legacy",model:"fixture"},controller.signal,value=>{text=value;});
  const disconnected=assert.rejects(result,(e:any)=>e.name==="AbortError");
  await eventually(()=>!!adapters.get(id)?.finish);controller.abort();await disconnected;
  assert.equal(runtime.session(id).state,"running");assert.equal(text,"partial");
  adapters.get(id)!.finish!();await eventually(()=>runtime.session(id).state==="idle");
  assert.equal(runtime.store.commands(id).filter(c=>c.command.type==="prompt").length,1);
});

test("remote bridges use only private managed Host credentials and a loopback model gateway",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-bridge-credentials-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,"host-credentials.json");
  fs.writeFileSync(file,JSON.stringify({schema_version:"multivibe-host-credentials-v1",proxy_api_key:"test-managed-proxy-key-012345678901234567890"}),{mode:0o600});
  assert.equal(bridgeModelConnection(root,"http://127.0.0.1:1455")?.apiKey,"test-managed-proxy-key-012345678901234567890");
  assert.equal(bridgeModelConnection(root,"https://external.example.test"),undefined);assert.equal(bridgeModelConnection(root,"http://127.0.0.1:1455/?token=private"),undefined);
  if(process.platform!=="win32"){fs.chmodSync(file,0o644);assert.equal(bridgeModelConnection(root,"http://127.0.0.1:1455"),undefined);}
});

for(const harnessId of ["librechat","openwebui"] as const)test(`${harnessId} catalog and sessions require a validated connection, pin its model and never journal the key`,async t=>{
  const {runtime,root,adapters}=fixture(t);
  assert.equal((await runtime.catalog()).find(v=>v.id===harnessId)?.available,false);
  await assert.rejects(runtime.create({harnessId}),/Configure/u);
  // A previously validated connection in the private Host store.
  const connection={endpoint:"https://librechat.example/api/agents/v1",apiKey:"fixture-private-librechat",agentId:"agent-original"};
  fs.writeFileSync(path.join(root,`${harnessId}-connection.json`),JSON.stringify(connection),{mode:0o600});
  const session=await runtime.create({harnessId});
  assert.equal(session.model,"agent-original");
  assert.equal(session.configuration?.endpoint,connection.endpoint);
  assert.equal(session.capabilities.interrupt.available,false);
  assert.equal(JSON.stringify(runtime.snapshot(session.id)).includes(connection.apiKey),false);
  const receipt=await runtime.command(session.id,prompt("Hello"));
  await eventually(()=>adapters.has(session.id));
  const adapter=adapters.get(session.id)!;
  await eventually(()=>Boolean(adapter.finish));adapter.finish!();
  await eventually(()=>runtime.store.receipt(receipt.id)?.state==="completed");
  assert.equal((harnessId==="openwebui"?adapter.ctx.openWebUIConnection:adapter.ctx.libreChatConnection)?.apiKey,connection.apiKey);
  assert.equal(JSON.stringify(runtime.store.events(session.id)).includes(connection.apiKey),false);
  await assert.rejects(runtime.create({harnessId,authMode:"multivibe",model:"other"}),/own API key/u);
});

test("model discovery closes its probe and never persists a conversation or submits a prompt",async t=>{
  const {runtime,adapters}=fixture(t);
  const result=await runtime.models({harnessId:"pi"});
  assert.deepEqual(result.models,[]);
  assert.deepEqual(runtime.store.sessions(),[]);
  const probe=[...adapters.values()][0];assert.equal(probe.ctx.modelDiscovery,true);
  assert.equal(fs.existsSync(probe.ctx.root),false);assert.deepEqual(probe.calls,[]);
});
test("native model and provider survive session creation; model discovery enforces session ownership",async t=>{
  const {runtime}=fixture(t);
  const session=await runtime.create({harnessId:"pi",model:"chosen-model",nativeProvider:"chosen-provider"});
  assert.equal(session.model,"chosen-model");assert.equal(session.configuration?.nativeProvider,"chosen-provider");
  const result=await runtime.models({harnessId:"pi",sessionId:session.id});
  assert.equal(result.currentModelId,"chosen-model");assert.equal(result.provider,"chosen-provider");
  await assert.rejects(runtime.models({harnessId:"other",sessionId:session.id}),/does not match/u);
  await assert.rejects(runtime.models({harnessId:"pi",targetId:"other",sessionId:session.id}),/does not match/u);
});

test("model endpoint returns native choices without creating sessions and rejects unavailable harnesses",async t=>{
  const {runtime}=fixture(t);const app=express();app.use(harnessRuntimeRoutes(runtime));const server=createServer(app);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const response=await fetch(origin+"/models?targetId=local",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({harnessId:"pi"})});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).models,[]);assert.equal(runtime.store.sessions().length,0);
  const unavailable=await fetch(origin+"/models",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({harnessId:"missing"})});
  assert.equal(unavailable.status,409);
});

test("effort discovery uses the chosen model and preserves session/target ownership",async t=>{
  const {runtime,adapters}=fixture(t);
  assert.deepEqual(await runtime.effort({harnessId:"pi",model:"chosen",provider:"native-provider"}),{effort:{subject:"effort"}});
  const probe=[...adapters.values()][0];assert.equal(probe.ctx.session.model,"chosen");assert.equal(probe.ctx.session.configuration?.nativeProvider,"native-provider");
  assert.equal(runtime.store.sessions().length,0);
  const session=await runtime.create({harnessId:"pi",model:"chosen",effort:"high"});
  await runtime.command(session.id,operation("inspect",{subject:"settings"}));
  assert.equal(session.configuration?.pendingEffort,undefined);assert.equal(session.configuration?.effort,"high");
  await runtime.command(session.id,operation("configure",{effort:"low"}));
  assert.equal(runtime.store.sessions().find(s=>s.id===session.id)?.configuration?.effort,"low");
  await runtime.command(session.id,operation("configure",{effort:null}));
  assert.equal(runtime.store.sessions().find(s=>s.id===session.id)?.configuration?.effort,undefined);
  await runtime.command(session.id,operation("configure",{model:"other"}));assert.equal(session.configuration?.effort,undefined);
  await assert.rejects(runtime.effort({harnessId:"hermes-agent",sessionId:session.id}),/does not match/);
});

test("feature endpoint returns normalized harness actions without persisting its probe",async t=>{
  const {runtime}=fixture(t);const app=express();app.use(harnessRuntimeRoutes(runtime));const server=createServer(app);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const response=await fetch(origin+"/features",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({harnessId:"pi"})});
  assert.equal(response.status,200);const catalog:any=await response.json();
  assert.deepEqual(catalog.items.filter((v:any)=>["commands","skills"].includes(v.section)).map((v:any)=>v.value),["/review ","/skill:documents "]);
  assert.equal(catalog.items.find((v:any)=>v.name==="Plan mode").section,"actions");
  assert.equal(runtime.store.sessions().length,0);
});

test("automatic conversation catalog reads supervised sessions without starting adapters and isolates unbridged containers",async t=>{
  const {runtime,adapters}=fixture(t);
  const session=await runtime.create({harnessId:"pi",title:"Created by another client"});
  runtime.store.saveTarget({id:"isolated-container",name:"Container",kind:"container",container:"isolated"});
  const app=express();app.use(harnessRuntimeRoutes(runtime));const server=createServer(app);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const catalog=await (await fetch(origin+"/conversation-sources")).json();
  assert.equal(catalog.sessions[0].id,session.id);assert.ok(Array.isArray(catalog.nativeSessions));
  assert.ok(catalog.nativeSessions.every((v:any)=>!v.file));assert.equal(adapters.size,0);
  const container=await (await fetch(origin+"/conversation-sources?targetId=isolated-container")).json();
  assert.deepEqual(container,{sessions:[],nativeSessions:[],nextPage:null});
  assert.deepEqual(await (await fetch(origin+"/native-sessions?targetId=isolated-container&harnessId=pi")).json(),{sessions:[]});
  assert.equal((await fetch(origin+"/native-sessions/anything/messages?targetId=isolated-container&harnessId=pi")).status,422);
  assert.equal((await fetch(origin+"/sessions/import?targetId=isolated-container",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({harnessId:"pi",sourceId:"anything"})})).status,422);
  assert.equal(adapters.size,0);
});
