import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {HostHarnessRuntime} from './harness-runtime/runtime.js';
import {InstanceRelay,INSTANCE_RELAY_MODEL} from './instance-relay.js';

async function fixture(t:any){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'multivibe-instance-')),account=randomUUID(),machine=randomUUID();let now=Date.now(),calls=0;
 const integration={list:async()=>[{id:'pi',detected:true,configured:true}],executablePath:async(id:string)=>id==='pi'?process.execPath:null} as any;
 const runtime=new HostHarnessRuntime(path.join(root,'runtime'),integration,ctx=>({
  start:async()=>{},prompt:async()=>{calls++;ctx.emit({type:'message.delta',payload:{role:'assistant',text:'Verified response '+calls}});},
  inspect:async()=>[{id:'fixture/model',name:'Fixture'}],interrupt:async()=>{},compact:async()=>{},configure:async()=>{},native:async()=>{},close:()=>{}
 }));
 const file=path.join(root,'instance.json'),urls:string[]=[];
 const fetcher=(async(input:URL|string,options:any)=>{
  const u=new URL(String(input));urls.push(u.origin+u.pathname);assert.equal(u.origin,'https://app.multivibe.cloud');assert.equal(options.redirect,'error');
  if(u.pathname==='/relay/v1/machines')return Response.json({id:machine,token:'mvr_'+randomBytes(32).toString('base64url')});
  if(u.pathname.endsWith('/heartbeat'))return Response.json({accepted:true});
  if(u.pathname.endsWith('/jobs'))return Response.json({job:null});
  return Response.json({revoked:true});
 }) as typeof fetch;
 const service=new InstanceRelay(runtime,file,fetcher,()=>now);
 t.after(async()=>{service.stop();await runtime.close();fs.rmSync(root,{recursive:true,force:true});});
 await service.connect('synthetic-native-session','Fixture Mac');
 for(let i=0;i<20&&!service.status().running;i++)await new Promise(r=>setTimeout(r,5));
 const handoff=service.pairing();service.stop();
 const envelope=(fields:any)=>({model:INSTANCE_RELAY_MODEL,messages:[{role:'user',content:JSON.stringify({version:1,accountId:account,machineId:machine,...fields})}],stream:true});
 const send=async(fields:any)=>{const chunks:string[]=[];await service.dispatch(envelope(fields),async data=>{chunks.push(data);},AbortSignal.timeout(3000));return chunks.join('');};
 const pair=async()=>JSON.parse(await send({operation:'pair',handoff:handoff.code,name:'Fixture iPhone'}));
 return {service,runtime,file,account,machine,handoff,envelope,send,pair,urls,calls:()=>calls,advance:(ms:number)=>{now+=ms;}};
}
test('handoff is single-use, machine-bound, expires and never persists the device token',async t=>{
 const f=await fixture(t),pair=await f.pair();
 assert.match(f.handoff.code,/^[A-HJ-NP-Z2-9]{12}$/);
 assert.equal(pair.deviceToken.length,43);assert.equal(pair.expiresAt-f.handoff.expiresAt,24*3600_000-5*60_000);
 assert.ok(!fs.readFileSync(f.file,'utf8').includes(pair.deviceToken));assert.equal(fs.statSync(f.file).mode&0o777,0o600);
 await assert.rejects(f.pair(),/expired or invalid/);
 const wrong={...f.envelope({operation:'catalog',deviceId:pair.deviceId,deviceToken:pair.deviceToken})} as any;
 const body=JSON.parse(wrong.messages[0].content);body.machineId=randomUUID();wrong.messages[0].content=JSON.stringify(body);
 await assert.rejects(f.service.dispatch(wrong,async()=>{},AbortSignal.timeout(1000)),/mismatch/);
 f.advance(24*3600_000+1);await assert.rejects(f.send({operation:'catalog',deviceId:pair.deviceId,deviceToken:pair.deviceToken}),/expired or revoked/);
});
test('bounded guesses invalidate a handoff and expired handoffs cannot enroll',async t=>{
 const f=await fixture(t);for(let i=0;i<8;i++)await assert.rejects(f.send({operation:'pair',handoff:'WRONG0000000',name:'Test'}));await assert.rejects(f.pair());
 const g=await fixture(t);g.advance(5*60_000+1);await assert.rejects(g.pair());
});
test('rotation has bounded lost-response recovery and local revocation immediately denies access',async t=>{
 const f=await fixture(t),a=await f.pair(),auth={deviceId:a.deviceId,deviceToken:a.deviceToken};
 const b=JSON.parse(await f.send({...auth,operation:'renew'})),retry=JSON.parse(await f.send({...auth,operation:'renew'}));assert.equal(b.deviceToken,retry.deviceToken);
 f.advance(60_001);await assert.rejects(f.send({...auth,operation:'catalog'}),/expired or revoked/);
 assert.ok(JSON.parse(await f.send({operation:'catalog',deviceId:b.deviceId,deviceToken:b.deviceToken})).harnesses.length);
 f.service.revokeDevice(b.deviceId);await assert.rejects(f.send({operation:'catalog',deviceId:b.deviceId,deviceToken:b.deviceToken}),/expired or revoked/);
});
test('mobile turns use desktop receipts, recover without dispatch and keep other devices isolated',async t=>{
 const f=await fixture(t),a=await f.pair(),auth={deviceId:a.deviceId,deviceToken:a.deviceToken},conversationId=randomUUID(),commandId=randomUUID();
 const prompt={...auth,operation:'prompt',harnessId:'pi',model:'fixture/model',conversationId,commandId,text:'One turn'};
 const result=await f.send(prompt);assert.match(result,/Verified response 1/);assert.match(result,/completed/);assert.equal(f.calls(),1);
 assert.match(await f.send({...auth,operation:'recover',conversationId,commandId}),/Verified response 1/);assert.equal(f.calls(),1);
 await f.send(prompt);assert.equal(f.calls(),1);
 await assert.rejects(f.send({...prompt,text:'Changed request'}),/different content/);
 const second=randomUUID();const next=await f.send({...prompt,commandId:second,text:'Two turns'});assert.match(next,/Verified response 2/);assert.doesNotMatch(next,/Verified response 1/);
 await assert.rejects(f.send({...auth,deviceId:randomUUID(),operation:'recover',conversationId,commandId}),/expired or revoked/);
 assert.equal(f.urls.filter(u=>u.includes('native/v1/auth/session')).length,0);
});
