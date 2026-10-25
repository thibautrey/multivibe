import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenWebUIAdapter, openWebUIEndpoint } from "./openwebui.js";
import { LibreChatConfiguration } from "./librechat.js";
import { type AdapterContext } from "./types.js";

async function fixture(t:any){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"openwebui-test-"));let chat:any,active=false,reads=0,mode="normal";const requests:any[]=[];
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,"Bearer fixture-openwebui-key");
    let text="";for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):undefined;requests.push({path:req.url,method:req.method,body});
    res.setHeader("content-type","application/json");const send=(v:any)=>res.end(JSON.stringify(v));
    if(mode==="unauthorized"){res.writeHead(403);send({detail:"fixture-openwebui-key"});return;}
    if(mode==="redirect"){res.writeHead(302,{location:"http://127.0.0.1:1/leak"}).end();return;}
    if(req.url==="/prefix/api/models"){send({data:[{id:"model-1",name:"Workspace model"}]});return;}
    if(req.url==="/prefix/api/v1/chats/new"){chat=body.chat;send({id:"remote-chat",chat});return;}
    if(req.url==="/prefix/api/v1/chats/remote-chat"){
      if(body){chat=body.chat;send({id:"remote-chat",chat});return;}
      if(active){const message=chat.history.messages[chat.history.currentId];message.content=++reads===1?"Partial":"Completed answer";
        if(mode==="error"){message.error={detail:"remote failure"};}
        if(reads>1 && mode!=="incomplete"){message.done=true;message.usage={total_tokens:19};message.output=[{type:"function_call",name:"remote-tool"}];active=false;}}
      send({id:"remote-chat",chat});return;
    }
    if(req.url==="/prefix/api/chat/completions"){
      assert.equal(body.params.function_calling,"native");assert.ok(body.session_id);assert.equal(body.chat_id,"remote-chat");assert.equal(body.stream,true);assert.equal("tools" in body,false);
      active=true;reads=0;send(mode==="bad-ack"?{choices:[]}:{status:true,task_ids:["native-task"],chat_id:"remote-chat"});return;
    }
    if(req.url==="/prefix/api/tasks/chat/remote-chat"){send({task_ids:mode==="incomplete" || mode==="race"?[]:["native-task"]});return;}
    res.writeHead(404);send({error:"unexpected path"});
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}/prefix`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});});
  const connection={endpoint:openWebUIEndpoint(endpoint),apiKey:"fixture-openwebui-key",agentId:"model-1"};const events:any[]=[];
  const ctx={root,session:{id:"desktop-session",title:"My chat",model:"model-1"},target:{kind:"local"},openWebUIConnection:connection,emit:(e:any)=>events.push(e),nativeSession:(id:string)=>{(ctx.session as any).nativeSessionId=id;}} as unknown as AdapterContext;
  return {root,endpoint,connection,requests,events,ctx,setMode:(v:string)=>{mode=v;},chat:()=>chat};
}
test("Open WebUI normalizes root, reverse proxy and both supported API bases",()=>{
  for(const url of ["https://example.com/prefix","https://example.com/prefix/api/","https://example.com/prefix/api/v1/"])assert.equal(openWebUIEndpoint(url),"https://example.com/prefix/api");
  for(const url of ["ftp://example.com","https://key@example.com","https://example.com/?token=x"])assert.throws(()=>openWebUIEndpoint(url));
});
test("Open WebUI validates model discovery before private storage and remains isolated from LibreChat",async t=>{
  const f=await fixture(t);const config=new LibreChatConfiguration(f.root,{id:"openwebui",name:"Open WebUI",suffix:"/api"});
  assert.equal(config.descriptor().available,false);
  await config.configure({...f.connection,discover:true});assert.equal(config.read(),undefined);
  await assert.rejects(config.configure({...f.connection,agentId:"missing"}),/available/u);
  const result=await config.configure(f.connection);
  assert.equal(result.endpoint,f.connection.endpoint);assert.equal(JSON.stringify(result).includes(f.connection.apiKey),false);
  assert.equal(config.descriptor().id,"openwebui");assert.equal(config.descriptor().protocol,"openwebui");
  assert.equal(fs.statSync(path.join(f.root,"openwebui-connection.json")).mode&0o777,0o600);
  assert.equal(new LibreChatConfiguration(f.root).read(),undefined);
  await config.configure({...f.connection,apiKey:""});
  await assert.rejects(config.configure({...f.connection,endpoint:"http://different.example",apiKey:""}),/API key/u);
});
test("Open WebUI runs the native remote loop, replaces snapshots and resumes the saved chat after restart",async t=>{
  const f=await fixture(t);const adapter=new OpenWebUIAdapter(f.ctx);await adapter.start();await adapter.prompt([{type:"text",text:"First"}]);adapter.close();
  const firstAssistant=f.chat().history.currentId;
  const next=new OpenWebUIAdapter(f.ctx);await next.start();await next.prompt([{type:"text",text:"Second"}]);next.close();
  assert.equal(f.requests.filter(v=>v.path.endsWith("/chats/new")).length,1);
  const calls=f.requests.filter(v=>v.path.endsWith("/chat/completions"));
  assert.deepEqual(calls[1].body.messages,[{role:"user",content:"First"},{role:"assistant",content:"Completed answer"},{role:"user",content:"Second"}]);
  const user=f.chat().history.messages[calls[1].body.user_message.id];assert.equal(user.parentId,firstAssistant);
  assert.ok(f.events.some(e=>e.type==="message.part" && e.payload.text==="Partial"));assert.ok(f.events.some(e=>e.type==="usage"));
  assert.equal(f.events.filter(e=>e.type==="turn.status").length,2);assert.equal(JSON.stringify(f.events).includes(f.connection.apiKey),false);
  assert.equal(fs.statSync(path.join(f.root,"openwebui-session.json")).mode&0o777,0o600);
});
test("Open WebUI tolerates completion racing with the last empty task poll",async t=>{
  const f=await fixture(t);f.setMode("race");const adapter=new OpenWebUIAdapter(f.ctx);await adapter.start();await adapter.prompt([{type:"text",text:"Hello"}]);adapter.close();
  assert.ok(f.events.some(e=>e.type==="turn.status"));
});
test("Open WebUI incomplete execution is not successful and is never resubmitted on restart",async t=>{
  const f=await fixture(t);f.setMode("incomplete");const adapter=new OpenWebUIAdapter(f.ctx);await adapter.start();await assert.rejects(adapter.prompt([{type:"text",text:"Hello"}]),/without a completed response/u);adapter.close();
  const next=new OpenWebUIAdapter(f.ctx);await next.start();await assert.rejects(next.prompt([{type:"text",text:"Again"}]),/not been reconciled/u);next.close();
  assert.equal(f.requests.filter(v=>v.path.endsWith("/chat/completions")).length,1);assert.equal(f.events.some(e=>e.type==="turn.status"),false);
});
test("Open WebUI errors, denied access, bad acknowledgements and redirects never claim completion or expose the key",async t=>{
  for(const mode of ["error","unauthorized","bad-ack","redirect"]){await t.test(mode,async t=>{
    const f=await fixture(t);f.setMode(mode);const adapter=new OpenWebUIAdapter(f.ctx);await adapter.start();await assert.rejects(adapter.prompt([{type:"text",text:"Hello"}]),e=>!String(e).includes(f.connection.apiKey));adapter.close();assert.equal(f.events.some(e=>e.type==="turn.status"),false);
  });}
});
