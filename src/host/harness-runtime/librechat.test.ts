import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibreChatAdapter, LibreChatConfiguration, libreChatEndpoint } from "./librechat.js";
import { capabilities, type AdapterContext } from "./types.js";

async function fixture(t:any) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"librechat-test-"));
  const requests:any[]=[];let stream="normal";
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,"Bearer private-fixture-key");
    if(req.url?.endsWith("/models")){res.setHeader("content-type","application/json");res.end(JSON.stringify({data:[{id:"agent-1",name:"Test agent"}]}));return;}
    let body="";for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
    if(stream==="unauthorized"){res.writeHead(401).end("private-fixture-key");return;}
    if(stream==="redirect"){res.writeHead(302,{location:"http://127.0.0.1:1/steal"}).end();return;}
    if(stream==="json"){res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:"Non-streaming reply"},finish_reason:"stop"}]}));return;}
    res.setHeader("content-type","text/event-stream");
    const chunk=(v:any)=>res.write("data: "+JSON.stringify(v)+"\r\n\r\n");
    chunk({choices:[{delta:{reasoning:"thinking"}}]});
    chunk({choices:[{delta:{content:"Bonjour é"}}]});
    if(stream!=="truncated")chunk({choices:[{delta:{},finish_reason:"stop"}],usage:{total_tokens:4}});
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});});
  const connection={endpoint:libreChatEndpoint(endpoint),apiKey:"private-fixture-key",agentId:"agent-1"};
  return {root,requests,endpoint,connection,setStream:(v:string)=>{stream=v;}};
}
test("LibreChat normalizes root and API endpoints and refuses embedded credentials",()=>{
  assert.equal(libreChatEndpoint("https://example.com/chat/"),"https://example.com/chat/api/agents/v1");
  assert.equal(libreChatEndpoint("https://example.com/api/agents/v1/"),"https://example.com/api/agents/v1");
  for(const url of ["file:///tmp/key","https://user:key@example.com","https://example.com/?key=private"])assert.throws(()=>libreChatEndpoint(url));
});
test("LibreChat validates credentials and agents before private storage, never returns the key",async t=>{
  const f=await fixture(t),config=new LibreChatConfiguration(f.root);
  assert.equal(config.descriptor().available,false);
  assert.deepEqual(await config.configure({...f.connection,discover:true}),{agents:[{id:"agent-1",name:"Test agent"}]});
  assert.equal(config.read(),undefined);
  await assert.rejects(config.configure({...f.connection,agentId:"missing"}),/available/u);
  const result=await config.configure(f.connection);
  assert.equal(JSON.stringify(result).includes(f.connection.apiKey),false);
  assert.equal(fs.statSync(path.join(f.root,"librechat-connection.json")).mode&0o777,0o600);
  await config.configure({...f.connection,apiKey:""});
  await assert.rejects(config.configure({...f.connection,endpoint:"http://other.example",apiKey:""}),/API key/u);
});
test("LibreChat completes two-factor and backup-code challenges without persisting transient secrets",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"librechat-2fa-test-"));
  const calls:Array<{route:string;body:any}>=[];let challenge=0;
  const server=http.createServer(async(req,res)=>{
    let text="";for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):undefined;
    const route=new URL(req.url!,"http://localhost").pathname;calls.push({route,body});
    const send=(value:any,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value));};
    assert.equal(req.headers.origin,`http://127.0.0.1:${(server.address() as any).port}`);
    if(route==="/api/auth/login"){
      assert.deepEqual(body,{email:"fixture@example.com",password:"private-password"});
      send({twoFAPending:true,tempToken:`private-challenge-${++challenge}`});return;
    }
    if(route==="/api/auth/2fa/verify-temp"){
      if(body.token==="000000"){send({message:"private upstream rejection"},401);return;}
      assert.ok(body.token==="123456" || body.backupCode==="private-backup-code");
      res.setHeader("set-cookie","refreshToken=private-refresh; Path=/; HttpOnly");
      send({token:"private-user-token",user:{id:"account-1"}});return;
    }
    assert.equal(req.headers.authorization,"Bearer private-user-token");
    assert.match(req.headers.cookie!,/private-refresh/u);
    if(route==="/api/agents"){send({data:[{id:"agent-1",name:"Native agent"}]});return;}
    if(route==="/api/convos"){send({conversations:[]});return;}
    send({error:"unexpected"},404);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});});
  const config=new LibreChatConfiguration(root);
  const prompted=await config.configure({endpoint,email:"fixture@example.com",password:"private-password",discover:true});
  assert.deepEqual(prompted,{twoFactorRequired:true,twoFactorToken:"private-challenge-1"});
  assert.equal(config.read(),undefined);
  const discovered=await config.configure({endpoint,twoFactorToken:prompted.twoFactorToken,twoFactorCode:"123456",discover:true});
  assert.deepEqual(discovered.agents,[{id:"agent-1",name:"Native agent"}]);
  assert.equal(typeof discovered.connectionAttemptId,"string");
  assert.equal(JSON.stringify(discovered).includes("private-user-token"),false);
  assert.equal(config.read(),undefined);
  const saved=await config.configure({endpoint,connectionAttemptId:discovered.connectionAttemptId,agentId:"agent-1"});
  assert.equal("hasUserSession" in saved && saved.hasUserSession,true);
  const privateFile=fs.readFileSync(path.join(root,"librechat-connection.json"),"utf8");
  for(const transient of ["private-password","private-challenge-1","123456","private-backup-code"])assert.equal(privateFile.includes(transient),false);
  const before=privateFile;
  const invalid=await config.configure({endpoint,email:"fixture@example.com",password:"private-password",discover:true});
  await assert.rejects(config.configure({endpoint,twoFactorToken:invalid.twoFactorToken,twoFactorCode:"000000",discover:true}),error=>!String(error).includes("private upstream rejection") && /invalid or expired/u.test(String(error)));
  assert.equal(fs.readFileSync(path.join(root,"librechat-connection.json"),"utf8"),before);
  const backup=await config.configure({endpoint,email:"fixture@example.com",password:"private-password",discover:true});
  const backupResult=await config.configure({endpoint,twoFactorToken:backup.twoFactorToken,twoFactorBackupCode:"private-backup-code",discover:true});
  assert.deepEqual(backupResult.agents,[{id:"agent-1",name:"Native agent"}]);
  assert.ok(calls.some(call=>call.route==="/api/auth/2fa/verify-temp" && call.body.backupCode==="private-backup-code"));
});
test("LibreChat streams text, reasoning and usage, retains context after adapter restart",async t=>{
  const f=await fixture(t),events:any[]=[];
  const ctx={root:f.root,session:{id:"session",model:"agent-1",capabilities:capabilities()},target:{kind:"local"},libreChatConnection:f.connection,emit:(e:any)=>events.push(e),capabilities:()=>{}} as unknown as AdapterContext;
  const first=new LibreChatAdapter(ctx);await first.start();await first.prompt([{type:"text",text:"Bonjour"}]);first.close();
  const second=new LibreChatAdapter(ctx);await second.start();await second.prompt([{type:"text",text:"Suite"}]);second.close();
  assert.equal(f.requests[1].model,"agent-1");
  assert.deepEqual(f.requests[1].messages,[{role:"user",content:"Bonjour"},{role:"assistant",content:"Bonjour é"},{role:"user",content:"Suite"}]);
  assert.equal(events.filter(e=>e.type==="message.delta").length,2);
  assert.ok(events.some(e=>e.type==="usage"));assert.ok(events.some(e=>e.type==="reasoning"));
  assert.equal(JSON.stringify(events).includes(f.connection.apiKey),false);
});
test("LibreChat rejects truncated streams, redirects and auth errors without storing a successful turn or leaking the key",async t=>{
  const f=await fixture(t),events:any[]=[];
  const ctx={root:f.root,session:{model:"agent-1"},target:{kind:"local"},libreChatConnection:f.connection,emit:(e:any)=>events.push(e)} as unknown as AdapterContext;
  for(const mode of ["truncated","redirect","unauthorized"]){f.setStream(mode);const adapter=new LibreChatAdapter(ctx);await adapter.start();await assert.rejects(adapter.prompt([{type:"text",text:"Test"}]),e=>!String(e).includes(f.connection.apiKey));adapter.close();}
  assert.equal(fs.existsSync(path.join(f.root,"librechat-history.json")),false);
  assert.equal(events.some(e=>e.type==="turn.status"),false);
});

 test("LibreChat accepts JSON fallback when streaming is disabled by the agent",async t=>{
  const f=await fixture(t);f.setStream("json");const events:any[]=[];
  const ctx={root:f.root,session:{model:"agent-1"},target:{kind:"local"},libreChatConnection:f.connection,emit:(e:any)=>events.push(e)} as unknown as AdapterContext;
  const adapter=new LibreChatAdapter(ctx);await adapter.start();await adapter.prompt([{type:"text",text:"Test"}]);adapter.close();
  assert.ok(events.some(e=>e.type==="message.delta" && e.payload.text==="Non-streaming reply"));
  assert.ok(events.some(e=>e.type==="turn.status"));
});
