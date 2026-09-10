import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import express from 'express';
import {AccountStore} from './store.js';
import {TeamMachineSharing} from './team-machine-sharing.js';
import {TEAM_MACHINE_LEASE_MS,issueMachinePolicy,type MachinePolicy} from './team-machine-protocol.js';
const run=promisify(execFile);
const model=process.env.TEAM_MACHINE_LIVE_MODEL;
test('real local runtime: TLS sharing from a second machine, denied member, relay execution, offline expiry',{skip:!model,timeout:180000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'team-live-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',path.join(root,'key.pem'),'-out',path.join(root,'cert.pem')]);
 const cert=await fs.readFile(path.join(root,'cert.pem'),'utf8'),key=await fs.readFile(path.join(root,'key.pem'),'utf8');
 const store=new AccountStore(path.join(root,'accounts.json'));await store.init();
 const catalog=await fetch('http://127.0.0.1:8000/v1/models').then(r=>r.json()) as {data:{id:string}[]};assert.ok(catalog.data.some(m=>m.id===model));
 await store.addOrUpdate({id:'local-runtime-omlx',provider:'openai-compatible',enabled:true,accessToken:'',location:'local',baseUrl:'http://127.0.0.1:8000',localRuntime:{source:'multivibe-local-discovery',adapter:'omlx',endpoint:'http://127.0.0.1:8000',confirmedModelIds:catalog.data.map(m=>m.id),authentication:'none'}});
 const pair=generateKeyPairSync('ed25519'),trust={test:pair.publicKey.export({type:'spki',format:'pem'}).toString()};let now=Date.now();
 const service=new TeamMachineSharing(store,path.join(root,'sharing.json'),trust,()=>now);await service.initialize();const org=randomUUID(),instance=randomUUID(),member=randomUUID();const consent=await service.consent(org,instance);const token=randomUUID()+randomUUID();
 const app=express();app.use(express.json());app.use('/team-machine',service.inferenceRouter());const server=https.createServer({key,cert},app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const port=(server.address() as {port:number}).port;
 let p:MachinePolicy={version:'team-machine-v1',organizationId:org,instanceId:instance,consentId:consent.id,revision:1,runtimeId:'local-runtime-omlx',transport:'private_network',endpoint:'https://localhost:'+port+'/team-machine',enabled:true,models:[{id:model!,members:[member]}],keys:[{digest:createHash('sha256').update(token).digest('hex'),memberId:member,expiresAt:now+TEAM_MACHINE_LEASE_MS*2}],maxConcurrent:2,issuedAt:now,expiresAt:now+TEAM_MACHINE_LEASE_MS,entitlementEndsAt:now+TEAM_MACHINE_LEASE_MS*2};
 await service.apply(issueMachinePolicy(p,'test',pair.privateKey,now));
 const request=(bearer:string)=>new Promise<{status:number;text:string}>((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',port,path:'/team-machine/v1/chat/completions',method:'POST',ca:cert,headers:{authorization:'Bearer '+bearer,'content-type':'application/json'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,text}));});req.on('error',reject);req.end(JSON.stringify({model,messages:[{role:'user',content:'Reply with the word ready.'}],max_tokens:16,stream:true}));});
 assert.equal((await request('unauthorized-member')).status,403);
 if(process.env.TEAM_MACHINE_SECOND_HOST){
  const remoteCode="let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const x=JSON.parse(s);const q=require('https').request({hostname:'127.0.0.1',port:55443,path:'/team-machine/v1/chat/completions',method:'POST',ca:x.ca,headers:{authorization:'Bearer '+x.token,'content-type':'application/json'}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,streamed:b.includes('data:')})));});q.on('error',()=>process.exit(1));q.end(JSON.stringify({model:x.model,messages:[{role:'user',content:'Reply with the word ready.'}],stream:true,max_tokens:16}));});";
  const result=await new Promise<string>((resolve,reject)=>{const child=spawn('ssh',['-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-R','127.0.0.1:55443:127.0.0.1:'+port,process.env.TEAM_MACHINE_SECOND_HOST!,'node -e '+"'"+remoteCode.replaceAll("'","'\\''")+"'"],{stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error('Second machine request failed')));child.stdin.end(JSON.stringify({ca:cert,token,model}));});
  assert.deepEqual(JSON.parse(result),{status:200,streamed:true});
 }else{const result=await request(token);assert.equal(result.status,200);assert.ok(result.text.includes('data:'));}
 now=p.issuedAt+TEAM_MACHINE_LEASE_MS-1;assert.ok(service.status().sharing);now++;assert.equal((await request(token)).status,403);
 p={...p,revision:2,issuedAt:now,expiresAt:now+1000,entitlementEndsAt:now+1000,transport:'cloud_relay',endpoint:null};await service.apply(issueMachinePolicy(p,'test',pair.privateKey,now));
 const result=await service.execute(token,'cloud_relay','/v1/chat/completions',{model,messages:[{role:'user',content:'Reply ready.'}],max_tokens:16,stream:true},AbortSignal.timeout(60000));try{assert.equal(result.response.status,200);assert.ok((await result.response.text()).includes('data:'));}finally{result.release();}
 await service.stop();await assert.rejects(service.execute(token,'cloud_relay','/v1/chat/completions',{model},AbortSignal.timeout(1000)));
});
