import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { HostHarnessRuntime } from "./runtime.js";
import { harnessRuntimeRoutes } from "./routes.js";
import { RemoteChats } from "./remote-chats.js";
import { RemoteChatConfiguration, remoteConnectionId } from "./librechat.js";

// Contracts: LibreChat /api/convos, /messages and /agents/chat; Open WebUI /api/v1/chats.
// The fixture is a separate server with a web-client writer, not the Desktop cache.
async function fixture(t:any,id:"librechat"|"openwebui"){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"multivibe-remote-chats-"));
  const messages:any[]=[{messageId:"u1",isCreatedByUser:true,text:"From web",parentMessageId:null,createdAt:"2026-10-24T10:00:00Z"},{messageId:"a1",isCreatedByUser:false,content:[{type:"text",text:"Saved answer"}],parentMessageId:"u1",createdAt:"2026-10-24T10:00:01Z"}];
  const owMessages:any={u1:{id:"u1",role:"user",content:"From web",parentId:null},a1:{id:"a1",role:"assistant",content:"Saved answer",parentId:"u1",done:true}};
  let convo:any={conversationId:"remote-1",title:"Server title",updatedAt:"2026-10-24T10:00:01Z",agent_id:"agent-1",endpoint:"agents",pinned:false,isArchived:false};
  let ow:any={id:"remote-1",title:"Server title",updated_at:1792836001,pinned:false,archived:false,chat:{title:"Server title",models:["agent-1"],history:{messages:owMessages,currentId:"a1"}}};
  let refreshes=0,deny=false,refreshNeeded=false,ackMode=false;
  const calls:any[]=[];
  const server=http.createServer(async(req,res)=>{
    let text="";for await(const c of req)text+=c;const body=text?JSON.parse(text):undefined;
    const u=new URL(req.url!,"http://localhost"),route=u.pathname;calls.push({route,method:req.method,body});
    const send=(v:any,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(v));};
    if(route==="/prefix/api/auth/login"){
      assert.equal(body.email,"fixture@example.com");assert.equal(body.password,"private-password");
      res.setHeader("set-cookie","refreshToken=private-refresh; Path=/; HttpOnly");send({token:"private-user-token",user:{id:"account-1"}});return;
    }
    if(route==="/prefix/api/auth/refresh"){
      assert.match(req.headers.cookie!,/private-refresh/u);refreshes++;refreshNeeded=false;send({token:"private-user-token-refreshed"});return;
    }
    if(deny){send({error:"private-user-token"},403);return;}
    const expected=id==="librechat"?(refreshes?"private-user-token-refreshed":"private-user-token"):"private-ow-key";
    assert.equal(req.headers.authorization,`Bearer ${expected}`);
    if(refreshNeeded){send({},401);return;}
    if(route==="/prefix/api/agents"){send({data:[{id:"agent-1",name:"Native agent"}]});return;}
    if(route==="/prefix/api/models"){send({data:[{id:"agent-1"}]});return;}
    if(route==="/prefix/api/v1/auths/"){send({id:"account-1"});return;}
    if(route==="/prefix/api/convos"){
      if(req.method==="DELETE"){assert.equal(body.arg.conversationId,"remote-1");convo=undefined;send({deletedCount:1});return;}
      send({conversations:convo && String(convo.isArchived)===u.searchParams.get("isArchived")?[convo]:[],nextCursor:null});return;
    }
    if(route==="/prefix/api/convos/remote-1"){send(convo);return;}
    if(route==="/prefix/api/messages/remote-1"){send(messages);return;}
    if(route==="/prefix/api/convos/update"){convo.title=body.title;send(convo);return;}
    if(route==="/prefix/api/convos/archive"){convo.isArchived=body.arg.isArchived;send(convo);return;}
    if(route==="/prefix/api/convos/pin"){convo.pinned=body.arg.pinned;send(convo);return;}
    const final=()=>{
      assert.equal(calls.filter(v=>v.route==="/prefix/api/agents/chat").at(-1).body.parentMessageId,messages.at(-1).messageId);
      const request=calls.filter(v=>v.route==="/prefix/api/agents/chat").at(-1).body;
      messages.push({messageId:"u2",isCreatedByUser:true,text:request.text,parentMessageId:request.parentMessageId,createdAt:"2026-10-25T10:00:01Z"},{messageId:"a2",isCreatedByUser:false,text:"Native reply",parentMessageId:"u2",createdAt:"2026-10-25T10:00:02Z"});
      res.writeHead(200,{"content-type":"text/event-stream"});res.end(`data: ${JSON.stringify({final:true,conversation:convo,responseMessage:messages.at(-1)})}\n\n`);
    };
    if(route==="/prefix/api/agents/chat"){
      assert.equal(body.conversationId,"remote-1");assert.equal(body.agent_id,"agent-1");
      if(ackMode){send({conversationId:"remote-1",streamId:"remote-1",generationCreatedAt:123});return;}final();return;
    }
    if(route==="/prefix/api/agents/chat/stream/remote-1"){final();return;}
    if(route==="/prefix/api/v1/chats/" || route==="/prefix/api/v1/chats/archived"){
      const archived=route.endsWith("archived");send(ow && ow.archived===archived?[{id:ow.id,title:ow.title,updated_at:ow.updated_at,pinned:ow.pinned,archived}]:[]);return;
    }
    if(route==="/prefix/api/v1/chats/remote-1"){
      if(req.method==="DELETE"){ow=undefined;send(true);return;}
      if(body){ow.chat={...ow.chat,...body.chat};if(body.chat.title)ow.title=body.chat.title;}
      send(ow);return;
    }
    if(route==="/prefix/api/v1/chats/remote-1/archive"){ow.archived=!ow.archived;send(ow);return;}
    if(route==="/prefix/api/v1/chats/remote-1/pin"){ow.pinned=!ow.pinned;send(ow);return;}
    if(route==="/prefix/api/chat/completions"){
      assert.ok(body.messages.some((v:any)=>v.content==="From another client"));
      const last=ow.chat.history.messages[ow.chat.history.currentId];last.done=true;last.content="Native reply";
      send({status:true,task_ids:["task"]});return;
    }
    send({error:"Unexpected route"},404);
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}/prefix`;
  const runtime=new HostHarnessRuntime(root,{list:async()=>[],executablePath:async()=>null} as any);
  const config=runtime[id];
  const input=id==="librechat"?{endpoint,email:"fixture@example.com",password:"private-password",agentId:"agent-1"}:{endpoint,apiKey:"private-ow-key",agentId:"agent-1"};
  await config.configure(input);
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});});
  return {root,runtime,config,input,remote:new RemoteChats(id,config),messages,ow:()=>ow,calls,deny:()=>{deny=true;},expire:()=>{refreshNeeded=true;},refreshes:()=>refreshes,ack:()=>{ackMode=true;}};
}
for(const id of ["librechat","openwebui"] as const){
  test(`${id} lists server conversations, imports once, resumes native history and synchronizes remote edits`,async t=>{
    const f=await fixture(t,id);const list=await f.remote.list();assert.equal(list.complete,true);assert.equal(list.conversations.length,1);
    const initial=await f.remote.snapshot("remote-1");assert.deepEqual(initial.messages.map(v=>v.content),["From web","Saved answer"]);
    const input={harnessId:id,connectionId:list.connectionId,remoteChatId:"remote-1"};
    const [session,again]=await Promise.all([f.runtime.connectRemoteChat(input),f.runtime.connectRemoteChat(input)]);
    assert.equal((await f.runtime.models({harnessId:id})).models[0].id,"agent-1");
    assert.equal(session.id,again.id);assert.equal(session.nativeSessionId,"remote-1");assert.equal(session.model,"agent-1");
    // A different native client changes the active branch after Desktop imported it.
    if(id==="librechat")f.messages.push({messageId:"external",isCreatedByUser:false,text:"From another client",parentMessageId:"a1",createdAt:"2026-10-25T10:00:00Z"});
    else{const chat=f.ow().chat;chat.history.messages.external={id:"external",role:"assistant",content:"From another client",parentId:"a1",done:true};chat.history.currentId="external";}
    const changed=await f.remote.snapshot("remote-1");assert.notEqual(changed.revision,initial.revision);assert.equal(changed.messages.at(-1)?.content,"From another client");
    const receipt=await f.runtime.command(session.id,{id:"send-native",type:"prompt",parts:[{type:"text",text:"Continue here"}]});
    const deadline=Date.now()+4000;
    while(!["completed","failed"].includes(f.runtime.store.receipt(receipt.id)!.state)){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}
    assert.equal(f.runtime.store.receipt(receipt.id)?.state,"completed",JSON.stringify(f.runtime.store.receipt(receipt.id)));
    assert.equal((await f.remote.snapshot("remote-1")).messages.at(-1)?.content,"Native reply");
    await f.remote.update("remote-1",{title:"Renamed from Desktop",pinned:true,archived:true});
    const listed=await f.remote.list();assert.equal(listed.conversations[0].title,"Renamed from Desktop");assert.equal(listed.conversations[0].archived,true);assert.equal(listed.conversations[0].pinned,true);
    const exported=JSON.stringify({configuration:f.config.publicConfiguration(),events:f.runtime.store.events(session.id),snapshot:f.runtime.snapshot(session.id)});
    for(const secret of ["private-password","private-user-token","private-refresh","private-ow-key"])assert.equal(exported.includes(secret),false);
    await f.remote.delete("remote-1");assert.equal((await f.remote.list()).conversations.length,0);
  });
  test(`${id} account replacement refuses old-session writes and denied catalogs never become an empty success`,async t=>{
    const f=await fixture(t,id);const identity=f.remote.identity();
    const session=await f.runtime.connectRemoteChat({harnessId:id,connectionId:identity.connectionId,remoteChatId:"remote-1"});
    f.deny();await assert.rejects(f.remote.list(),e=>!String(e).includes("private-"));
    const file=path.join(f.root,`${id}-connection.json`);const saved=JSON.parse(fs.readFileSync(file,"utf8"));saved.userId="different-account";fs.writeFileSync(file,JSON.stringify(saved),{mode:0o600});
    assert.notEqual(remoteConnectionId(saved),identity.connectionId);assert.throws(()=>f.remote.identity(),/original remote account/u);
    await assert.rejects(f.runtime.connectRemoteChat({harnessId:id,connectionId:identity.connectionId,remoteChatId:"remote-1"}),/original remote account/u);
  });
}
test("LibreChat refreshes its account session without saving the password and uses resumable native ingress",async t=>{
  const f=await fixture(t,"librechat");assert.equal(JSON.stringify(f.config.read()).includes("private-password"),false);
  f.expire();await f.remote.list();assert.equal(f.refreshes(),1);f.ack();
  const session=await f.runtime.connectRemoteChat({harnessId:"librechat",connectionId:f.remote.identity().connectionId,remoteChatId:"remote-1"});
  const receipt=await f.runtime.command(session.id,{id:"resumable-prompt",type:"prompt",parts:[{type:"text",text:"Resume"}]});
  const deadline=Date.now()+3000;while(f.runtime.store.receipt(receipt.id)?.state==="queued" || f.runtime.store.receipt(receipt.id)?.state==="accepted" || f.runtime.store.receipt(receipt.id)?.state==="dispatching"){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}
  assert.equal(f.runtime.store.receipt(receipt.id)?.state,"completed",f.runtime.store.receipt(receipt.id)?.error);
  assert.ok(f.calls.some(v=>v.route==="/prefix/api/agents/chat/stream/remote-1"));
});
test("remote chat API checks connection identity and omits raw server records",async t=>{
  const f=await fixture(t,"openwebui");const app=express();app.use(harnessRuntimeRoutes(f.runtime));const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const list=await (await fetch(base+"/remote-chats?harnessId=openwebui")).json();assert.equal(list.conversations[0].id,"remote-1");
  const snapshot=await (await fetch(base+"/remote-chats/remote-1?harnessId=openwebui")).json();assert.equal("native" in snapshot.conversation,false);
  const rejected=await fetch(base+"/sessions/remote",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({harnessId:"openwebui",remoteChatId:"remote-1",connectionId:"wrong"})});assert.equal(rejected.status,409);
});
