import { LibreChatConfiguration, RemoteChatConfiguration } from "./librechat.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostHarnessIntegrationManager } from "../harness-integrations.js";
import { adapterFor } from "./adapters.js";
import { harnessEnvironment } from "./process.js";
import { harnessResources, writeHarnessResource } from "./resources.js";
import { HarnessRuntimeStore } from "./store.js";
import { capabilities, fail, HarnessRuntimeError, identifier, messageParts, redact, requiredText, supported, unsupported, type AdapterContext, type AdapterEvent, type HarnessAdapter, type HarnessCommand, type HarnessCommandReceipt, type HarnessDescriptor, type HarnessEvent, type HarnessSession, type PendingInteraction } from "./types.js";

export const ADAPTERS = {
  "hermes-agent": {name:"Hermes Agent",protocol:"acp",command:"hermes"},
  pi:{name:"Pi",protocol:"pi-rpc",command:"pi"},
  "openai-codex":{name:"OpenAI Codex",protocol:"codex",command:"codex"},
  "claude-code":{name:"Claude Code",protocol:"claude-sdk",command:"claude"},
  opencode:{name:"OpenCode",protocol:"opencode",command:"opencode"},
  "gemini-cli":{name:"Gemini CLI",protocol:"acp",command:"gemini"},
} as const;
const COMMANDS=new Set(["prompt","steer","interrupt","resume_queue","pause_queue","queue_edit","queue_remove","queue_reorder","compact","respond","inspect","configure","fork","native"]);
type Integration=Pick<HostHarnessIntegrationManager,"list"|"executablePath">;

export class HostHarnessRuntime {
  readonly store:HarnessRuntimeStore;
  readonly librechat:LibreChatConfiguration;
  readonly openwebui:RemoteChatConfiguration;
  private events=new EventEmitter();
  private adapters=new Map<string,Promise<HarnessAdapter>>();
  private states=new Map<string,HarnessSession>();
  private working=new Set<string>();
  private controls=new Set<string>();
  private nativeTerminals=new Map<string,{state:"completed"|"failed"|"cancelled";error?:string}>();
  private answers=new Map<string,{sessionId:string;resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private privateInteractions=new Map<string,unknown>();
  private stopped=false;
  private containerExecutables=new Map<string,{expires:number;value:string|null}>();
  private scheduler:ReturnType<typeof setInterval>;
  constructor(readonly root:string,private integrations:Integration,private factory:(ctx:AdapterContext)=>HarnessAdapter=adapterFor,private options:{modelConnection?:()=>{baseUrl:string;apiKey:string}}={}) {
    this.store=new HarnessRuntimeStore(root);this.librechat=new LibreChatConfiguration(root);this.openwebui=new RemoteChatConfiguration(root,{id:"openwebui",name:"Open WebUI",suffix:"/api"});this.events.setMaxListeners(100);
    this.scheduler=setInterval(()=>void this.tickSchedules().catch(()=>{}),15_000);this.scheduler.unref();
    for(const s of this.store.sessions()) {
      this.states.set(s.id,s);
      if(s.activeTurnId || !["idle","interrupted","failed","uncertain"].includes(s.state)) {
        s.state="uncertain";s.queuePaused=true;delete s.activeTurnId;this.store.save(s);
        for(const c of this.store.commands(s.id))if(["dispatching","accepted"].includes(c.state)){c.state="uncertain";c.error="Host restarted; native acceptance must be reconciled before retry";this.store.saveReceipt(c);}
        this.emit(s.id,{type:"recovery.required",payload:{reason:"Host restarted; previously dispatched operations will not be replayed"}});
      }
      for(const interaction of this.store.interactions(s.id))if(interaction.status==="pending"){interaction.status="expired";this.store.interaction(interaction);}
      // Only never-dispatched work is eligible for automatic continuation.
      if(s.state==="idle" && !s.queuePaused)queueMicrotask(()=>void this.drain(s.id));
    }
  }
  session(id:string){return this.states.get(identifier(id))??this.store.session(id);}
  snapshot(id:string){return {session:this.session(id),queue:this.store.commands(id).filter(c=>c.command.type==="prompt" && ["queued","dispatching","accepted","uncertain"].includes(c.state)),interactions:this.store.interactions(id).filter(v=>v.status==="pending").map(v=>({...v,detail:this.privateInteractions.get(v.id)??v.detail}))};}
  private emit(id:string,event:AdapterEvent):HarnessEvent {
    const s=this.session(id),active=s.activeTurnId;
    if(event.type==="harness.metadata"){const p=event.payload as any;if(typeof p?.version==="string")s.harnessVersion=p.version.slice(0,128);if(typeof p?.protocolVersion==="string")s.protocolVersion=p.protocolVersion.slice(0,64);}
    const saved=this.store.event(id,event.type,this.captureArtifacts(id,event.payload),event.type==="history.message"?undefined:active,event.itemId);this.events.emit(id,saved);
    if(active && event.type==="turn.status") {
      const p=event.payload as any,prior=this.nativeTerminals.get(active);const outcome=prior && prior.state!=="completed"?prior:{state:p?.status==="failed" || p?.is_error || ["refusal","error"].includes(p?.stopReason)?"failed" as const:["interrupted","cancelled"].includes(p?.status) || p?.stopReason==="cancelled" || p?.aborted?"cancelled" as const:"completed" as const,...(p?.error?{error:String(redact(p.error))}:{})};
      this.nativeTerminals.set(active,outcome);
      if(s.state==="uncertain"){
        const receipt=this.store.receipt(active);if(receipt?.state==="uncertain"){receipt.state=outcome.state;receipt.error=outcome.error;this.store.saveReceipt(receipt);s.state=outcome.state==="completed"?"idle":outcome.state==="cancelled"?"interrupted":"failed";this.emit(id,{type:`turn.${outcome.state}`,payload:{commandId:active,reconciled:true,error:outcome.error}});delete s.activeTurnId;this.nativeTerminals.delete(active);this.save(s);}
      }
    }
    return saved;
  }
  private captureArtifacts(sessionId:string,payload:unknown):unknown {
    const artifacts:any[]=[];
    const visit=(value:any,depth:number):any=>{
      if(depth>8 || !value || typeof value!=="object")return value;
      if(Array.isArray(value))return value.map(v=>visit(v,depth+1));
      const mime=value.mimeType??value.mime_type;
      const data=typeof value.data==="string"?value.data:typeof value.blob==="string"?value.blob:undefined;
      if(typeof mime==="string" && data && artifacts.length<4 && data.length<=24*1024*1024 && /^(image|audio|video)\/|^application\/(pdf|octet-stream)$/u.test(mime) && /^[a-zA-Z0-9+/]*={0,2}$/u.test(data)) {
        try{const file=this.store.attach(sessionId,value.name??value.filename??`output-${artifacts.length+1}`,mime,data);artifacts.push(file);return {type:value.type??"resource",attachment:file};}catch{/* Preserve a bounded diagnostic representation if the native content is invalid. */}
      }
      return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,depth+1)]));
    };
    const transformed=visit(payload,0);
    return artifacts.length?{...(transformed && typeof transformed==="object" && !Array.isArray(transformed)?transformed:{content:transformed}),artifacts}:transformed;
  }
  subscribe(id:string,fn:(event:HarnessEvent)=>void){this.session(id);this.events.on(id,fn);return ()=>{this.events.off(id,fn);};}
  private save(s:HarnessSession){if(this.stopped)return;this.store.save(s);this.emit(s.id,{type:"session.updated",payload:s});}
  async catalog(targetId="local"):Promise<HarnessDescriptor[]> {
    const target=this.store.target(targetId);if(target.kind==="ssh")fail("Query the remote Host catalog through its SSH bridge",409);
    const detected=new Map((await this.integrations.list()).map(v=>[v.id,v]));
    const definitions:Array<[string,{name:string;protocol:HarnessDescriptor["protocol"];command:string;custom?:boolean}]>=[...Object.entries(ADAPTERS),...this.store.registrations().map(v=>[v.id,{name:v.name,protocol:"acp" as const,command:v.executable,custom:true}] as [string,{name:string;protocol:"acp";command:string;custom:boolean}])];
    const result=await Promise.all(definitions.map(async([id,definition])=>{
      const found=detected.get(id);const executable=target.kind==="container"?await this.containerExecutable(target.container!,definition.command):definition.custom?definition.command:await this.integrations.executablePath(id);
      const caps=capabilities();for(const key of ["queue","attachments","remote","diagnostics","automations"] as const)caps[key]=supported("multivibe");
      caps.sessions=supported();caps.streaming=supported();
      if(target.kind==="container" && ["claude-code","opencode"].includes(id)){caps.sessions=unsupported("Install a MultiVibe Host inside this container for SDK/HTTP supervision");}
      return {id,name:definition.name,protocol:definition.protocol,detected:target.kind==="container"?Boolean(executable):definition.custom || Boolean(found?.detected),configured:target.kind!=="container" && (Boolean(found?.configured) || (["claude-code","hermes-agent"].includes(id) && Boolean(this.options.modelConnection?.().apiKey))),available:Boolean(executable)&&caps.sessions.available,
        authentication:"unknown",capabilities:caps,...(!executable?{reason:"Harness executable is not installed on this Host"}:!caps.sessions.available?{reason:caps.sessions.reason}:{})} as HarnessDescriptor;
    }));
    if(target.kind==="local")result.push(this.librechat.descriptor(),this.openwebui.descriptor());
    return result;
  }
  private async containerExecutable(container:string,command:string) {
    const key=`${container}:${command}`,cached=this.containerExecutables.get(key);if(cached && cached.expires>Date.now())return cached.value;
    let value:string|null=null;try{const result=await promisify(execFile)("docker",["exec",container,"sh","-c",'command -v "$1"',"_",command],{timeout:5000,maxBuffer:4096});value=result.stdout.trim()||null;}catch{}
    this.containerExecutables.set(key,{expires:Date.now()+15_000,value});return value;
  }
  async create(input:any):Promise<HarnessSession> {
    const id=input.id?identifier(input.id):randomUUID();
    const existing=this.states.get(id);
    if(existing){if(existing.harnessId!==input.harnessId || existing.targetId!==(input.targetId??"local") || input.authMode && input.authMode!==existing.authMode)fail("A conversation's harness, authentication mode and execution target are fixed",409);return existing;}
    const harnessId=identifier(input.harnessId);const targetId=identifier(input.targetId??"local");const target=this.store.target(targetId);
    const descriptor=(await this.catalog(targetId)).find(v=>v.id===harnessId);if(!descriptor?.available)fail(descriptor?.reason??"Harness is unavailable",409);
    if(["librechat","openwebui"].includes(harnessId) && input.authMode && input.authMode!=="native")fail("Remote chat harnesses use their own API key and model configuration",422);
    const authMode=input.authMode??"native";if(!["native","multivibe"].includes(authMode))fail("Invalid model authentication mode");
    if(authMode==="multivibe" && (!descriptor.configured || !input.model))fail("Connect this harness to MultiVibe and select a model first",409);
    let history:string|undefined;
    if(input.history!==undefined){
      if(!Array.isArray(input.history) || input.history.length>20_000 || input.history.some((v:any)=>!["user","assistant"].includes(v?.role) || typeof v.content!=="string"))fail("Invalid conversation migration history");
      history=JSON.stringify(input.history);if(Buffer.byteLength(history)>16*1024*1024)fail("Conversation migration exceeds 16 MiB; export it before continuing",413);
    }
    let workspace:string;
    if(input.workspace){workspace=requiredText(input.workspace,4096);if(!path.isAbsolute(workspace))fail("Workspace must be an absolute path");if(target.kind==="local"){workspace=fs.realpathSync(workspace);if(!fs.statSync(workspace).isDirectory())fail("Workspace is not a directory");}}
    else {if(target.kind==="container")fail("Specify a workspace inside the container");workspace=path.join(this.root,"workspaces",id);fs.mkdirSync(workspace,{recursive:true,mode:0o700});}
    if(input.nativeSessionId)fail("Use native-session discovery and its ownership check to resume an external session",409);
    const now=Date.now();const s:HarnessSession={id,harnessId,targetId,workspace,title:typeof input.title==="string"?input.title.slice(0,200):"Nouvelle conversation",...(input.model?{model:requiredText(input.model,256)}:{}),authMode,state:"idle",queuePaused:false,revision:0,archived:false,pinned:false,createdAt:now,updatedAt:now,capabilities:descriptor.capabilities};
    if(harnessId==="librechat" || harnessId==="openwebui"){const connection=this[harnessId].read()!;s.model=connection.agentId;s.configuration={endpoint:connection.endpoint};}
    const registration=this.store.registrations().find(v=>v.id===harnessId);if(registration)s.configuration={acpArgs:registration.args};
    this.states.set(id,s);this.store.save(s);
    if(history){try{const attachment=this.store.attach(id,"prior-conversation.json","text/plain",Buffer.from(history).toString("base64"));s.configuration={...s.configuration,migrationContext:attachment.id};this.store.save(s);this.emit(id,{type:"notice",payload:{message:"The previous conversation is preserved as an attached transcript for the first turn. Native operations from the old session are not replayed.",attachment}});}catch(e){this.states.delete(id);this.store.delete(id);throw e;}}
    this.emit(id,{type:"session.created",payload:s});return s;
  }
  update(id:string,value:any) {
    const s=this.session(id);
    if(value.title!==undefined)s.title=requiredText(value.title,200);
    for(const key of ["archived","pinned"] as const)if(value[key]!==undefined){if(typeof value[key]!=="boolean")fail("Invalid session metadata");s[key]=value[key];}
    this.save(s);return s;
  }
  private async ensure(id:string) {
    if(this.stopped)fail("Host runtime is shutting down",503);
    let adapter=this.adapters.get(id);if(adapter)return adapter;
    adapter=(async()=>{
      const s=this.session(id),target=this.store.target(s.targetId);
      const registration=this.store.registrations().find(v=>v.id===s.harnessId);
      const executable=["librechat","openwebui"].includes(s.harnessId)?"remote-chat-http":registration?.executable??(target.kind==="container"?ADAPTERS[s.harnessId as keyof typeof ADAPTERS]?.command:await this.integrations.executablePath(s.harnessId));
      if(!executable)fail("Harness executable is unavailable",409);
      const root=path.join(this.root,"sessions",s.id);fs.mkdirSync(root,{recursive:true,mode:0o700});
      const connection=s.harnessId==="librechat" || s.harnessId==="openwebui"?this[s.harnessId].read():undefined;
      if(["librechat","openwebui"].includes(s.harnessId) && (!connection || connection.endpoint!==s.configuration?.endpoint))fail("Reconnect the original server endpoint to resume this conversation",409);
      const instance=this.factory({session:s,root,executable,target,...(connection?(s.harnessId==="openwebui"?{openWebUIConnection:connection}:{libreChatConnection:connection}):{}),emit:event=>{if(!this.stopped && this.states.has(id))this.emit(id,event);},
        ...(s.authMode==="multivibe" && target.kind==="local" && this.options.modelConnection?{modelConnection:this.options.modelConnection()}:{}),
        nativeSession:nativeId=>{if(this.stopped || !this.states.has(id))return;requiredText(nativeId,4096);s.nativeSessionId=nativeId;this.store.save(s);this.emit(id,{type:"session.updated",payload:s});},
        capabilities:values=>{if(this.stopped || !this.states.has(id) || Object.entries(values).every(([key,value])=>JSON.stringify(s.capabilities[key as keyof typeof s.capabilities])===JSON.stringify(value)))return;Object.assign(s.capabilities,values);this.store.save(s);this.emit(id,{type:"capabilities.updated",payload:s.capabilities});},
        attachment:attachmentId=>this.store.attachment(id,attachmentId),ask:(kind,title,detail)=>this.ask(id,kind,title,detail),
      });
      try{
        await instance.start();
        if(this.factory===adapterFor && target.kind==="local" && ["pi","openai-codex","claude-code","opencode"].includes(s.harnessId)){
          try{const result=await promisify(execFile)(executable,["--version"],{cwd:s.workspace,env:harnessEnvironment(s.authMode==="native"),timeout:5000,maxBuffer:8192});const version=result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.]+)?\b/u)?.[0];if(version)s.harnessVersion=version;}catch{/* Version remains unknown when the installed CLI does not report it. */}
        }
        this.save(s);return instance;
      }catch(e){instance.close();this.adapters.delete(id);throw e;}
    })();this.adapters.set(id,adapter);
    void adapter.catch(()=>{if(this.adapters.get(id)===adapter)this.adapters.delete(id);});
    return adapter;
  }
  async command(id:string,input:any):Promise<HarnessCommandReceipt> {
    if(this.stopped)fail("Host runtime is shutting down",503);
    const s=this.session(id);identifier(input?.id);if(!COMMANDS.has(input?.type))fail("Unknown harness command");
    const command:HarnessCommand={id:input.id,type:input.type,...(input.turnId?{turnId:identifier(input.turnId)}:{}),...(input.parts?{parts:messageParts(input.parts)}:{}),...(input.value?{value:input.value}:{})};
    if(typeof input.displayText==="string" && input.displayText.length<=32_000)command.displayText=input.displayText;
    if(input.value && (typeof input.value!=="object" || Array.isArray(input.value) || Buffer.byteLength(JSON.stringify(input.value))>256*1024))fail("Invalid command parameters");
    if(["prompt","steer"].includes(command.type) && !command.parts)fail("Message content is required");
    for(const p of command.parts??[])if(p.type==="attachment")this.store.attachment(id,p.attachmentId);
    const {receipt,fresh}=this.store.command(id,command);if(!fresh)return receipt;
    this.emit(id,{type:"command.updated",payload:receipt});
    if(command.type==="prompt") {void this.drain(id);return receipt;}
    let acquiredControl=false;
    try {
      const v=command.value??{};
      if(["configure","native","fork","compact"].includes(command.type)){if(this.controls.has(id))fail("Another session control is still pending",409);this.controls.add(id);acquiredControl=true;receipt.state="accepted";this.store.saveReceipt(receipt);}
      switch(command.type) {
        case "pause_queue":s.queuePaused=true;break;
        case "resume_queue":
          if(s.state==="uncertain")fail("Reconcile the uncertain native operation before resuming",409);
          s.queuePaused=false;if(s.state==="interrupted" || s.state==="failed")s.state="idle";break;
        case "queue_edit":case "queue_remove": {
          const pending=this.store.receipt(identifier(v.commandId));
          if(!pending || pending.sessionId!==id || pending.command.type!=="prompt" || pending.state!=="queued")fail("Only an undispatched message can be changed",409);
          if(command.type==="queue_remove")pending.state="cancelled";
          else {pending.command.parts=messageParts(v.parts);pending.command.displayText=pending.command.parts.filter(p=>p.type==="text").map(p=>(p as any).text).join("\n");}
          for(const p of pending.command.parts??[])if(p.type==="attachment")this.store.attachment(id,p.attachmentId);
          this.store.saveReceipt(pending);this.emit(id,{type:"command.updated",payload:pending});break;
        }
        case "queue_reorder": {
          const pending=this.store.commands(id).filter(c=>c.command.type==="prompt" && c.state==="queued");
          if(!Array.isArray(v.ids) || v.ids.length!==pending.length || new Set(v.ids).size!==pending.length || v.ids.some(key=>!pending.some(c=>c.id===key)))fail("Reordering must include exactly the pending messages",409);
          (v.ids as string[]).forEach((key,index)=>{const c=pending.find(p=>p.id===key)!;c.ordinal=index;this.store.saveReceipt(c);this.emit(id,{type:"command.updated",payload:c});});break;
        }
        case "interrupt": {
          s.queuePaused=true;s.state="interrupted";this.save(s);
          const activeId=s.activeTurnId,active=activeId?this.store.receipt(activeId):undefined;
          if(active){active.cancelRequested=true;this.store.saveReceipt(active);}
          for(const [key,answer] of this.answers)if(answer.sessionId===id){answer.reject(new HarnessRuntimeError("Interaction interrupted",499));clearTimeout(answer.timer);this.answers.delete(key);this.privateInteractions.delete(key);const interaction=this.store.interactions(id).find(i=>i.id===key);if(interaction){interaction.status="cancelled";this.store.interaction(interaction);this.emit(id,{type:"interaction.updated",payload:interaction});}}
          if(this.adapters.has(id) && activeId){const adapter=await this.ensure(id);try{await adapter.interrupt();}catch(e:any){if(e.status!==499)throw e;}if(adapter.restartAfterInterrupt){adapter.close();this.adapters.delete(id);}const current=this.store.receipt(activeId);if(current){current.cancelRequested=true;current.cancelAcknowledged=true;if(!["completed","failed","cancelled"].includes(current.state)){current.state="cancelled";this.emit(id,{type:"turn.cancelled",itemId:activeId,payload:{commandId:activeId}});}this.store.saveReceipt(current);s.state=current.state==="completed"?"idle":current.state==="failed"?"failed":"interrupted";}}
          break;
        }
        case "steer": {
          if(!s.activeTurnId || command.turnId!==s.activeTurnId || this.store.receipt(s.activeTurnId)?.command.type!=="prompt")fail("The active turn changed; the steering message was not sent",409);
          const adapter=await this.ensure(id);if(command.turnId!==s.activeTurnId)fail("The active turn changed; the steering message was not sent",409);if(!s.capabilities.steer.available)fail(s.capabilities.steer.reason??"Steering is not advertised by this harness",422);
          await adapter.prompt(command.parts!,true);receipt.state="accepted";this.emit(id,{type:"steer.accepted",payload:{commandId:receipt.id,parts:command.parts}});break;
        }
        case "respond": {
          const key=identifier(v.interactionId);const answer=this.answers.get(key);
          const interaction=this.store.interactions(id).find(p=>p.id===key);
          if(!answer || answer.sessionId!==id || !interaction || interaction.status!=="pending" || interaction.expiresAt<Date.now())fail("This interaction expired or belongs to another session",409);
          if(!v.answer || typeof v.answer!=="object")fail("An interaction answer is required");
          interaction.status="answered";this.store.interaction(interaction);clearTimeout(answer.timer);this.answers.delete(key);this.privateInteractions.delete(key);answer.resolve(v.answer as Record<string,unknown>);this.emit(id,{type:"interaction.updated",payload:interaction});break;
        }
        case "inspect":receipt.result=await this.inspect(id,requiredText(v.subject,64));break;
        case "configure": {
          if(v.schedule){receipt.result=this.configureSchedule(id,v.schedule);break;}
          if(s.activeTurnId)fail("Change session settings between turns",409);
          if(v.resource){if(this.store.target(s.targetId).kind!=="local")fail("Edit memory through the Host that owns this environment",422);receipt.result=writeHarnessResource(s,v.resource);break;}
          receipt.result=await (await this.ensure(id)).configure(v);if(typeof v.model==="string")s.model=v.model;break;
        }
        case "compact": {
          if(s.activeTurnId)fail("Wait for the active turn before manually compacting",409);
          s.activeTurnId=receipt.id;s.state="compacting";this.save(s);
          try{receipt.result=await (await this.ensure(id)).compact(typeof v.instructions==="string"?v.instructions:undefined);}
          finally{delete s.activeTurnId;this.nativeTerminals.delete(receipt.id);s.state="idle";}
          break;
        }
        case "native":case "fork": {
          if(s.activeTurnId)fail("Run this native operation between turns",409);
          receipt.result=await (await this.ensure(id)).native(requiredText(v.method,128),(v.params??{}) as Record<string,unknown>);break;
        }
      }
      if(command.type!=="steer")receipt.state="completed";
      this.save(s);
    }catch(e:any){receipt.state="failed";receipt.error=String(redact(e.message??"Harness command failed"));if(command.type==="compact"){s.state="failed";s.queuePaused=true;this.emit(id,{type:"compaction",payload:{state:"failed",error:receipt.error}});this.save(s);}if(command.type==="interrupt" && s.activeTurnId && !e.status){s.state="uncertain";s.queuePaused=true;this.save(s);}}
    finally{if(acquiredControl)this.controls.delete(id);}
    if(this.stopped)return receipt;
    if(receipt.result!==undefined)receipt.result=redact(receipt.result);
    this.store.saveReceipt(receipt);this.emit(id,{type:"command.updated",payload:receipt});
    if(!s.queuePaused)void this.drain(id);return receipt;
  }
  private async drain(id:string) {
    if(this.working.has(id) || this.stopped)return;const s=this.session(id);
    if(s.activeTurnId || s.queuePaused || s.state==="uncertain" || s.state==="waiting_user" || this.controls.has(id))return;
    this.working.add(id);
    try {
      for(;;) {
        if(s.queuePaused || this.stopped || s.state==="uncertain")break;
        const c=this.store.commands(id).find(v=>v.command.type==="prompt" && v.state==="queued");if(!c)break;
        c.state="dispatching";this.store.saveReceipt(c);s.activeTurnId=c.id;s.state="starting";this.save(s);
        let submitted=false,userEmitted=false;const emitUser=()=>{if(userEmitted)return;userEmitted=true;this.emit(id,{type:"message.user",itemId:c.id,payload:{parts:c.command.parts,displayText:c.command.displayText,attachments:(c.command.parts??[]).filter(p=>p.type==="attachment").flatMap(p=>{try{return [this.store.attachment(id,(p as any).attachmentId).info];}catch{return [];}})}});};
        try {
          const adapter=await this.ensure(id);if(this.stopped)break;
          emitUser();
          if(this.store.receipt(c.id)?.cancelRequested)c.state="cancelled";
          else {
            s.state="running";c.state="accepted";this.store.saveReceipt(c);this.save(s);this.emit(id,{type:"command.updated",payload:c});
            let parts=c.command.parts!;
            if(typeof s.configuration?.migrationContext==="string"){
              parts=[{type:"text",text:"Previous conversation transcript, supplied as conversation context. Continue from it; do not repeat actions merely because they appear in the transcript."},{type:"attachment",attachmentId:s.configuration.migrationContext},...parts];
              delete s.configuration.migrationContext;this.store.save(s);
            }
            submitted=true;await adapter.prompt(parts);
            const terminal=this.nativeTerminals.get(c.id);c.state=terminal?.state??(this.store.receipt(c.id)?.cancelRequested?"cancelled":"completed");if(terminal?.error)c.error=terminal.error;
          }
          s.state=c.state==="cancelled"?"interrupted":c.state==="failed"?"failed":"idle";if(c.state==="failed")s.queuePaused=true;
        }catch(e:any) {
          if(!this.stopped)emitUser();
          c.error=String(redact(e.message??"Harness turn failed"));
          const terminal=this.nativeTerminals.get(c.id);
          if(terminal){c.state=terminal.state;s.state=terminal.state==="completed"?"idle":terminal.state==="cancelled"?"interrupted":"failed";}
          else if(e.status===499){c.state="cancelled";s.state="interrupted";}
          else if(!submitted || e.status && e.status<500){c.state="failed";s.state="failed";}
          else {c.state="uncertain";s.state="uncertain";}
          s.queuePaused=true;this.emit(id,{type:"diagnostic",payload:{message:c.error,state:c.state}});
        }
        if(this.stopped)break;
        const cancellation=this.store.receipt(c.id);c.cancelRequested=cancellation?.cancelRequested;c.cancelAcknowledged=cancellation?.cancelAcknowledged;
        this.store.saveReceipt(c);this.emit(id,{type:"command.updated",payload:c});this.emit(id,{type:`turn.${c.state}`,payload:{commandId:c.id,error:c.error}});if(c.state!=="uncertain"){delete s.activeTurnId;this.nativeTerminals.delete(c.id);}this.save(s);
      }
    }finally{this.working.delete(id);}
  }
  private ask(sessionId:string,kind:PendingInteraction["kind"],title:string,detail:unknown):Promise<Record<string,unknown>> {
    if(this.stopped)fail("Host runtime is shutting down",503);
    const s=this.session(sessionId),previousState=s.state;const interaction:PendingInteraction={id:randomUUID(),sessionId,kind,title:kind==="authentication"?"Authentification du connecteur":String(redact(title)).slice(0,256),detail:kind==="authentication"?{mode:"url",message:"Authentification requise dans le navigateur du harness."}:redact(detail),status:"pending",createdAt:Date.now(),expiresAt:Date.now()+30*60_000};
    if(kind==="authentication")this.privateInteractions.set(interaction.id,detail);
    this.store.interaction(interaction);s.state="waiting_user";this.save(s);this.emit(sessionId,{type:"interaction.requested",payload:interaction});
    return new Promise((resolve,reject)=>{
      const restoreState=()=>{s.state=this.store.interactions(sessionId).some(i=>i.status==="pending")?"waiting_user":s.activeTurnId?(previousState==="compacting"?"compacting":"running"):previousState==="waiting_user"?"idle":previousState;this.save(s);};
      const timer=setTimeout(()=>{interaction.status="expired";this.store.interaction(interaction);this.answers.delete(interaction.id);this.privateInteractions.delete(interaction.id);restoreState();this.emit(sessionId,{type:"interaction.updated",payload:interaction});reject(new Error("User interaction expired"));},30*60_000);timer.unref();
      this.answers.set(interaction.id,{sessionId,timer,reject,resolve:answer=>{restoreState();resolve(answer);}});
    });
  }
  async inspect(id:string,subject:string):Promise<unknown> {
    const s=this.session(id);
    if(subject==="automations")return {origin:"multivibe",schedules:this.store.schedules(id),nativeAutomations:"not_advertised"};
    if(subject==="memory" || subject==="instructions") {
      if(this.store.target(s.targetId).kind!=="local")fail("Inspect resources through the Host inside this environment",422);
      const sources=harnessResources(s,subject);
      if(!sources.length)fail("This harness does not publish inspectable resources for this feature",422);
      s.capabilities[subject]=supported("native",{composition:"harness_owned",editable:sources.some(v=>v.writable)});this.save(s);
      return {kind:subject,composition:"harness_owned",sources};
    }
    if(subject==="capabilities")return s.capabilities;
    if(subject==="diagnostics")return {session:s,queue:this.store.commands(id),events:this.store.events(id,0,500)};
    if(subject==="workspace")return {path:s.workspace,target:this.store.target(s.targetId)};
    if(subject==="skills") {
      try{return await (await this.ensure(id)).inspect(subject);}catch(e:any){if(e.status!==422)throw e;}
      return this.skills(s);
    }
    return (await this.ensure(id)).inspect(subject);
  }
  private configureSchedule(sessionId:string,input:any) {
    const id=input.id?identifier(input.id):randomUUID();const existing=this.store.schedules().find(s=>s.id===id);
    if(existing && existing.sessionId!==sessionId)fail("Schedule belongs to another session",403);
    if(input.remove===true){this.store.removeSchedule(id,sessionId);return {id,removed:true};}
    if(existing && typeof input.enabled==="boolean" && !input.parts){existing.enabled=input.enabled;this.store.saveSchedule(existing);return existing;}
    if(!existing && (this.store.schedules(sessionId).length>=50 || this.store.schedules().length>=500))fail("Schedule limit reached",409);
    const parts=messageParts(input.parts);for(const part of parts)if(part.type==="attachment")this.store.attachment(sessionId,part.attachmentId);
    if(!Number.isSafeInteger(input.nextAt) || input.nextAt<0)fail("Invalid scheduled time");
    if(input.intervalMs!==undefined && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs<60_000 || input.intervalMs>365*24*3600_000))fail("Schedule interval must be between one minute and one year");
    const schedule={id,sessionId,name:requiredText(input.name,200),parts,nextAt:input.nextAt,...(input.intervalMs?{intervalMs:input.intervalMs}:{}),enabled:true,...(existing?.lastCommandId?{lastCommandId:existing.lastCommandId}:{})};
    this.store.saveSchedule(schedule);this.emit(sessionId,{type:"automation.updated",payload:schedule});return schedule;
  }
  async tickSchedules(now=Date.now()) {
    if(this.stopped)return;
    for(const schedule of this.store.schedules()) {
      if(!schedule.enabled || schedule.nextAt>now)continue;
      const previous=schedule.lastCommandId?this.store.receipt(schedule.lastCommandId):undefined;
      if(!previous || !["queued","dispatching","accepted","uncertain"].includes(previous.state)) {
        const id=`schedule-${schedule.id}-${schedule.nextAt}`;
        await this.command(schedule.sessionId,{id,type:"prompt",parts:schedule.parts});schedule.lastCommandId=id;
        this.emit(schedule.sessionId,{type:"automation.enqueued",payload:{scheduleId:schedule.id,commandId:id}});
      }
      if(schedule.intervalMs)schedule.nextAt+=Math.max(1,Math.floor((now-schedule.nextAt)/schedule.intervalMs)+1)*schedule.intervalMs;
      else schedule.enabled=false;
      this.store.saveSchedule(schedule);
    }
  }
  private skills(s:HarnessSession) {
    if(this.store.target(s.targetId).kind!=="local")fail("Discover skills through the Host inside this environment",422);
    const homes:Record<string,string>={pi:".pi/agent/skills","hermes-agent":".hermes/skills","openai-codex":".codex/skills","claude-code":".claude/skills",opencode:".config/opencode/skills","gemini-cli":".gemini/skills"};
    const roots=[path.join(os.homedir(),homes[s.harnessId]??".multivibe/skills"),...['.agents/skills','.claude/skills','.pi/skills','.gemini/skills'].map(p=>path.join(s.workspace,p))];
    const result:any[]=[];
    const visit=(root:string,scope:string,depth:number)=>{if(depth>3 || result.length>=500)return;let entries:fs.Dirent[];try{entries=fs.readdirSync(root,{withFileTypes:true});}catch{return;}
      for(const entry of entries){if(entry.isSymbolicLink())continue;const file=path.join(root,entry.name);if(entry.isDirectory())visit(file,scope,depth+1);else if(entry.name==="SKILL.md"){const st=fs.statSync(file);if(st.size>256_000)continue;const text=fs.readFileSync(file,"utf8");result.push({name:text.match(/^name:\s*["']?(.+?)["']?\s*$/mu)?.[1]??path.basename(root),description:text.match(/^description:\s*["']?(.+?)["']?\s*$/mu)?.[1]??"",path:file,scope,source:"filesystem",activation:"managed_by_harness"});}}
    };
    roots.forEach((root,index)=>visit(root,index?"project":"user",0));return result;
  }
  delete(id:string) {
    const s=this.session(id);if(s.activeTurnId || this.controls.has(id) || this.store.interactions(id).some(i=>i.status==="pending"))fail("Stop this session before deleting it",409);
    const adapter=this.adapters.get(id);if(adapter)void adapter.then(a=>a.close()).catch(()=>{});
    this.adapters.delete(id);this.states.delete(id);this.store.delete(id);
  }
  async close() {
    this.stopped=true;
    clearInterval(this.scheduler);
    for(const answer of this.answers.values()){clearTimeout(answer.timer);answer.reject(new Error("Host shutting down"));}this.answers.clear();
    this.privateInteractions.clear();
    for(const [id,promise] of this.adapters){const s=this.session(id);if(s.activeTurnId){s.state="uncertain";s.queuePaused=true;this.store.save(s);}try{(await promise).close();}catch{}}
    this.events.removeAllListeners();
    // Allow process rejection handlers to finish before closing the journal.
    await new Promise<void>(resolve=>setImmediate(resolve));this.store.close();
  }
}
