import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import express from 'express';
import {instanceActivities} from './instance-activity.js';
import {InstanceLANServer,type InstanceLANIdentity} from './instance-lan.js';
import {InstanceConversations,type InstanceConversationSource} from './instance-conversations.js';
import type {HostHarnessRuntime} from './harness-runtime/runtime.js';
import {fail,identifier,requiredText,type HarnessEvent} from './harness-runtime/types.js';

// An explicitly versioned adapter over the existing Personal Relay completion
// transport. Cloud still owns account authentication, ownership, encrypted queues,
// cancellation, single-use start receipts and allowance. No inbound Host listener.
export const INSTANCE_RELAY_MODEL='multivibe/host-harness-v1';
const ORIGIN='https://app.multivibe.cloud';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
type Device={id:string;name:string;digest:string;expiresAt:number;trustDigest?:string;previous?:{digest:string;expiresAt:number}};
type PairRequest={id:string;accountId:string;name:string;digest:string;trustDigest:string;expiresAt:number;state:'pending'|'approved'|'refused'|'cancelled'};
type State={requests?:PairRequest[];version:1;machineId:string;name:string;machineToken:string;devices:Device[]};
type Envelope={version:1;accountId:string;machineId:string;operation:string;requestId?:string;trustToken?:string;deviceId?:string;deviceToken?:string;handoff?:string;name?:string;harnessId?:string;model?:string;provider?:string;effort?:string|null;projectId?:string;conversationId?:string;commandId?:string;text?:string;after?:number;targetId?:string;page?:number;source?:InstanceConversationSource;offset?:number;revision?:string};
type Upload=(data:string,terminal?:boolean,status?:number,contentType?:string)=>Promise<void>;

// Relay limits each persisted chunk to 32 KiB. Split at UTF-16 boundaries
// without separating a surrogate pair; 8,192 code units fit for every UTF-8 string.
export function instanceRelayChunks(data:string):string[]{
 const chunks:string[]=[];
 for(let offset=0;offset<data.length;){let end=Math.min(offset+8192,data.length);if(end<data.length&&/[\uD800-\uDBFF]/u.test(data[end-1]!))end--;chunks.push(data.slice(offset,end));offset=end;}
 return chunks.length?chunks:[''];
}

export class InstanceRelay {
 readonly conversations:InstanceConversations;
 private state?:State;
 private savedState?:State;
 private controller?:AbortController;
 private handoff?:{digest:string;expiresAt:number;attempts:number};
 private running=false;
 private connecting=false;
 private lastError?:string;
 private rotations=new Map<string,{token:string;expiresAt:number}>();
 private readonly lan?:InstanceLANServer;private lanIdentity?:InstanceLANIdentity;

 constructor(private readonly runtime:HostHarnessRuntime,private readonly file:string,private readonly fetcher:typeof fetch=fetch,private readonly clock=Date.now) {
  this.conversations=new InstanceConversations(runtime);if(fetcher===fetch)this.lan=new InstanceLANServer(this,path.dirname(file));
  try {const s=JSON.parse(fs.readFileSync(file,'utf8'));if(s.version!==1||!uuid(s.machineId)||!/^mvr_[A-Za-z0-9_-]{43}$/.test(s.machineToken)||!Array.isArray(s.devices))throw Error();this.state=s;this.savedState=structuredClone(s);}
  catch(e:any){if(e.code!=='ENOENT')throw new Error('Remote instance configuration is invalid');}
 }
 private persist(){
  if(!this.state)return;const temp=this.file+'.'+randomUUID();
  try {
   fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});fs.writeFileSync(temp,JSON.stringify(this.state),{mode:0o600});fs.renameSync(temp,this.file);
   this.savedState=structuredClone(this.state);
  } catch(error){this.state=this.savedState?structuredClone(this.savedState):undefined;fs.rmSync(temp,{force:true});throw error;}
 }

 private requests(){
  if(!this.state)fail('Instance disconnected',401);
  this.state.requests=(this.state.requests??[]).filter(r=>r.expiresAt+24*3600_000>this.clock());return this.state.requests;
 }
 decidePairing(id:string,approve:boolean){
  const r=this.requests().find(r=>r.id===id&&r.expiresAt>this.clock());if(!r)fail('Pairing request expired',404);
  if(r.state!=='pending')return this.status();
  if(approve){
   if(this.state!.devices.filter(d=>d.trustDigest||d.expiresAt>this.clock()).length>=10)fail('Device limit reached',409);
   this.state!.devices.push({id:r.id,name:r.name,digest:r.digest,trustDigest:r.trustDigest,expiresAt:this.clock()+24*3600_000});
  }
  r.state=approve?'approved':'refused';this.persist();return this.status();
 }
 private pairingRequest(e:Envelope){
  if(!uuid(e.requestId)||!/^[-_A-Za-z0-9]{43}$/.test(e.trustToken??''))fail('Invalid pairing request');
  const requests=this.requests();let r=requests.find(r=>r.id===e.requestId);
  const trustDigest=hash(e.trustToken!);
  if(r&&(r.accountId!==e.accountId||!equal(r.trustDigest,trustDigest)))fail('Pairing request mismatch',403);
  if(e.operation==='pair-request'&&!r){
   if(this.state!.devices.some(d=>d.id===e.requestId))fail('Request already used',409);
   if(requests.length>=200||requests.filter(r=>r.state==='pending'&&r.expiresAt>this.clock()).length>=20)fail('Too many pairing requests',429);
   if(!/^[-_A-Za-z0-9]{43}$/.test(e.deviceToken??''))fail('Invalid device token');
   r={id:e.requestId!,accountId:e.accountId,name:requiredText(e.name,80),digest:hash(e.deviceToken!),trustDigest,expiresAt:this.clock()+5*60_000,state:'pending'};
   requests.push(r);this.persist();
  }
  if(!r)return {state:'expired'};
  if(e.operation==='pair-cancel'){
   if(r.state==='approved')this.revokeDevice(r.id);
   r.state='cancelled';this.persist();
  }
  if(r.expiresAt<=this.clock()&&e.operation!=='pair-cancel')return {state:'expired',pairingVersion:2};
  const device=this.state!.devices.find(d=>d.id===r!.id);
  return {state:r.state==='approved'&&!device?'revoked':r.state,expiresAt:r.expiresAt,...(r.state==='approved'&&device?{deviceId:device.id,authorizationExpiresAt:device.expiresAt}:{}),pairingVersion:2};
 }
 status(){return {pairingVersion:2,requests:this.state?this.requests().filter(r=>r.state==='pending'&&r.expiresAt>this.clock()).map(({id,name,expiresAt})=>({id,name,expiresAt})):[],connected:!!this.state,running:this.running,name:this.state?.name,error:this.lastError,devices:this.state?.devices.filter(d=>d.trustDigest||d.expiresAt>this.clock()).map(({id,name,expiresAt})=>({id,name,expiresAt}))??[]};}
 private async account(pathname:string,token:string,body?:unknown,method=body===undefined?'GET':'POST',signal?:AbortSignal) {
  const response=await this.fetcher(ORIGIN+pathname,{method,redirect:'error',credentials:'omit',headers:{authorization:'Bearer '+token,'user-agent':'MultiVibe-Host/1.0',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([AbortSignal.timeout(15_000),...(signal?[signal]:[])])});
  const text=await response.text();if(text.length>1_048_576)fail('Relay response exceeds its limit',502);
  if(!response.ok)fail('MultiVibe Relay refused this operation (HTTP '+response.status+')',response.status===401?401:502);
  return JSON.parse(text);
 }
 async connect(accessToken:string,name:string){
  if(this.state||this.connecting)fail('Disconnect the existing instance before changing accounts',409);
  this.connecting=true;
  try {
  if(typeof accessToken!=='string'||accessToken.length>16384)fail('Invalid account');
  const issued=await this.account('/relay/v1/machines',accessToken,{name:requiredText(name,80)});
  if(!uuid(issued.id)||!/^mvr_[A-Za-z0-9_-]{43}$/.test(issued.token))fail('Invalid machine enrollment',502);
  this.state={version:1,machineId:issued.id,name,machineToken:issued.token,devices:[]};
  try{this.persist();}catch(error){await this.account('/relay/v1/machines/'+issued.id,accessToken,undefined,'DELETE').catch(()=>{});this.state=undefined;throw error;}
  this.start();return this.status();
  } finally {this.connecting=false;}
 }
 pairing(){
  if(!this.state||!this.running)fail('Connect this Host to Relay first',409);
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code=Array.from(randomBytes(12),byte=>alphabet[byte&31]).join('');
  this.handoff={digest:hash(code),expiresAt:this.clock()+5*60_000,attempts:0};
  const uri=new URL('multivibe-chat://instance/pair');uri.searchParams.set('machine',this.state.machineId);uri.searchParams.set('handoff',code);
  return {code,uri:uri.toString(),expiresAt:this.handoff.expiresAt,name:this.state.name};
 }
 cancelPairing(){this.handoff=undefined;return {cancelled:true};}
 revokeDevice(id:string){this.rotations.delete(id);if(this.state){this.state.devices=this.state.devices.filter(d=>d.id!==id);this.persist();}return this.status();}
 async disconnect(accessToken:string){
  const old=this.state;if(!old)return;
  this.stop();this.state=undefined;this.handoff=undefined;fs.rmSync(this.file,{force:true});
  try {
   await this.account('/relay/v1/machines/'+old.machineId,accessToken,undefined,'DELETE');
  } catch {fail('Local access disabled; Cloud revocation could not be confirmed',502);}
 }
 stop(){this.lan?.stop();this.lanIdentity=undefined;this.conversations.close();this.controller?.abort();this.controller=undefined;this.running=false;}
 start(){if(this.controller||!this.state)return;const controller=new AbortController();this.controller=controller;void this.run(controller.signal).finally(()=>{if(this.controller===controller){this.running=false;this.controller=undefined;}});}
 private async machine(route:string,body:unknown|undefined,signal:AbortSignal){const s=this.state;if(!s)fail('Instance disconnected',401);return this.account('/relay/v1/machine/'+route,s.machineToken,body,body===undefined?'GET':'POST',signal);}
 private async run(signal:AbortSignal){
  try{this.lanIdentity=await this.lan?.start();}catch{this.lanIdentity=undefined;}
  let heartbeatAt=0,failures=0;const jobs=new Set<Promise<void>>();
  while(!signal.aborted&&this.state){try{
   if(this.clock()-heartbeatAt>30_000){await this.machine('heartbeat',{models:[{id:INSTANCE_RELAY_MODEL,name:'MultiVibe Host · harness',supportsTools:false}],...(this.lanIdentity?{lanPublicKey:this.lanIdentity.publicKey,lanHost:this.lanIdentity.host,lanPort:this.lanIdentity.port}:{})},signal);heartbeatAt=this.clock();this.running=true;this.lastError=undefined;}
   if(jobs.size<4){const {job}=await this.machine('jobs',undefined,signal);if(job){const execution=this.execute(job,signal).catch(()=>{}).finally(()=>jobs.delete(execution));jobs.add(execution);}}
   failures=0;
  }catch{if(!signal.aborted){this.lastError='Relay indisponible. Reconnexion en cours.';this.running=false;heartbeatAt=0;failures++;}}
  try{await delay(failures?Math.min(15_000,1000*2**Math.min(failures-1,4)):1000,undefined,{signal});}catch{break;}}
 }
 private envelope(body:any):Envelope {
  if(body?.model!==INSTANCE_RELAY_MODEL||!Array.isArray(body.messages)||body.messages.length!==1||body.messages[0]?.role!=='user'||typeof body.messages[0]?.content!=='string'||body.messages[0].content.length>131072)fail('Use the MultiVibe instance protocol',400);
  let e:Envelope;try{e=JSON.parse(body.messages[0].content);}catch{fail('Invalid instance envelope');}
  // Cloud routes a machine only for the authenticated owner account. The Host
  // binds the envelope to that machine and never trusts its claimed account ID.
  const s=this.state;if(!s||e.version!==1||!uuid(e.accountId)||e.machineId!==s.machineId)fail('Instance/account mismatch',403);
  return e;
 }
 private device(e:Envelope):Device {
  const d=this.state?.devices.find(d=>d.id===e.deviceId),digest=hash(typeof e.deviceToken==='string'?e.deviceToken:'');
  if(!d)fail('Device authorization expired or revoked',401);
  if(d.expiresAt<=this.clock()||!(equal(d.digest,digest)||d.previous&&d.previous.expiresAt>this.clock()&&equal(d.previous.digest,digest)))fail(d.trustDigest?'Device session renewal required':'Device authorization expired or revoked',401);
  return d;
 }
 private authorize(e:Envelope):{deviceId:string;deviceToken:string;expiresAt:number}{
  if(e.operation==='pair'){
   const h=this.handoff;const code=typeof e.handoff==='string'?e.handoff.toUpperCase():'';
   if(!h||h.expiresAt<=this.clock()||++h.attempts>8||!equal(h.digest,hash(code)))fail('Pairing code expired or invalid',403);
   this.handoff=undefined;
   this.state!.devices=this.state!.devices.filter(d=>d.trustDigest||d.expiresAt>this.clock());
   if(this.state!.devices.filter(d=>d.trustDigest||d.expiresAt>this.clock()).length>=10)fail('Device limit reached',409);
   const token=randomBytes(32).toString('base64url'),d:Device={id:randomUUID(),name:requiredText(e.name,80),digest:hash(token),expiresAt:this.clock()+24*3600_000};
   this.state!.devices.push(d);this.persist();return {deviceId:d.id,deviceToken:token,expiresAt:d.expiresAt};
  }
  if(e.trustToken!==undefined){
   const d=this.state!.devices.find(d=>d.id===e.deviceId);
   if(!d)fail('Device revoked',401);
   if(d.trustDigest){if(!equal(d.trustDigest,hash(e.trustToken)))fail('Device revoked',401);}
   else {this.device(e);if(!/^[-_A-Za-z0-9]{43}$/.test(e.trustToken))fail('Invalid trust token');d.trustDigest=hash(e.trustToken);}
   if(!/^[-_A-Za-z0-9]{43}$/.test(e.deviceToken??''))fail('Invalid device token');
   // The client saves its next token before sending. Retrying after restart
   // installs the same digest; no replacement plaintext is persisted by Host.
   const nextDigest=hash(e.deviceToken!);
   if(!equal(d.digest,nextDigest)){d.previous={digest:d.digest,expiresAt:d.expiresAt};d.digest=nextDigest;}
   d.expiresAt=this.clock()+24*3600_000;
   this.persist();return {deviceId:d.id,deviceToken:e.deviceToken!,expiresAt:d.expiresAt};
  }
  const d=this.device(e);const previous=this.rotations.get(d.id);
  if(previous&&previous.expiresAt>this.clock()&&d.previous&&equal(d.previous.digest,hash(e.deviceToken!)))return {deviceId:d.id,deviceToken:previous.token,expiresAt:d.expiresAt};
  const token=randomBytes(32).toString('base64url');d.previous={digest:d.digest,expiresAt:this.clock()+60_000};d.digest=hash(token);d.expiresAt=this.clock()+24*3600_000;
  this.persist();this.rotations.set(d.id,{token,expiresAt:this.clock()+60_000});return {deviceId:d.id,deviceToken:token,expiresAt:d.expiresAt};
 }
 // This method is also exercised directly by protocol/security tests. No network
 // destination, filesystem path, shell command or desktop credential is accepted.
 async dispatch(body:unknown,upload:Upload,signal:AbortSignal){
  const e=this.envelope(body);
  const json=async(value:unknown)=>upload(JSON.stringify({version:1,...value as object}),true,200,'application/json');
  if(e.operation==='pair-capabilities'){await json({pairingVersion:2});return;}
  if(['pair-request','pair-status','pair-cancel'].includes(e.operation)){await json(this.pairingRequest(e));return;}
  if(e.operation==='pair'||e.operation==='renew'){const auth=this.authorize(e);await json({...auth,pairingVersion:2,durable:!!this.state!.devices.find(d=>d.id===auth.deviceId)?.trustDigest,name:this.state!.name,harnesses:await this.runtime.catalog()});return;}
  const device=this.device(e);
  if(e.operation==='revoke'){this.revokeDevice(device.id);await json({revoked:true});return;}
  if(e.operation==='conversation-targets'){await json({targets:this.conversations.targets()});return;}
  if(e.operation==='conversations'){await json(await this.conversations.catalog(identifier(e.targetId??'local'),e.page??0,device.id));return;}
  if(e.operation==='server-conversations'){await json(await this.conversations.servers(identifier(e.targetId??'local'),identifier(e.harnessId)));return;}
  if(e.operation==='conversation-history'){await json(await this.conversations.history(e.source!,e.offset??0,e.revision));return;}
  if(e.operation==='catalog'){await json({name:this.state!.name,harnesses:await this.runtime.catalog()});return;}
  if(e.operation==='models'){await json(await this.conversations.models(identifier(e.harnessId),e.source));return;}
  if(e.operation==='effort'){
   const source=e.source?this.conversations.source(e.source):undefined;
   const sessionId=source?.kind==='session'?source.id:uuid(e.conversationId)?'mobile-'+hash([this.state!.machineId,device.id,e.conversationId].join(':')).slice(0,40):undefined;
   if(source && source.targetId!=='local'){await json({effort:null});return;}
   await json(await this.runtime.effort({harnessId:identifier(e.harnessId),targetId:'local',authMode:'native',model:requiredText(e.model,256),...(e.provider?{provider:requiredText(e.provider,256)}:{}),...(sessionId?{sessionId}:{})}));return;
  }
  if(e.operation==='projects'){
   const projects=this.runtime.projects({harnessId:identifier(e.harnessId),targetId:'local'}).projects;
   await json({projects:projects.map(({id,harnessId,name,updatedAt})=>({id,harnessId,name,updatedAt}))});return;
  }
  if(!['prompt','recover','configure','interrupt'].includes(e.operation))fail('Unsupported instance operation');
  if(!uuid(e.conversationId)||!uuid(e.commandId))fail('Invalid conversation operation');
  const mobileSessionId='mobile-'+hash([this.state!.machineId,device.id,e.conversationId].join(':')).slice(0,40);
  const source=e.source?this.conversations.source(e.source):undefined,targetId=source?.targetId??'local';
  const sessionId=source?await this.conversations.attach(source,mobileSessionId,device.id,e.conversationId,e.model??'',e.provider):mobileSessionId;
  const command=async(value:any)=>(await this.conversations.command(targetId,sessionId,value)).receipt;
  if(e.operation==='configure'||e.operation==='interrupt'){
   const value:Record<string,unknown>={};
   if(e.operation==='configure'){
    if(e.projectId!==undefined)fail("A conversation's project is fixed",409);
    if(e.model!==undefined)value.model=requiredText(e.model,256);
    if(e.provider!==undefined)value.provider=requiredText(e.provider,256);
    if(e.effort!==undefined)value.effort=e.effort===null?null:requiredText(e.effort,64);
    if(!Object.keys(value).length)fail('Select a model or effort');
   }
   const receipt=await command({id:e.commandId,type:e.operation,...(e.operation==='configure'?{value}:{})});
   // The command receipt, including its fingerprint, remains on the owning Host.
   // Retrying the same ID recovers an acknowledgement without executing twice.
   await json({state:receipt.state,...(source?{source:{targetId,kind:'session',id:sessionId,harnessId:source.harnessId}}:{})});return;
  }
  if(e.operation==='prompt'&&!source){
   const harnessId=identifier(e.harnessId);let workspace:string|undefined;
   if(e.projectId!==undefined){
    if(!/^[a-f0-9]{64}$/u.test(e.projectId))fail('Invalid project selection');
    const project=this.runtime.projects({harnessId,targetId:'local'}).projects.find(value=>value.id===e.projectId);
    if(!project)fail('The selected project is unavailable on this Host',409);workspace=project.path;
   }
   const created=await this.runtime.create({id:sessionId,harnessId,targetId:'local',authMode:'native',model:requiredText(e.model,256),...(e.provider?{nativeProvider:requiredText(e.provider,256)}:{}),...(e.effort?{effort:requiredText(e.effort,64)}:{}),...(workspace?{workspace}:{}),title:'iPhone · '+device.name});
   created.configuration={...created.configuration,mobileDeviceId:device.id,mobileConversationId:e.conversationId};this.runtime.store.save(created);
  }
  if(source)await upload('data: '+JSON.stringify({type:'conversation.bound',source:{targetId,kind:'session',id:sessionId,harnessId:source.harnessId}})+'\n\n',false,200,'text/event-stream');
  const emit=async(event:HarnessEvent)=>{
   if(event.turnId!==e.commandId)return;
   // Transmit only the bounded display projection, never the raw native record.
   const activities=instanceActivities(event);
   if(activities.length)await upload('data: '+JSON.stringify(activities.length===1?{type:'activity',activity:activities[0],seq:event.seq}:{type:'activities',activities,seq:event.seq})+'\n\n',false,200,'text/event-stream');
   const p=event.payload as any;
   if(event.turnId===e.commandId&&['message.delta','message.part'].includes(event.type)&&p?.role==='assistant'&&typeof p.text==='string')await upload('data: '+JSON.stringify({type:event.type,text:p.text,itemId:event.itemId??'assistant',seq:event.seq})+'\n\n',false,200,'text/event-stream');
  };
  let cursor=Number.isSafeInteger(e.after)&&e.after!>=0?e.after!:0;
  if(e.operation==='prompt'){
   // Repeated IDs use the desktop runtime's receipt/fingerprint protection.
   const session=(await this.conversations.snapshot(targetId,sessionId)).session;
   if(session.queuePaused&&session.state==='interrupted')await command({id:e.commandId!+'-resume',type:'resume_queue'});
   await command({id:e.commandId!,type:'prompt',parts:[{type:'text',text:requiredText(e.text,32000)}]});
  }
  let approvalPending=false;
  while(true){signal.throwIfAborted();this.device(e);
   const batch=(await this.conversations.events(targetId,sessionId,cursor)).events as HarnessEvent[];for(const event of batch){cursor=event.seq;await emit(event);}
   if(batch.length)continue;
   const receipt=(await this.conversations.receipt(targetId,sessionId,e.commandId!)).receipt;
   if(!receipt||receipt.sessionId!==sessionId)fail('Operation not found',404);
   if(['completed','failed','cancelled','uncertain'].includes(receipt.state)){
    // The turn can finish between the empty poll and receipt read. Drain its
    // final tool/message events before closing the stream and advancing cursor.
    const tail=(await this.conversations.events(targetId,sessionId,cursor)).events as HarnessEvent[];
    if(tail.length){for(const event of tail){cursor=event.seq;await emit(event);}continue;}
    await upload('data: '+JSON.stringify({type:'terminal',state:receipt.state,cursor})+'\n\n',true,200,'text/event-stream');return;
   }
   const awaitingApproval=(await this.conversations.snapshot(targetId,sessionId)).interactions.length>0;
   if(awaitingApproval&&!approvalPending)await upload('data: '+JSON.stringify({type:'approval_required',cursor})+'\n\n',false,200,'text/event-stream');
   approvalPending=awaitingApproval;
   await delay(150,undefined,{signal});
  }
 }
 private async execute(job:any,signal:AbortSignal){
  if(!uuid(job.id))fail('Invalid Relay job');
  // Validate before accepting a single-use dispatch receipt. Never retry start.
  this.envelope(job.body);const start=await this.machine('jobs/'+job.id+'/start',{},signal);if(start.execute!==true)fail('Relay start rejected',409);
  const local=new AbortController(),execution=AbortSignal.any([signal,local.signal]);let seq=0,total=0,checking=false;
  const timer=setInterval(()=>{if(checking)return;checking=true;void this.machine('jobs/'+job.id+'/status',undefined,execution).then(v=>{if(v.state!=='running')local.abort();},()=>{}).finally(()=>{checking=false;});},2000);timer.unref();
  const upload:Upload=async(data,terminal=false,status=200,contentType='application/json')=>{total+=Buffer.byteLength(data);if(total>8*1024*1024)fail('Instance response exceeds limit',413);const chunks=instanceRelayChunks(data);for(const [index,chunk] of chunks.entries()){if(seq>2047)fail('Instance response exceeds limit',413);await this.machine('jobs/'+job.id+'/chunks',{sequence:seq++,data:chunk,terminal:terminal&&index===chunks.length-1,status,contentType},execution);}};
  try{await this.dispatch(job.body,upload,execution);}
  catch(error:any){if(seq===0&&!execution.aborted)await upload(JSON.stringify({error:'Instance operation refused',code:error.status===401&&/renewal required/.test(error.message)?'instance_device_renew_required':error.status===401&&/Device/.test(error.message)?'instance_device_revoked':error.status===400?'instance_update_required':'instance_operation_refused',status:error.status??502}),true,error.status??502);else await this.machine('jobs/'+job.id+'/fail',{},AbortSignal.timeout(5000)).catch(()=>{});}
  finally{clearInterval(timer);local.abort();}
 }
}

export function instanceRelayRoutes(service?:InstanceRelay,withAccount?:<T>(operation:(accessToken:string)=>Promise<T>)=>Promise<T>){
 const router=express.Router();router.use(express.json({limit:'32kb'}));router.use((_req,res,next)=>{res.setHeader('cache-control','no-store');if(!service)return res.status(404).json({error:'Host required'});next();});
 const route=(fn:(req:express.Request)=>unknown):express.RequestHandler=>(req,res,next)=>{Promise.resolve().then(()=>fn(req)).then(v=>res.json(v??{disconnected:true}),next);};
 router.get('/',route(()=>service!.status()));
 router.post('/connect',route(req=>{if(!withAccount)fail('Connect this Host to MultiVibe Cloud first',409);return withAccount(token=>service!.connect(token,req.body.name??os.hostname()));}));
 router.post('/pairing',route(()=>service!.pairing()));
 router.delete('/pairing',route(()=>service!.cancelPairing()));
 router.post('/requests/:id/approve',route(req=>service!.decidePairing(String(req.params.id),true)));
 router.post('/requests/:id/refuse',route(req=>service!.decidePairing(String(req.params.id),false)));
 router.delete('/devices/:id',route(req=>service!.revokeDevice(String(req.params.id))));
 router.post('/disconnect',route(()=>{if(!withAccount)fail('Connect this Host to MultiVibe Cloud first',409);return withAccount(token=>service!.disconnect(token));}));
 return router;
}
