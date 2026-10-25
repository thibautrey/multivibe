import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { HostHarnessIntegrationManager } from "../harness-integrations.js";
import { adapterFor } from "./adapters.js";
import { HarnessRuntimeStore } from "./store.js";
import { capabilities, fail, identifier, messageParts, redact, requiredText, supported, unsupported, type AdapterContext, type AdapterEvent, type HarnessAdapter, type HarnessCommand, type HarnessCommandReceipt, type HarnessDescriptor, type HarnessEvent, type HarnessSession, type PendingInteraction } from "./types.js";

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
  private events=new EventEmitter();
  private adapters=new Map<string,Promise<HarnessAdapter>>();
  private states=new Map<string,HarnessSession>();
  private working=new Set<string>();
  private answers=new Map<string,{sessionId:string;resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private stopped=false;
  constructor(readonly root:string,private integrations:Integration,private factory:(ctx:AdapterContext)=>HarnessAdapter=adapterFor) {
    this.store=new HarnessRuntimeStore(root);this.events.setMaxListeners(100);
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
  snapshot(id:string){return {session:this.session(id),queue:this.store.commands(id).filter(c=>c.command.type==="prompt" && ["queued","dispatching","accepted","uncertain"].includes(c.state)),interactions:this.store.interactions(id).filter(v=>v.status==="pending")};}
  private emit(id:string,event:AdapterEvent):HarnessEvent {
    const s=this.session(id);const saved=this.store.event(id,event.type,event.payload,s.activeTurnId,event.itemId);this.events.emit(id,saved);return saved;
  }
  subscribe(id:string,fn:(event:HarnessEvent)=>void){this.session(id);this.events.on(id,fn);return ()=>{this.events.off(id,fn);};}
  private save(s:HarnessSession){this.store.save(s);this.emit(s.id,{type:"session.updated",payload:s});}
  async catalog(targetId="local"):Promise<HarnessDescriptor[]> {
    const target=this.store.target(targetId);if(target.kind==="ssh")fail("Query the remote Host catalog through its SSH bridge",409);
    const detected=new Map((await this.integrations.list()).map(v=>[v.id,v]));
    const definitions:Array<[string,{name:string;protocol:HarnessDescriptor["protocol"];command:string;custom?:boolean}]>=[...Object.entries(ADAPTERS),...this.store.registrations().map(v=>[v.id,{name:v.name,protocol:"acp" as const,command:v.executable,custom:true}] as [string,{name:string;protocol:"acp";command:string;custom:boolean}])];
    return Promise.all(definitions.map(async([id,definition])=>{
      const found=detected.get(id);const executable=target.kind==="container" || definition.custom?definition.command:await this.integrations.executablePath(id);
      const caps=capabilities();for(const key of ["queue","attachments","remote","diagnostics"] as const)caps[key]=supported("multivibe");
      caps.sessions=supported();caps.streaming=supported();
      if(target.kind==="container" && ["claude-code","opencode"].includes(id)){caps.sessions=unsupported("Install a MultiVibe Host inside this container for SDK/HTTP supervision");}
      return {id,name:definition.name,protocol:definition.protocol,detected:definition.custom || (target.kind!=="container" && Boolean(found?.detected)),configured:Boolean(found?.configured),available:Boolean(executable)&&caps.sessions.available,
        authentication:"unknown",capabilities:caps,...(!executable?{reason:"Harness executable is not installed on this Host"}:!caps.sessions.available?{reason:caps.sessions.reason}:{})} as HarnessDescriptor;
    }));
  }
  async create(input:any):Promise<HarnessSession> {
    const id=input.id?identifier(input.id):randomUUID();
    const existing=this.states.get(id);
    if(existing){if(existing.harnessId!==input.harnessId || existing.targetId!==(input.targetId??"local"))fail("A conversation's harness and execution target are fixed",409);return existing;}
    const harnessId=identifier(input.harnessId);const targetId=identifier(input.targetId??"local");const target=this.store.target(targetId);
    const descriptor=(await this.catalog(targetId)).find(v=>v.id===harnessId);if(!descriptor?.available)fail(descriptor?.reason??"Harness is unavailable",409);
    const authMode=input.authMode??"native";if(!["native","multivibe"].includes(authMode))fail("Invalid model authentication mode");
    if(authMode==="multivibe" && (!descriptor.configured || !input.model))fail("Connect this harness to MultiVibe and select a model first",409);
    let workspace:string;
    if(input.workspace){workspace=requiredText(input.workspace,4096);if(!path.isAbsolute(workspace))fail("Workspace must be an absolute path");if(target.kind==="local"){workspace=fs.realpathSync(workspace);if(!fs.statSync(workspace).isDirectory())fail("Workspace is not a directory");}}
    else {if(target.kind==="container")fail("Specify a workspace inside the container");workspace=path.join(this.root,"workspaces",id);fs.mkdirSync(workspace,{recursive:true,mode:0o700});}
    if(input.nativeSessionId)fail("Use native-session discovery and its ownership check to resume an external session",409);
    const now=Date.now();const s:HarnessSession={id,harnessId,targetId,workspace,title:typeof input.title==="string"?input.title.slice(0,200):"Nouvelle conversation",...(input.model?{model:requiredText(input.model,256)}:{}),authMode,state:"idle",queuePaused:false,revision:0,archived:false,pinned:false,createdAt:now,updatedAt:now,capabilities:descriptor.capabilities};
    const registration=this.store.registrations().find(v=>v.id===harnessId);if(registration)s.configuration={acpArgs:registration.args};
    this.states.set(id,s);this.store.save(s);this.emit(id,{type:"session.created",payload:s});return s;
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
      const executable=registration?.executable??(target.kind==="container"?ADAPTERS[s.harnessId as keyof typeof ADAPTERS]?.command:await this.integrations.executablePath(s.harnessId));
      if(!executable)fail("Harness executable is unavailable",409);
      const root=path.join(this.root,"sessions",s.id);fs.mkdirSync(root,{recursive:true,mode:0o700});
      const instance=this.factory({session:s,root,executable,target,emit:event=>{if(!this.stopped)this.emit(id,event);},
        nativeSession:nativeId=>{requiredText(nativeId,4096);s.nativeSessionId=nativeId;this.store.save(s);this.emit(id,{type:"session.updated",payload:s});},
        capabilities:values=>{Object.assign(s.capabilities,values);this.store.save(s);this.emit(id,{type:"capabilities.updated",payload:s.capabilities});},
        attachment:attachmentId=>this.store.attachment(id,attachmentId),ask:(kind,title,detail)=>this.ask(id,kind,title,detail),
      });
      try{await instance.start();return instance;}catch(e){instance.close();this.adapters.delete(id);throw e;}
    })();this.adapters.set(id,adapter);return adapter;
  }
  async command(id:string,input:any):Promise<HarnessCommandReceipt> {
    const s=this.session(id);identifier(input?.id);if(!COMMANDS.has(input?.type))fail("Unknown harness command");
    const command:HarnessCommand={id:input.id,type:input.type,...(input.turnId?{turnId:identifier(input.turnId)}:{}),...(input.parts?{parts:messageParts(input.parts)}:{}),...(input.value?{value:input.value}:{})};
    if(input.value && (typeof input.value!=="object" || Array.isArray(input.value) || Buffer.byteLength(JSON.stringify(input.value))>256*1024))fail("Invalid command parameters");
    if(["prompt","steer"].includes(command.type) && !command.parts)fail("Message content is required");
    for(const p of command.parts??[])if(p.type==="attachment")this.store.attachment(id,p.attachmentId);
    const {receipt,fresh}=this.store.command(id,command);if(!fresh)return receipt;
    this.emit(id,{type:"command.updated",payload:receipt});
    if(command.type==="prompt") {void this.drain(id);return receipt;}
    try {
      const v=command.value??{};
      switch(command.type) {
        case "pause_queue":s.queuePaused=true;break;
        case "resume_queue":
          if(s.state==="uncertain")fail("Reconcile the uncertain native operation before resuming",409);
          s.queuePaused=false;if(s.state==="interrupted" || s.state==="failed")s.state="idle";break;
        case "queue_edit":case "queue_remove": {
          const pending=this.store.receipt(identifier(v.commandId));
          if(!pending || pending.sessionId!==id || pending.command.type!=="prompt" || pending.state!=="queued")fail("Only an undispatched message can be changed",409);
          if(command.type==="queue_remove")pending.state="cancelled";
          else pending.command.parts=messageParts(v.parts);
          for(const p of pending.command.parts??[])if(p.type==="attachment")this.store.attachment(id,p.attachmentId);
          this.store.saveReceipt(pending);this.emit(id,{type:"command.updated",payload:pending});break;
        }
        case "queue_reorder": {
          const pending=this.store.commands(id).filter(c=>c.command.type==="prompt" && c.state==="queued");
          if(!Array.isArray(v.ids) || v.ids.length!==pending.length || new Set(v.ids).size!==pending.length || v.ids.some(key=>!pending.some(c=>c.id===key)))fail("Reordering must include exactly the pending messages",409);
          (v.ids as string[]).forEach((key,index)=>{const c=pending.find(p=>p.id===key)!;c.ordinal=index;this.store.saveReceipt(c);});break;
        }
        case "interrupt": {
          s.queuePaused=true;s.state="interrupted";this.save(s);
          for(const [key,answer] of this.answers)if(answer.sessionId===id){answer.reject(new Error("Interaction interrupted"));clearTimeout(answer.timer);this.answers.delete(key);const interaction=this.store.interactions(id).find(i=>i.id===key);if(interaction){interaction.status="expired";this.store.interaction(interaction);}}
          if(this.adapters.has(id) && s.activeTurnId)await (await this.ensure(id)).interrupt();
          s.state="interrupted";break;
        }
        case "steer": {
          if(!s.activeTurnId || command.turnId!==s.activeTurnId)fail("The active turn changed; the steering message was not sent",409);
          const adapter=await this.ensure(id);if(!s.capabilities.steer.available)fail(s.capabilities.steer.reason??"Steering is not advertised by this harness",422);
          await adapter.prompt(command.parts!,true);receipt.state="accepted";this.emit(id,{type:"steer.accepted",payload:{commandId:receipt.id,parts:command.parts}});break;
        }
        case "respond": {
          const key=identifier(v.interactionId);const answer=this.answers.get(key);
          const interaction=this.store.interactions(id).find(p=>p.id===key);
          if(!answer || answer.sessionId!==id || !interaction || interaction.status!=="pending" || interaction.expiresAt<Date.now())fail("This interaction expired or belongs to another session",409);
          if(!v.answer || typeof v.answer!=="object")fail("An interaction answer is required");
          interaction.status="answered";this.store.interaction(interaction);clearTimeout(answer.timer);this.answers.delete(key);answer.resolve(v.answer as Record<string,unknown>);this.emit(id,{type:"interaction.updated",payload:interaction});break;
        }
        case "inspect":receipt.result=await this.inspect(id,requiredText(v.subject,64));break;
        case "configure": {
          if(s.activeTurnId)fail("Change session settings between turns",409);
          receipt.result=await (await this.ensure(id)).configure(v);break;
        }
        case "compact": {
          if(s.activeTurnId)fail("Wait for the active turn before manually compacting",409);
          s.activeTurnId=receipt.id;s.state="compacting";this.save(s);
          try{receipt.result=await (await this.ensure(id)).compact(typeof v.instructions==="string"?v.instructions:undefined);}
          finally{delete s.activeTurnId;s.state="idle";}
          break;
        }
        case "native":case "fork": {
          if(s.activeTurnId)fail("Run this native operation between turns",409);
          receipt.result=await (await this.ensure(id)).native(requiredText(v.method,128),(v.params??{}) as Record<string,unknown>);break;
        }
      }
      if(receipt.state!=="accepted")receipt.state="completed";
      this.save(s);
    }catch(e:any){receipt.state="failed";receipt.error=String(redact(e.message??"Harness command failed"));}
    this.store.saveReceipt(receipt);this.emit(id,{type:"command.updated",payload:receipt});
    if(!s.queuePaused)void this.drain(id);return receipt;
  }
  private async drain(id:string) {
    if(this.working.has(id) || this.stopped)return;const s=this.session(id);
    if(s.activeTurnId || s.queuePaused || s.state==="uncertain")return;
    this.working.add(id);
    try {
      for(;;) {
        if(s.queuePaused || this.stopped || s.state==="uncertain")break;
        const c=this.store.commands(id).find(v=>v.command.type==="prompt" && v.state==="queued");if(!c)break;
        c.state="dispatching";this.store.saveReceipt(c);s.activeTurnId=c.id;s.state="starting";this.save(s);
        this.emit(id,{type:"message.user",itemId:c.id,payload:{parts:c.command.parts}});
        try {
          const adapter=await this.ensure(id);if(this.stopped)break;
          s.state="running";c.state="accepted";this.store.saveReceipt(c);this.save(s);this.emit(id,{type:"command.updated",payload:c});
          await adapter.prompt(c.command.parts!);
          c.state=s.queuePaused && s.state==="interrupted"?"cancelled":"completed";
          s.state=c.state==="cancelled"?"interrupted":"idle";
        }catch(e:any) {
          c.error=String(redact(e.message??"Harness turn failed"));
          if(s.state==="interrupted"){c.state="cancelled";}
          else if(e.status && e.status<500){c.state="failed";s.state="failed";}
          else {c.state="uncertain";s.state="uncertain";}
          s.queuePaused=true;this.emit(id,{type:"diagnostic",payload:{message:c.error,state:c.state}});
        }
        if(this.stopped)break;
        this.store.saveReceipt(c);this.emit(id,{type:`turn.${c.state}`,payload:{commandId:c.id,error:c.error}});delete s.activeTurnId;this.save(s);
      }
    }finally{this.working.delete(id);}
  }
  private ask(sessionId:string,kind:PendingInteraction["kind"],title:string,detail:unknown):Promise<Record<string,unknown>> {
    const s=this.session(sessionId);const interaction:PendingInteraction={id:randomUUID(),sessionId,kind,title:String(redact(title)).slice(0,256),detail:redact(detail),status:"pending",createdAt:Date.now(),expiresAt:Date.now()+30*60_000};
    this.store.interaction(interaction);s.state="waiting_user";this.save(s);this.emit(sessionId,{type:"interaction.requested",payload:interaction});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{interaction.status="expired";this.store.interaction(interaction);this.answers.delete(interaction.id);this.emit(sessionId,{type:"interaction.updated",payload:interaction});reject(new Error("User interaction expired"));},30*60_000);timer.unref();
      this.answers.set(interaction.id,{sessionId,timer,reject,resolve:answer=>{if(s.activeTurnId)s.state="running";this.save(s);resolve(answer);}});
    });
  }
  async inspect(id:string,subject:string):Promise<unknown> {
    const s=this.session(id);
    if(subject==="capabilities")return s.capabilities;
    if(subject==="diagnostics")return {session:s,queue:this.store.commands(id),events:this.store.events(id,0,500)};
    if(subject==="workspace")return {path:s.workspace,target:this.store.target(s.targetId)};
    if(subject==="skills") {
      try{return await (await this.ensure(id)).inspect(subject);}catch(e:any){if(e.status!==422)throw e;}
      return this.skills(s);
    }
    return (await this.ensure(id)).inspect(subject);
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
    const s=this.session(id);if(s.activeTurnId)fail("Stop this session before deleting it",409);
    const adapter=this.adapters.get(id);if(adapter)void adapter.then(a=>a.close()).catch(()=>{});
    this.adapters.delete(id);this.states.delete(id);this.store.delete(id);
  }
  async close() {
    this.stopped=true;
    for(const answer of this.answers.values()){clearTimeout(answer.timer);answer.reject(new Error("Host shutting down"));}this.answers.clear();
    for(const [id,promise] of this.adapters){const s=this.session(id);if(s.activeTurnId){s.state="uncertain";s.queuePaused=true;this.store.save(s);}try{(await promise).close();}catch{}}
    this.events.removeAllListeners();
    // Allow process rejection handlers to finish before closing the journal.
    await new Promise<void>(resolve=>setImmediate(resolve));this.store.close();
  }
}
