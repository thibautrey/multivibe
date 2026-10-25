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
import { discoverNativeSessions } from "./discovery.js";
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
  async inspect(subject:string){return {subject};}
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
  await assert.rejects(runtime.create({id:s.id,harnessId:"claude-code"}),/fixed/u);
  assert.equal((await runtime.command(s.id,operation("compact"))).state,"completed");assert.equal(s.capabilities.compaction.support,"native");
  assert.equal((await runtime.catalog()).find(v=>v.id==="gemini-cli")!.available,false);
});
test("native discovery only returns metadata and isolated-fork sources",t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-native-source-"));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const directory=path.join(home,".pi/agent/sessions/project");fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,"old.jsonl"),JSON.stringify({type:"session",id:"native-id",cwd:"/tmp"})+"\n"+JSON.stringify({type:"message",secret:"never return transcript"}));
  fs.symlinkSync(path.join(directory,"old.jsonl"),path.join(directory,"alias.jsonl"));
  const sources=discoverNativeSessions("pi",home);assert.equal(sources.length,1);assert.equal(sources[0].strategy,"isolated_fork");assert.ok(!JSON.stringify(sources).includes("never return"));
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
