import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {HostHarnessRuntime} from './harness-runtime/runtime.js';
import {InstanceConversations} from './instance-conversations.js';
import {InstanceRelay,INSTANCE_RELAY_MODEL,instanceRelayChunks} from './instance-relay.js';

async function fixture(t:any,options:{prompt?:()=>Promise<void>}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'multivibe-instance-')),account=randomUUID(),machine=randomUUID();let now=Date.now(),calls=0;
 const configurations:Record<string,unknown>[]=[],workspace=path.join(root,'project');fs.mkdirSync(workspace);
 const projectId=createHash('sha256').update('pi:'+workspace).digest('hex');
 const integration={list:async()=>[{id:'pi',detected:true,configured:true}],executablePath:async(id:string)=>id==='pi'?process.execPath:null} as any;
 const runtime=new HostHarnessRuntime(path.join(root,'runtime'),integration,ctx=>({
  start:async()=>{},prompt:async()=>{calls++;ctx.emit({type:'message.delta',payload:{role:'assistant',text:'Verified response '+calls}});await options.prompt?.();},
  inspect:async subject=>subject==='effort'?{options:[{value:'low',label:'Low'},{value:'high',label:'High'}],defaultValue:'low'}:[{id:'fixture/model',name:'Fixture'}],interrupt:async()=>{},compact:async()=>{},configure:async value=>{configurations.push(value);},native:async()=>{},close:()=>{}
 }));
 runtime.projects=()=>({projects:[{id:projectId,harnessId:'pi',name:'Fixture project',path:workspace,updatedAt:now}]});
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
 return {service,runtime,file,account,machine,handoff,envelope,send,pair,urls,configurations,projectId,workspace,calls:()=>calls,advance:(ms:number)=>{now+=ms;}};
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
test('mobile turn tracking remains attached beyond the former Host deadline',async t=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const f=await fixture(t,{prompt:()=>gate}),a=await f.pair(),auth={deviceId:a.deviceId,deviceToken:a.deviceToken};
 const pending=f.send({...auth,operation:'prompt',harnessId:'pi',model:'fixture/model',conversationId:randomUUID(),commandId:randomUUID(),text:'Long turn'});
 for(let i=0;i<100&&f.calls()===0;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(f.calls(),1);f.advance(250_001);
 let settled=false;void pending.finally(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,250));assert.equal(settled,false);
 release();assert.match(await pending,/completed/);assert.equal(f.calls(),1);
});
test('project and effort discovery expose bounded metadata and reject client supplied paths',async t=>{
 const f=await fixture(t),a=await f.pair(),auth={deviceId:a.deviceId,deviceToken:a.deviceToken};
 const projects=JSON.parse(await f.send({...auth,operation:'projects',harnessId:'pi'}));assert.ok(projects.projects.every((project:any)=>!('path' in project)));
 const effort=JSON.parse(await f.send({...auth,operation:'effort',harnessId:'pi',model:'fixture/model'}));assert.ok('effort' in effort);
 await assert.rejects(f.send({...auth,operation:'prompt',harnessId:'pi',model:'fixture/model',projectId:'/tmp/injected',conversationId:randomUUID(),commandId:randomUUID(),text:'no'}),/Invalid project/);
 const conversationId=randomUUID(),commandId=randomUUID();
 await f.send({...auth,operation:'prompt',harnessId:'pi',model:'fixture/model',projectId:f.projectId,effort:'high',conversationId,commandId,text:'project turn'});
 const session=f.runtime.store.sessions()[0];assert.equal(session.workspace,fs.realpathSync(f.workspace));assert.equal(session.configuration?.effort,'high');
 assert.doesNotMatch(JSON.stringify(projects),new RegExp(f.workspace));
});
test('model and effort changes share durable desktop commands and cannot cross device sessions',async t=>{
 const f=await fixture(t),a=await f.pair(),auth={deviceId:a.deviceId,deviceToken:a.deviceToken},conversationId=randomUUID();
 await f.send({...auth,operation:'prompt',harnessId:'pi',model:'fixture/model',conversationId,commandId:randomUUID(),text:'first'});
 const change={...auth,operation:'configure',conversationId,commandId:randomUUID(),model:'fixture/second'};
 assert.equal(JSON.parse(await f.send(change)).state,'completed');const count=f.configurations.length;
 await f.send(change);assert.equal(f.configurations.length,count);
 await assert.rejects(f.send({...change,model:'fixture/third'}),/different content/);
 await assert.rejects(f.send({...change,projectId:f.projectId}),/project is fixed/);
 await assert.rejects(f.send({...change,conversationId:randomUUID()}),/not found/i);
 const effort={...auth,operation:'configure',conversationId,commandId:randomUUID(),effort:'high'};
 assert.equal(JSON.parse(await f.send(effort)).state,'completed');assert.equal(f.runtime.store.sessions()[0].configuration?.effort,'high');
 assert.equal(JSON.parse(await f.send({...auth,operation:'interrupt',conversationId,commandId:randomUUID()})).state,'completed');
 assert.match(await f.send({...auth,operation:'prompt',harnessId:'pi',model:'fixture/second',conversationId,commandId:randomUUID(),text:'after stop'}),/Verified response 2/);
});

test('paired devices discover Desktop sessions and read paginated stable history without starting adapters',async t=>{
 const f=await fixture(t),a=await f.pair(),auth={deviceId:a.deviceId,deviceToken:a.deviceToken};
 const session=await f.runtime.create({harnessId:'pi',model:'fixture/model',title:'Created outside iOS'});
 for(let i=0;i<105;i++)f.runtime.store.event(session.id,'message.part',{role:'assistant',text:'Historical '+i},undefined,'row-'+i);
 const targets=JSON.parse(await f.send({...auth,operation:'conversation-targets'}));assert.ok(targets.targets.some((v:any)=>v.id==='local'));
 const catalog=JSON.parse(await f.send({...auth,operation:'conversations',targetId:'local',page:0}));
 const row=catalog.conversations.find((v:any)=>v.source.id===session.id);assert.equal(row.title,'Created outside iOS');assert.ok(!JSON.stringify(row).includes(session.workspace));
 const first=JSON.parse(await f.send({...auth,operation:'conversation-history',source:row.source}));assert.equal(first.messages.length,100);assert.equal(first.nextOffset,100);
 const second=JSON.parse(await f.send({...auth,operation:'conversation-history',source:row.source,offset:first.nextOffset,revision:first.revision}));assert.equal(second.messages.length,5);assert.equal(second.nextOffset,null);
 assert.equal(f.calls(),0);assert.equal(f.runtime.store.sessions().length,1);
 await assert.rejects(f.send({...auth,operation:'conversation-history',source:{...row.source,harnessId:'opencode'}}),/harness changed/);
 await assert.rejects(f.send({...auth,operation:'conversations',targetId:'missing',page:0}),/not found/i);
 await assert.rejects(f.send({...auth,operation:'conversations',page:-1}),/Invalid catalog/);
 await assert.rejects(f.send({...auth,deviceToken:'wrong',operation:'conversations'}),/expired or revoked/);
 f.runtime.store.event(session.id,'message.part',{role:'assistant',text:'New'},undefined,'new');
 await assert.rejects(f.send({...auth,operation:'conversation-history',source:row.source,offset:100,revision:first.revision}),/changed during pagination/);
});

test('discovered Desktop sessions continue idempotently in their owning session and mobile-created rows retain their identity',async t=>{
 const f=await fixture(t),a=await f.pair(),auth={deviceId:a.deviceId,deviceToken:a.deviceToken};
 const session=await f.runtime.create({harnessId:'pi',model:'fixture/model',title:'Desktop'});
 const source={targetId:'local',kind:'session',id:session.id,harnessId:'pi'};
 const prompt={...auth,operation:'prompt',source,conversationId:randomUUID(),commandId:randomUUID(),model:'fixture/model',text:'From iPhone'};
 assert.match(await f.send(prompt),/conversation.bound/);await f.send(prompt);assert.equal(f.calls(),1);assert.equal(f.runtime.store.sessions().length,1);
 const history=JSON.parse(await f.send({...auth,operation:'conversation-history',source}));
 assert.ok(history.messages.some((v:any)=>v.role==='user'&&v.content==='From iPhone'));
 assert.ok(history.messages.some((v:any)=>v.content==='Verified response 1'));
 const conversationId=randomUUID();await f.send({...auth,operation:'prompt',harnessId:'pi',model:'fixture/model',conversationId,commandId:randomUUID(),text:'New mobile conversation'});
 const catalog=JSON.parse(await f.send({...auth,operation:'conversations'}));assert.equal(catalog.conversations.filter((v:any)=>v.conversationId===conversationId).length,1);
});

test('native CLI histories are read without mutation and replies create exactly one isolated fork',async t=>{
 const priorHome=process.env.HOME,home=fs.mkdtempSync(path.join(os.tmpdir(),'instance-native-home-'));process.env.HOME=home;
 t.after(()=>{if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome;fs.rmSync(home,{recursive:true,force:true});});
 const folder=path.join(home,'.pi/agent/sessions');fs.mkdirSync(folder,{recursive:true});
 const file=path.join(folder,'external.jsonl'),nativeId=randomUUID();
 const original=JSON.stringify({type:'session',id:nativeId,cwd:home})+'\n'+JSON.stringify({type:'message',id:'u1',message:{role:'user',content:'External user'}})+'\n';fs.writeFileSync(file,original);
 const f=await fixture(t),a=await f.pair(),auth={deviceId:a.deviceId,deviceToken:a.deviceToken};
 const catalog=JSON.parse(await f.send({...auth,operation:'conversations'}));const native=catalog.conversations.find((v:any)=>v.source.kind==='native');assert.ok(native);assert.equal(native.canContinue,true);
 const history=JSON.parse(await f.send({...auth,operation:'conversation-history',source:native.source}));assert.equal(history.messages[0].content,'External user');assert.equal(f.runtime.store.sessions().length,0);assert.equal(f.calls(),0);
 const prompt={...auth,operation:'prompt',source:native.source,conversationId:randomUUID(),commandId:randomUUID(),model:'fixture/model',text:'Continue externally created history'};
 const stream=await f.send(prompt);await f.send(prompt);assert.equal(f.runtime.store.sessions().length,1);assert.equal(f.calls(),1);assert.equal(fs.readFileSync(file,'utf8'),original);
 const bound=JSON.parse(stream.split('\n').find(v=>v.includes('conversation.bound'))!.slice(6)).source;
 const forkHistory=JSON.parse(await f.send({...auth,operation:'conversation-history',source:bound}));assert.equal(forkHistory.messages[0].content,'External user');assert.ok(forkHistory.messages.some((v:any)=>v.content==='Verified response 1'));
 assert.equal(JSON.parse(await f.send({...auth,operation:'conversations'})).conversations.filter((v:any)=>v.source.kind==='native').length,0);
});


test('registered environments use their own bridge, never the Mac history, and server identities remain bound',async t=>{
 const f=await fixture(t),calls:string[]=[];
 f.runtime.store.saveTarget({id:'ssh-fixture',name:'SSH',kind:'ssh',sshHost:'fixture',bridgePath:'/fixture/bridge.mjs'});
 f.runtime.store.saveTarget({id:'bare-container',name:'Container',kind:'container',container:'fixture'});
 const remote=new InstanceConversations(f.runtime,{close(){},async request(_target:any,method:string,route:string){
  calls.push(method+' '+route);
  if(route.startsWith('/conversation-sources'))return {sessions:[],nativeSessions:[{sourceId:'remote-native',harnessId:'pi',nativeSessionId:'native',title:'SSH conversation',updatedAt:1000,canContinue:true}],nextPage:null};
  if(route.startsWith('/native-sessions/'))return {messages:[{id:'remote-message',role:'user',content:'SSH only',done:true}],revision:'remote-revision'};
  throw Error('Unexpected bridge route '+route);
 }} as any);t.after(()=>remote.close());
 const rows=await remote.catalog('ssh-fixture',0,'device');assert.equal(rows.conversations[0].source.targetId,'ssh-fixture');
 assert.equal((await remote.history(rows.conversations[0].source)).messages[0].content,'SSH only');
 assert.equal((await remote.catalog('bare-container',0,'device')).conversations.length,0);
 await assert.rejects(remote.history({...rows.conversations[0].source,targetId:'bare-container'}),/requires a Host bridge/);
 assert.ok(calls.some(v=>v.startsWith('GET /native-sessions/')));assert.equal(f.calls(),0);
 const identity={connectionId:'first-account',endpoint:'https://fixture.invalid'};
 (f.runtime.librechat as any).publicConfiguration=()=>({...identity,configured:true});
 (f.runtime as any).remoteChats=()=>({identity:()=>identity,list:async()=>({...identity,complete:true,conversations:[{id:'server-id',title:'Outside server',updatedAt:1000}]}),snapshot:async()=>({id:'server-id',title:'Outside server',revision:'v1',model:'fixture/model',messages:[{id:'s1',role:'user',content:'Server only',done:true,native:{secret:'never projected'}}]})});
 const servers=await remote.servers('local','librechat');const source=servers.conversations[0].source;
 assert.equal((await remote.history(source)).messages[0].content,'Server only');assert.ok(!JSON.stringify(await remote.history(source)).includes('secret'));
 identity.connectionId='second-account';await assert.rejects(remote.history(source),/original remote account/);
});


test('large Unicode histories fit the existing Relay chunk contract without corruption',()=>{
 const text='a'.repeat(8191)+'🌌'+'é漢🌌'.repeat(15000);
 const chunks=instanceRelayChunks(text);assert.equal(chunks.join(''),text);assert.ok(chunks.length>1);
 for(const chunk of chunks){assert.ok(Buffer.byteLength(chunk)<=32768);assert.equal(Buffer.from(chunk).toString('utf8'),chunk);}
 assert.deepEqual(instanceRelayChunks(''),['']);
});
