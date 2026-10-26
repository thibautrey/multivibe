import {instanceActivity,mergeInstanceActivity,type InstanceActivity} from './instance-activity.js';
import {createHash} from 'node:crypto';
import {HostHarnessRuntime,ADAPTERS} from './harness-runtime/runtime.js';
import {RemoteHarnessHosts} from './harness-runtime/remote.js';
import {discoverNativeSessionPage,findNativeSession,readNativeMessages} from './harness-runtime/discovery.js';
import {fail,identifier,requiredText,redact,type HarnessSession} from './harness-runtime/types.js';

export type InstanceConversationSource={targetId:string;kind:'session'|'native'|'server';id:string;harnessId:string;connectionId?:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const enc=encodeURIComponent;
/** Same Host readers/bridges as Desktop, projected to the paired-device protocol. */
export class InstanceConversations {
 constructor(private runtime:HostHarnessRuntime,private remotes=new RemoteHarnessHosts()){}
 close(){this.remotes.close();}
 targets(){return this.runtime.store.targets().map(({id,name})=>({id,name}));}
 source(value:InstanceConversationSource):InstanceConversationSource {
  if(!value || !['session','native','server'].includes(value.kind))fail('Invalid conversation source');
  const source={targetId:identifier(value.targetId),harnessId:identifier(value.harnessId),kind:value.kind,id:requiredText(value.id,256),...(value.connectionId?{connectionId:requiredText(value.connectionId,256)}:{})};
  this.runtime.store.target(source.targetId);return source;
 }
 private async call(targetId:string,method:string,route:string,local:()=>any,body?:unknown):Promise<any>{
  const target=this.runtime.store.target(identifier(targetId));
  if(target.kind==='ssh' || target.kind==='container' && target.bridgePath)return this.remotes.request(target,method,route,body);
  if(target.kind!=='local')fail('This environment requires a Host bridge',422);
  return local();
 }
 async catalog(targetId:string,page:number,deviceId:string){
  if(!Number.isSafeInteger(page)||page<0||page>1000)fail('Invalid catalog page');
  const target=this.runtime.store.target(targetId);
  const result=target.kind==='container'&&!target.bridgePath?{sessions:this.runtime.store.sessions().filter(s=>s.targetId===targetId),nativeSessions:[],nextPage:null}:await this.call(targetId,'GET',`/conversation-sources?page=${page}`,async()=>{
   const native=this.runtime.store.target(targetId).kind==='local'?(await this.runtime.catalog()).filter(v=>v.detected && v.id in ADAPTERS).map(v=>discoverNativeSessionPage(v.id,undefined,page)):[];
   return {sessions:this.runtime.store.sessions().filter(s=>s.targetId===targetId),nativeSessions:native.flatMap(v=>v.sessions),nextPage:native.some(v=>v.hasMore)?page+1:null};
  });
  const sessions=result.sessions as HarnessSession[];
  const supervised=new Set(sessions.flatMap(s=>[s.configuration?.sourceId,s.nativeSessionId].filter(Boolean).map(id=>s.harnessId+':'+id)));
  const summary=(source:InstanceConversationSource,title:string,updatedAt:number,model?:string,canContinue=true,extra={})=>({source,title:String(redact(title)),updatedAt,model,canContinue,...extra});
  const conversations=[...sessions.map(s=>summary({targetId,kind:'session',id:s.id,harnessId:s.harnessId},s.title,s.updatedAt,s.model,true,{
   ...(s.configuration?.mobileDeviceId===deviceId?{conversationId:s.configuration.mobileConversationId}:{}),
   ...(typeof s.configuration?.sourceId==='string'?{nativeSourceId:s.configuration.sourceId}:{}),...(['librechat','openwebui'].includes(s.harnessId)?{nativeSessionId:s.nativeSessionId,connectionId:s.configuration?.connectionId}:{}),
  })),...result.nativeSessions.filter((s:any)=>!supervised.has(s.harnessId+':'+s.sourceId)&&!supervised.has(s.harnessId+':'+s.nativeSessionId)).map((s:any)=>summary({targetId,kind:'native',id:s.sourceId,harnessId:s.harnessId},s.title,s.updatedAt,undefined,s.canContinue))];
  return {conversations,nextPage:result.nextPage};
 }
 async models(harnessId:string,value?:InstanceConversationSource){
  const source=value?this.source(value):undefined,targetId=source?.targetId??'local';
  const input={harnessId:identifier(harnessId),targetId:'local',authMode:'native',...(source?.kind==='session'?{sessionId:source.id}:{})};
  if(source?.kind==='session')input.authMode=(await this.snapshot(targetId,source.id)).session.authMode;
  return this.call(targetId,'POST','/models',()=>this.runtime.models({...input,targetId}),input);
 }
 async servers(targetId:string,harnessId:string){
  identifier(harnessId);if(!['librechat','openwebui'].includes(harnessId))fail('Invalid server harness');
  const target=this.runtime.store.target(targetId);if(target.kind==='container'&&!target.bridgePath)return {conversations:[]};
  const config=await this.call(targetId,'GET','/'+harnessId,()=>this.runtime[harnessId as 'librechat'|'openwebui'].publicConfiguration());
  if(!config.configured)return {conversations:[]};
  const result=await this.call(targetId,'GET',`/remote-chats?harnessId=${harnessId}`,()=>this.runtime.remoteChats(harnessId).list());
  if(!result.complete || !result.connectionId)fail('Incomplete server catalog',502);
  return {conversations:result.conversations.map((s:any)=>({source:{targetId,kind:'server',id:s.id,harnessId,connectionId:result.connectionId},title:String(redact(s.title)),updatedAt:s.updatedAt,model:s.model,canContinue:true}))};
 }
 private sessionCall(targetId:string,id:string,method:string,route:string,local:()=>any,body?:unknown){
  const target=this.runtime.store.target(targetId);
  if(target.kind==='container'&&!target.bridgePath){
   if(this.runtime.session(id).targetId!==targetId)fail('Conversation environment changed',409);
   return Promise.resolve(local());
  }
  return this.call(targetId,method,route,local,body);
 }
 async snapshot(targetId:string,id:string){return this.sessionCall(targetId,id,'GET',`/sessions/${enc(id)}`,()=>this.runtime.snapshot(id));}
 async command(targetId:string,id:string,command:any){return this.sessionCall(targetId,id,'POST',`/sessions/${enc(id)}/commands`,async()=>({receipt:await this.runtime.command(id,command)}),command);}
 async events(targetId:string,id:string,after:number){return this.sessionCall(targetId,id,'GET',`/sessions/${enc(id)}/events?after=${after}&poll=1`,()=>({events:this.runtime.store.events(id,after,500)}));}
 async receipt(targetId:string,id:string,commandId:string){return this.sessionCall(targetId,id,'GET',`/sessions/${enc(id)}/commands/${enc(commandId)}`,()=>({receipt:this.runtime.store.receipt(commandId)}));}
 private async server(source:InstanceConversationSource){
  const config=await this.call(source.targetId,'GET','/'+source.harnessId,()=>this.runtime.remoteChats(source.harnessId).identity());
  // Public configuration carries connectionId on remote Hosts; local identity is authoritative.
  const identity=source.targetId==='local'?this.runtime.remoteChats(source.harnessId).identity():config;
  if(identity.connectionId!==source.connectionId)fail('Reconnect the original remote account',409);
  return this.call(source.targetId,'GET',`/remote-chats/${enc(source.id)}?harnessId=${enc(source.harnessId)}`,async()=>{
   const remote=this.runtime.remoteChats(source.harnessId);return {...remote.identity(),conversation:await remote.snapshot(source.id)};
  });
 }
 async history(value:InstanceConversationSource,offset=0,revision?:string):Promise<any>{
  const source=this.source(value);let messages:any[],version:string,model:string|undefined;
  if(source.kind==='native'){
   const result=await this.call(source.targetId,'GET',`/native-sessions/${enc(source.id)}/messages?harnessId=${enc(source.harnessId)}`,()=>{
    if(this.runtime.store.target(source.targetId).kind!=='local')fail('Native history requires a Host bridge',422);
    return readNativeMessages(source.harnessId,source.id);
   });messages=result.messages;version=result.revision;
  }else if(source.kind==='server'){
   const result=await this.server(source);messages=result.conversation.messages;version=result.conversation.revision;model=result.conversation.model;
  }else{
   const snapshot=await this.snapshot(source.targetId,source.id);if(snapshot.session.harnessId!==source.harnessId)fail('Conversation harness changed',409);
   model=snapshot.session.model;
   if(['librechat','openwebui'].includes(source.harnessId)&&snapshot.session.nativeSessionId){
    return this.history({...source,kind:'server',id:snapshot.session.nativeSessionId,connectionId:snapshot.session.configuration?.connectionId},offset,revision);
   }
   const items=new Map<string,any>(),imported=new Map<string,any>(),activities=new Map<string,InstanceActivity[]>();let after=0;
   for(let page=0;;page++){
    if(page>400)fail('Conversation exceeds history limit',413);
    const batch=(await this.events(source.targetId,source.id,after)).events;
    if(!batch.length)break;
    for(const e of batch){after=e.seq;const p=e.payload as any;
     const activity=instanceActivity(e);
     if(activity&&e.turnId){const values=activities.get(e.turnId)??[];mergeInstanceActivity(values,activity);activities.set(e.turnId,values);}
     if(e.type==='history.message'&&['user','assistant','system','tool'].includes(p?.role)&&typeof p.text==='string'){const key=e.itemId??String(e.seq),prior=imported.get(key);imported.set(key,{id:'history:'+key,role:p.role,content:p.append?(prior?.content??'')+p.text:p.text,done:true});}
     if(e.type==='message.user'){const text=p?.parts?.filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n');if(text)items.set('user:'+(e.turnId??e.itemId),{id:'user:'+(e.turnId??e.itemId),role:'user',content:text,done:true});}
     if(['message.delta','message.part'].includes(e.type)&&['user','assistant','system','tool'].includes(p?.role)&&typeof p.text==='string'){
      const key=(e.turnId??'')+':'+(e.itemId??p.role),prior=items.get(key);items.set(key,{id:key,role:p.role,content:e.type==='message.delta'?(prior?.content??'')+p.text:p.text,done:e.turnId!==snapshot.session.activeTurnId || !snapshot.session.activeTurnId});
     }
    }
   }
   for(const [turn,values] of activities){
    const replies=[...items.values()].filter((v:any)=>v.role==='assistant'&&v.id.startsWith(turn+':'));
    const reply=replies[0];
    if(reply)reply.activities=values;
    else items.set(turn+':activity',{id:turn+':activity',role:'assistant',content:'',done:turn!==snapshot.session.activeTurnId,activities:values});
   }
   messages=[...imported.values(),...items.values()];
   if(!imported.size&&typeof snapshot.session.configuration?.sourceId==='string'){
    const original=await this.call(source.targetId,'GET',`/native-sessions/${enc(snapshot.session.configuration.sourceId)}/messages?harnessId=${enc(source.harnessId)}`,()=>readNativeMessages(source.harnessId,snapshot.session.configuration.sourceId));
    messages=[...original.messages,...messages];
   }
   version=digest(messages);
  }
  if(!Number.isSafeInteger(offset)||offset<0||offset>messages.length)fail('Invalid history offset');
  if(revision && revision!==version)fail('History changed during pagination; retry',409);
  const projected=messages.map(({id,role,content,done,activities})=>({id,role,content:String(redact(content)),done,...(activities?{activities}:{})}));
  const batch:any[]=[];let bytes=0;
  for(const message of projected.slice(offset)){const size=Buffer.byteLength(JSON.stringify(message));if(batch.length&&(bytes+size>512_000||batch.length>=100))break;if(size>6_000_000)fail('Message exceeds relay limit',413);batch.push(message);bytes+=size;}
  return {messages:batch,revision:version,model,nextOffset:offset+batch.length<messages.length?offset+batch.length:null};
 }
 async attach(value:InstanceConversationSource,id:string,deviceId:string,conversationId:string,model:string,provider?:string){
  const source=this.source(value),targetId=source.targetId;
  if(source.kind==='session'){const {session}=await this.snapshot(targetId,source.id);if(session.harnessId!==source.harnessId)fail('Conversation harness changed',409);return session.id;}
  if(source.kind==='server'){
   await this.server(source);
   const body={harnessId:source.harnessId,remoteChatId:source.id,connectionId:source.connectionId,model};
   const {session}=await this.call(targetId,'POST','/sessions/remote',async()=>({session:await this.runtime.connectRemoteChat(body)}),body);return session.id;
  }
  const body={id,harnessId:source.harnessId,sourceId:source.id,model,...(provider?{nativeProvider:provider}:{})};
  const {session}=await this.call(targetId,'POST','/sessions/import',async()=>{
   if(this.runtime.store.target(targetId).kind!=='local')fail('Native history requires a Host bridge',422);
   const native=findNativeSession(source.harnessId,source.id);if(!native?.canContinue)fail('This history is read only',409);
   const prior=this.runtime.store.sessions().find(s=>s.id===id);if(prior){if(prior.configuration?.sourceId!==source.id||prior.harnessId!==source.harnessId)fail('Conversation source changed',409);return {session:prior};}
   const session=await this.runtime.create({id,harnessId:source.harnessId,model,authMode:'native',workspace:native.workspace,title:native.title,...(provider?{nativeProvider:provider}:{})});
   session.nativeSessionId=native.nativeSessionId;session.configuration={...session.configuration,sourceId:source.id,forkNativeSession:true,mobileDeviceId:deviceId,mobileConversationId:conversationId};this.runtime.store.save(session);return {session};
  },body);return session.id;
 }
}
