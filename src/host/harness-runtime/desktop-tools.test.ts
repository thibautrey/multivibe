import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DesktopTools, callDesktop } from "./desktop-tools.js";
import { JsonPeer } from "./process.js";
import desktopExtension from "./desktop-pi.js";

const text=(value:string)=>({content:[{type:"text" as const,text:value}]});
async function poll(desktop:DesktopTools,id:string,lease:string) {
  for(;;){const request=await desktop.next(id,lease);if(request.id && request.command)return {id:request.id,command:request.command};}
}
test("Desktop capabilities isolate sessions, require an active turn, and never replay delivered input",async()=>{
  let active=false;const desktop=new DesktopTools(()=>active,1000);
  try{
    const {lease}=desktop.attach("one");assert.ok(lease);
    await desktop.next("one",lease); // Initial ownership reset.
    assert.throws(()=>desktop.attach("one"),/owns this session/);
    const other=desktop.attach("two");await desktop.next("two",other.lease);
    await assert.rejects(desktop.call("one","browser",{action:"observe"}),/active turn/);
    active=true;
    await assert.rejects(desktop.call("one","browser",{action:"observe",target:"test.app"}),/cannot control/);
    const completed=desktop.call("one","browser",{action:"observe"});
    const request=await poll(desktop,"one",lease);
    assert.equal(request.command.target,"browser");
    assert.throws(()=>desktop.complete("two",other.lease,request.id,text("wrong")),/expired or belongs/);
    assert.throws(()=>desktop.complete("one","wrong",request.id,text("wrong")),/lease/);
    desktop.complete("one",lease,request.id,text("page ready"));assert.deepEqual(await completed,{...text("page ready"),isError:false});
    assert.throws(()=>desktop.complete("one",lease,request.id,text("replay")),/expired/);
    const pending=desktop.call("one","computer",{action:"click",target:"test.app",observation:"fresh",element:1});
    const delivered=await poll(desktop,"one",lease);
    const rejected=assert.rejects(pending,/interrupted/);desktop.cancel("one");await rejected;
    assert.deepEqual(await desktop.next("one",lease),{release:true});
    assert.throws(()=>desktop.complete("one",lease,delivered.id,text("late")),/expired/);
  }finally{desktop.close();}
});

test("real MCP subprocess discovers Host tools and returns native text plus screenshot over a private socket",async()=>{
  const desktop=new DesktopTools(()=>true);let peer:JsonPeer|undefined;
  try{
    const {lease}=desktop.attach("mcp");await desktop.next("mcp",lease);
    const connection=await desktop.connection("mcp");
    assert.equal(fs.statSync(connection.env.MULTIVIBE_DESKTOP_SOCKET).mode&0o777,0o600);
    assert.equal(fs.statSync(path.dirname(connection.env.MULTIVIBE_DESKTOP_SOCKET)).mode&0o777,0o700);
    const child=spawn(connection.command,connection.args,{env:{...process.env,...connection.env},stdio:"pipe"});
    peer=new JsonPeer(child,()=>{},async()=>({}),()=>{},()=>{});
    const hello=await peer.request("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"test",version:"1"}});
    assert.equal(hello.serverInfo.name,"multivibe-desktop");peer.notify("notifications/initialized");
    const listed=await peer.request("tools/list");assert.deepEqual(listed.tools.map((t:any)=>t.name),["browser","computer"]);
    const result=peer.request("tools/call",{name:"browser",arguments:{action:"observe"}});
    const request=await poll(desktop,"mcp",lease);
    desktop.complete("mcp",lease,request.id,{content:[{type:"text",text:"Observation: abc\nPage visible"},{type:"image",mimeType:"image/jpeg",data:"aW1hZ2U="}]});
    const reply=await result;assert.equal(reply.content[1].type,"image");assert.match(reply.content[0].text,/Page visible/);
    const denied=await peer.request("tools/call",{name:"browser",arguments:{action:"navigate",target:"another-app",url:"https://example.org"}});
    assert.equal(denied.isError,true);
  }finally{peer?.close();desktop.close();}
});

test("Pi's extension calls the same Host provider and propagates cancellation without executing input twice",async()=>{
  const desktop=new DesktopTools(()=>true);
  const oldSocket=process.env.MULTIVIBE_DESKTOP_SOCKET,oldToken=process.env.MULTIVIBE_DESKTOP_TOKEN;
  try{
    const {lease}=desktop.attach("pi");await desktop.next("pi",lease);
    const connection=await desktop.connection("pi");Object.assign(process.env,connection.env);
    const tools:any[]=[];desktopExtension({registerTool:(tool:any)=>tools.push(tool)});
    assert.deepEqual(tools.map(t=>t.name),["multivibe_browser","multivibe_computer"]);
    const result=tools[1].execute("first",{action:"list_apps"});const request=await poll(desktop,"pi",lease);
    desktop.complete("pi",lease,request.id,text("test.app: Fixture"));assert.equal((await result).details.provider,"multivibe-host");
    const controller=new AbortController();
    const pending=callDesktop({socket:connection.env.MULTIVIBE_DESKTOP_SOCKET,token:connection.env.MULTIVIBE_DESKTOP_TOKEN},"computer",{action:"observe",target:"test.app"},controller.signal);
    await poll(desktop,"pi",lease);
    const rejected=assert.rejects(pending,/abort/iu);controller.abort();await rejected;
    assert.deepEqual(await desktop.next("pi",lease),{release:true});
  }finally{
    if(oldSocket===undefined)delete process.env.MULTIVIBE_DESKTOP_SOCKET;else process.env.MULTIVIBE_DESKTOP_SOCKET=oldSocket;
    if(oldToken===undefined)delete process.env.MULTIVIBE_DESKTOP_TOKEN;else process.env.MULTIVIBE_DESKTOP_TOKEN=oldToken;
    desktop.close();
  }
});

test("an unavailable provider, invalid credential and timed-out approval fail closed",async()=>{
  const desktop=new DesktopTools(()=>true,30);
  try{
    await assert.rejects(desktop.call("missing","computer",{action:"list_apps"}),/Open this conversation/);
    const {lease}=desktop.attach("session");await desktop.next("session",lease);
    const connection=await desktop.connection("session");
    const invalid=await callDesktop({socket:connection.env.MULTIVIBE_DESKTOP_SOCKET,token:"invalid"},"computer",{action:"list_apps"});assert.equal(invalid.isError,true);
    const pending=desktop.call("session","computer",{action:"observe",target:"test.app"});
    await poll(desktop,"session",lease);await assert.rejects(pending,/timed out/);
    assert.deepEqual(await desktop.next("session",lease),{release:true});
    desktop.detach("session",lease);assert.equal(desktop.available("session"),false);
  }finally{desktop.close();}
});
