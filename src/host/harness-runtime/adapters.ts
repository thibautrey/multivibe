import { acpEffort, effortOptions, validateEffort, type HarnessEffort } from "./effort.js";
import { LibreChatNativeAdapter } from "./librechat-native.js";
import { OpenWebUIAdapter } from "./openwebui.js";
import { LibreChatAdapter } from "./librechat.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClientServices } from "./client-services.js";
import { JsonPeer, startProcess, harnessEnvironment } from "./process.js";
import { fail, HarnessRuntimeError, redact, supported, unsupported, type AdapterContext, type HarnessAdapter, type MessagePart } from "./types.js";

abstract class Adapter implements HarnessAdapter {
  protected peer?: JsonPeer;
  protected ended?: {resolve:()=>void;reject:(error:Error)=>void};
  protected services: ClientServices;
  protected failure?: Error;
  protected settled?:Promise<void>;
  constructor(protected ctx:AdapterContext) {this.services=new ClientServices(ctx);}
  protected connect(args:string[],rpc=true,env:NodeJS.ProcessEnv={}) {
    this.peer=new JsonPeer(startProcess(this.ctx,args,env),v=>this.event(v),(m,p)=>this.services.request(m,p),e=>{this.failure=e;this.rejectTurn(e);},text=>this.ctx.emit({type:"diagnostic",payload:{message:text}}),rpc);
    return this.peer;
  }
  protected finish(payload:unknown={}) {this.ctx.emit({type:"turn.status",payload});const end=this.ended;this.ended=undefined;end?.resolve();}
  protected rejectTurn(error:Error){const end=this.ended;this.ended=undefined;end?.reject(error);}
  protected wait() {if(this.failure)throw this.failure;if(this.ended)fail("A turn is already active",409);return new Promise<void>((resolve,reject)=>{this.ended={resolve,reject};});}
  protected async untilEnd(send:()=>Promise<unknown>) {
    const done=this.wait();this.settled=done;
    // Register both rejection handlers before submitting: a harness may fail synchronously.
    try{const accepted=send();await Promise.all([accepted,done]);}finally{this.settled=undefined;}
  }
  protected text(parts:MessagePart[]) {
    return parts.map(p=>{
      if(p.type==="text")return p.text;
      if(p.type==="resource")return p.text?`[${p.uri}]\n${p.text}`:p.uri;
      if(p.type==="attachment") {const a=this.ctx.attachment(p.attachmentId);if(!/^(text\/|application\/(json|xml|javascript))/u.test(a.info.mimeType))fail(`This harness cannot accept ${a.info.mimeType}`,422);return `[${a.info.name}]\n${a.data.toString("utf8")}`;}
      return JSON.stringify(p.value);
    }).join("\n\n");
  }
  abstract start():Promise<void>;
  protected abstract event(v:any):void;
  abstract prompt(parts:MessagePart[],steer?:boolean):Promise<void>;
  abstract interrupt():Promise<void>;
  async compact(_instructions?:string):Promise<unknown>{return fail("Native compaction is not exposed by this harness/version",422);}
  async inspect(_subject:string):Promise<unknown>{if(_subject==="effort")return null;return fail("This inspection is not exposed by the harness",422);}
  async configure(_values:Record<string,unknown>):Promise<unknown>{return fail("Runtime configuration is not exposed by the harness",422);}
  async native(_method:string,_params:Record<string,unknown>):Promise<unknown>{return fail("This native operation is not exposed by the adapter",422);}
  close(){this.services.close();this.peer?.close();}
}

/** Shared ACP v1 client; omitted capabilities remain unavailable. */
export class AcpAdapter extends Adapter {
  private sessionInfo:any; private commands:any[]=[]; private agentCapabilities:any={};private defaultEffort?:string;
  private loading=false;private historyRole="";private historyIndex=0;
  private activePrompt?:Promise<any>;
  constructor(ctx:AdapterContext,private args:string[]) {super(ctx);}
  async start() {
    const requestedModel=this.ctx.session.model;
    const connection=this.ctx.modelConnection;
    let environment:NodeJS.ProcessEnv={};
    if(this.ctx.session.harnessId==="hermes-agent" && connection){
      const home=path.join(this.ctx.root,"hermes-home");fs.mkdirSync(home,{recursive:true,mode:0o700});
      const nativeHome=process.env.HERMES_HOME??path.join(os.homedir(),".hermes");
      // Hermes loads its .env with override=True. Shell variables alone cannot
      // override the user's native endpoint. Keep native policies/resources, but
      // give this supervised session its own credentials and session database.
      for(const name of ["skills","memories","SOUL.md","AGENTS.md","hooks","plugins","tools","installs"]){
        const source=path.join(nativeHome,name),destination=path.join(home,name);
        if(fs.existsSync(source) && !fs.existsSync(destination))fs.symlinkSync(source,destination);
      }
      environment={HERMES_HOME:home,LLM_PROVIDER:"openai",LLM_MODEL:this.ctx.session.model,CUSTOM_BASE_URL:connection.baseUrl.replace(/\/$/u,"")+"/v1",OPENAI_BASE_URL:connection.baseUrl.replace(/\/$/u,"")+"/v1",OPENAI_API_KEY:connection.apiKey};
      fs.writeFileSync(path.join(home,"config.yaml"),JSON.stringify({model:{provider:"custom",default:this.ctx.session.model,base_url:environment.CUSTOM_BASE_URL,api_mode:"chat_completions"}},null,2)+"\n",{mode:0o600});
      fs.writeFileSync(path.join(home,".env"),Object.entries(environment).filter(([key,value])=>key!=="HERMES_HOME" && value!==undefined).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join("\n")+"\n",{mode:0o600});
    }
    const peer=this.connect(this.args,true,environment);
    const hello=await peer.request("initialize",{protocolVersion:1,clientInfo:{name:"multivibe",version:"1"},clientCapabilities:{
      ...(this.ctx.target.kind!=="container" && !this.ctx.modelDiscovery?{fs:{readTextFile:true,writeTextFile:true},terminal:true}:{}),
      session:{compaction:{},notices:{}},
    }});
    if(hello.protocolVersion!==1)fail("The harness negotiated an unsupported ACP version",409);
    this.ctx.emit({type:"harness.metadata",payload:{name:hello.agentInfo?.name,version:hello.agentInfo?.version,protocolVersion:String(hello.protocolVersion)}});
    const caps=this.agentCapabilities=hello.agentCapabilities??{};
    this.ctx.capabilities({sessions:supported(),streaming:supported(),interrupt:supported(),tools:supported(),interactions:supported(),
      images:caps.promptCapabilities?.image?supported():unsupported("Image input is not advertised"),
      audio:caps.promptCapabilities?.audio?supported():unsupported("Audio input is not advertised"),
      context:caps.promptCapabilities?.embeddedContext?supported():unsupported("Embedded context is not advertised"),
      mcp:caps.mcpCapabilities?supported():unsupported("MCP transport is not advertised"),
      history:caps.loadSession?supported():unsupported("Loading existing sessions is not advertised"),
      fork:caps.sessionCapabilities?.fork?supported():unsupported("Fork is not advertised"),
    });
    let old=this.ctx.session.nativeSessionId;
    if(old && this.ctx.session.configuration?.forkNativeSession){
      if(!caps.sessionCapabilities?.fork)fail("The ACP harness does not advertise an isolated fork",422);
      const fork=await peer.request("session/fork",{sessionId:old,cwd:this.ctx.session.workspace});old=fork.sessionId;
      this.ctx.nativeSession(old!);delete this.ctx.session.configuration.forkNativeSession;
    }
    if(old && !caps.loadSession)fail("This harness cannot resume its existing session",409);
    this.loading=true;
    const desktop=this.ctx.desktop;
    const mcpServers=desktop?[{name:"multivibe_desktop",command:desktop.command,args:desktop.args,env:Object.entries(desktop.env).map(([name,value])=>({name,value}))}]:[];
    try{this.sessionInfo=await peer.request(old?"session/load":"session/new",{...(old?{sessionId:old}:{}),cwd:this.ctx.session.workspace,mcpServers});}finally{this.loading=false;}
    if(desktop)this.ctx.capabilities({browser:supported("multivibe"),computer:supported("multivibe")});
    this.ctx.nativeSession(old??this.sessionInfo.sessionId);
    const nativeModel=this.sessionInfo.models?.currentModelId??this.sessionInfo.configOptions?.find((v:any)=>v.category==="model")?.currentValue;if(this.ctx.session.authMode==="native" && !this.ctx.session.model && typeof nativeModel==="string")this.ctx.session.model=nativeModel;
    this.defaultEffort=acpEffort(this.sessionInfo)?.effort.currentValue;
    if(this.sessionInfo.modes)this.ctx.capabilities({modes:supported()});
    if(this.sessionInfo.models)this.ctx.capabilities({models:supported()});
    if(this.sessionInfo.configOptions)this.ctx.capabilities({settings:supported()});
    if(requestedModel) {
      const options=this.sessionInfo.configOptions??[];
      const modelOption=options.find((o:any)=>o.category==="model" || o.id==="model");
      if(modelOption)await this.setOption(modelOption.id,this.modelChoice(requestedModel));
      else if(this.sessionInfo.models)await peer.request("session/set_model",{sessionId:this.id,modelId:this.modelChoice(requestedModel)});
      else fail("The ACP harness does not expose model selection; use its native model configuration",422);
    }
  }
  private async setOption(configId:string,value:string){
    const result=await this.peer!.request("session/set_config_option",{sessionId:this.id,configId,value});
    if(result.configOptions)this.sessionInfo={...this.sessionInfo,configOptions:result.configOptions};
    this.ctx.emit({type:"configuration",payload:{configOptions:this.sessionInfo.configOptions}});
    return result;
  }
  private get id(){return this.ctx.session.nativeSessionId!;}
  private modelChoice(model:string){return this.ctx.session.harnessId==="hermes-agent" && this.ctx.modelConnection?`custom:${model}`:model;}
  protected event(v:any) {
    const p=v.params??{};if(p.sessionId && this.id && p.sessionId!==this.id)return;
    const u=p.update??p;const kind=u.sessionUpdate;
    if(kind==="agent_message_chunk") {
      if(u.content?.type==="text") {
        if(this.loading){if(this.historyRole!=="assistant"){this.historyRole="assistant";this.historyIndex++;}this.ctx.emit({type:"history.message",itemId:u.messageId??`acp-history-${this.historyIndex}`,payload:{text:u.content.text,role:"assistant",append:true}});}
        else this.ctx.emit({type:"message.delta",itemId:u.messageId,payload:{text:u.content.text,role:"assistant"}});
      }
      else this.ctx.emit({type:"artifact",payload:u.content});
    } else if(kind==="agent_thought_chunk")this.ctx.emit({type:"reasoning",payload:u.content});
    else if(kind==="user_message_chunk") {if(this.historyRole!=="user"){this.historyRole="user";this.historyIndex++;}this.ctx.emit({type:"history.message",itemId:u.messageId??`acp-history-${this.historyIndex}`,payload:{role:"user",text:u.content?.text??"",append:true}});}
    else if(kind==="tool_call" || kind==="tool_call_update")this.ctx.emit({type:"tool",itemId:u.toolCallId,payload:u});
    else if(kind==="plan"){this.ctx.capabilities({plans:supported()});this.ctx.emit({type:"plan",payload:u});}
    else if(kind?.startsWith("compaction")){this.ctx.capabilities({compaction:supported()});this.ctx.emit({type:"compaction",payload:u});}
    else if(kind==="usage_update"){this.ctx.capabilities({usage:supported()});this.ctx.emit({type:"usage",payload:u});}
    else if(kind==="available_commands_update") {
      this.commands=u.availableCommands??[];this.ctx.capabilities({commands:supported(),...(this.commands.some(c=>c.name==="compact")?{compaction:supported()}:{} )});
      this.ctx.emit({type:"commands",payload:this.commands});
    } else if(kind==="config_option_update") {this.sessionInfo={...this.sessionInfo,configOptions:u.configOptions};this.ctx.capabilities({settings:supported()});this.ctx.emit({type:"configuration",payload:u});}
    else this.ctx.emit({type:"native.event",payload:v});
  }
  private blocks(parts:MessagePart[]):any[] {
    return parts.map(p=>{
      if(p.type==="text")return {type:"text",text:p.text};
      if(p.type==="resource")return p.text!==undefined?{type:"resource",resource:{uri:p.uri,mimeType:p.mimeType??"text/plain",text:p.text}}:{type:"resource_link",uri:p.uri,name:p.uri};
      if(p.type==="attachment") {
        const a=this.ctx.attachment(p.attachmentId);const mime=a.info.mimeType;
        if(mime.startsWith("image/")){if(!this.agentCapabilities.promptCapabilities?.image)fail("The harness did not advertise image input",422);return {type:"image",mimeType:mime,data:a.data.toString("base64")};}
        if(mime.startsWith("audio/")){if(!this.agentCapabilities.promptCapabilities?.audio)fail("The harness did not advertise audio input",422);return {type:"audio",mimeType:mime,data:a.data.toString("base64")};}
        if(!this.agentCapabilities.promptCapabilities?.embeddedContext){
          // Text is a core ACP input even when embedded resources are not supported.
          // Hermes advertises images but no embeddedContext, so retain text attachments
          // as labelled prompt content instead of rejecting an otherwise valid turn.
          if(mime.startsWith("text/") || ["application/json","application/xml","application/javascript"].includes(mime))return {type:"text",text:`[${a.info.name}]\n${a.data.toString("utf8")}`};
          fail("The harness did not advertise embedded resources",422);
        }
        return {type:"resource",resource:{uri:`attachment:${a.info.id}`,mimeType:mime,...(mime.startsWith("text/") || mime==="application/json"?{text:a.data.toString("utf8")}:{blob:a.data.toString("base64")})}};
      }
      fail("Unsupported ACP content",422);
    });
  }
  async prompt(parts:MessagePart[],steer=false) {
    if(steer)fail("ACP v1 does not advertise in-flight steering",422);
    const request=this.peer!.request("session/prompt",{sessionId:this.id,prompt:this.blocks(parts)},0);this.activePrompt=request;
    let result:any;try{result=await request;}finally{this.activePrompt=undefined;}
    this.ctx.emit({type:"turn.status",payload:{stopReason:result.stopReason}});
    if(result.stopReason==="refusal")fail("The harness refused the request",422);
  }
  async interrupt(){const pending=this.activePrompt;this.peer!.notify("session/cancel",{sessionId:this.id});await pending;}
  async compact(instructions?:string) {
    if(!this.commands.some(c=>c.name==="compact"))return super.compact(instructions);
    this.ctx.emit({type:"compaction",payload:{state:"started",reason:"manual"}});
    await this.prompt([{type:"text",text:`/compact${instructions?" "+instructions:""}`}]);
    this.ctx.emit({type:"compaction",payload:{state:"completed"}});return {};
  }
  async inspect(subject:string) {
    if(subject==="effort"){
      const setting=acpEffort(this.sessionInfo);return setting?{...setting.effort,...(this.defaultEffort?{defaultValue:this.defaultEffort}:{})}:null;
    }
    if(subject==="commands")return this.commands;
    if(subject==="settings" || subject==="models" || subject==="modes")return this.sessionInfo;
    if(subject==="history" && this.agentCapabilities.sessionCapabilities?.list)return this.peer!.request("session/list",{cwd:this.ctx.session.workspace});
    return super.inspect(subject);
  }
  async configure(v:Record<string,unknown>) {
    if(v.effort!==undefined){
      const setting=acpEffort(this.sessionInfo);const value=validateEffort(setting?.effort??null,v.effort===null?this.defaultEffort:v.effort);
      return this.setOption(setting!.id,value);
    }
    if(typeof v.mode==="string")return this.peer!.request("session/set_mode",{sessionId:this.id,modeId:v.mode});
    if(typeof v.configId==="string" && typeof v.value==="string")return this.setOption(v.configId,v.value);
    if(typeof v.model==="string") {
      const option=this.sessionInfo.configOptions?.find((o:any)=>o.category==="model" || o.id==="model");
      const result=option?await this.setOption(option.id,this.modelChoice(v.model)):this.sessionInfo.models?await this.peer!.request("session/set_model",{sessionId:this.id,modelId:this.modelChoice(v.model)}):fail("Model selection is not exposed by this harness",422);
      this.ctx.session.model=v.model;return result;
    }
    return super.configure(v);
  }
  async native(method:string,params:Record<string,unknown>) {
    if(method==="session/fork" && this.agentCapabilities.sessionCapabilities?.fork)return this.peer!.request(method,{...params,sessionId:this.id});
    if(method==="authenticate" && typeof params.methodId==="string")return this.peer!.request(method,{methodId:params.methodId});
    return super.native(method,params);
  }
}

export class PiAdapter extends Adapter {
  restartAfterInterrupt=false;private defaultEffort?:string;
  private images(parts:MessagePart[]) {return parts.filter(p=>p.type==="attachment" && this.ctx.attachment(p.attachmentId).info.mimeType.startsWith("image/")).map(p=>{const a=this.ctx.attachment((p as any).attachmentId);return {type:"image",data:a.data.toString("base64"),mimeType:a.info.mimeType};});}
  async start() {
    const sessionFile=this.ctx.target.kind==="container"?path.posix.join(this.ctx.session.workspace,`.multivibe-${this.ctx.session.id}.jsonl`):path.join(this.ctx.root,`pi-${this.ctx.session.id}.jsonl`);
    let nativeSession=this.ctx.session.nativeSessionId;
    if(nativeSession && this.ctx.session.configuration?.forkNativeSession){
      if(this.ctx.target.kind!=="local")fail("Fork a Pi session through the Host that owns its file",422);
      if(fs.statSync(nativeSession).size>64*1024*1024)fail("Native session exceeds its fork limit",413);
      fs.copyFileSync(nativeSession,sessionFile,fs.constants.COPYFILE_EXCL);fs.chmodSync(sessionFile,0o600);nativeSession=sessionFile;
      this.ctx.nativeSession(sessionFile);delete this.ctx.session.configuration.forkNativeSession;
    }
    const args=["--mode","rpc","--session",nativeSession??sessionFile];
    if(this.ctx.session.authMode==="multivibe")args.push("--provider","multivibe");
    else if(typeof this.ctx.session.configuration?.nativeProvider==="string")args.push("--provider",this.ctx.session.configuration.nativeProvider);
    if(this.ctx.session.model)args.push("--model",this.ctx.session.model);
    if(this.ctx.desktop)args.push("--extension",fileURLToPath(new URL(import.meta.url.endsWith(".ts")?"./desktop-pi.ts":"./desktop-pi.js",import.meta.url)));
    const peer=this.connect(args,false,this.ctx.desktop?.env);const state=await peer.request("get_state");
    if(this.ctx.desktop)this.ctx.capabilities({browser:supported("multivibe"),computer:supported("multivibe")});
    if(typeof state?.thinkingLevel==="string")this.defaultEffort=state.thinkingLevel;
    if(this.ctx.session.authMode==="native" && typeof state?.model?.id==="string")this.ctx.session.model=state.model.id;
    if(this.ctx.session.authMode==="native" && typeof state?.model?.provider==="string")this.ctx.session.configuration={...this.ctx.session.configuration,nativeProvider:state.model.provider};
    this.ctx.nativeSession(state?.sessionFile??this.ctx.session.nativeSessionId??sessionFile);
    if(this.ctx.session.configuration?.sourceId && !this.ctx.session.configuration?.historyImported){const history=await peer.request("get_messages");for(const [index,message] of (history?.messages??[]).entries()){if(["user","assistant"].includes(message.role)){const text=typeof message.content==="string"?message.content:(message.content??[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n");this.ctx.emit({type:"history.message",itemId:`pi-history-${index}`,payload:{role:message.role,text}});}}this.ctx.session.configuration.historyImported=true;}
    this.ctx.capabilities(Object.fromEntries(["sessions","history","steer","interrupt","streaming","compaction","tools","skills","commands","models","settings","usage","images","fork"].map(k=>[k,supported()])));
    this.ctx.emit({type:"configuration",payload:state});
  }
  protected event(v:any) {
    if(v.type==="message_update") {
      const e=v.assistantMessageEvent;
      if(e?.type==="text_delta")this.ctx.emit({type:"message.delta",payload:{text:e.delta,role:"assistant"}});
      else if(e?.type==="thinking_delta")this.ctx.emit({type:"reasoning",payload:{text:e.delta}});
      else this.ctx.emit({type:"native.event",payload:v});
    } else if(v.type==="message_end" && v.message?.role==="assistant" && ["error","aborted"].includes(v.message.stopReason)){this.ctx.emit({type:"turn.status",payload:{status:v.message.stopReason==="aborted"?"interrupted":"failed",error:v.message.errorMessage}});this.rejectTurn(new HarnessRuntimeError(v.message.errorMessage??"Pi did not complete this turn",v.message.stopReason==="aborted"?499:422));}
    else if(v.type==="agent_settled")this.finish(v);
    else if(v.type==="agent_end") {
      // Older Pi versions have no agent_settled. Query its actual queue/compaction state.
      void this.peer!.request("get_state").then(s=>{if(!s?.isStreaming && !s?.isCompacting && !(s?.pendingMessageCount>0))this.finish(v);}).catch(e=>this.rejectTurn(e));
    } else if(v.type==="tool_execution_start" || v.type==="tool_execution_update" || v.type==="tool_execution_end")this.ctx.emit({type:"tool",itemId:v.toolCallId,payload:v});
    else if(/compaction|retry/u.test(v.type??""))this.ctx.emit({type:v.type.includes("compaction")?"compaction":"retry",payload:v});
    else if(v.type==="extension_ui_request") {
      const dialog=["select","confirm","input","editor"].includes(v.method);
      if(dialog)void this.ctx.ask("question",v.title??v.message??"Pi",v).then(a=>this.peer!.notify("extension_ui_response",{id:v.id,...a})).catch(()=>{});
      else this.ctx.emit({type:"notice",payload:v});
    } else this.ctx.emit({type:"native.event",payload:v});
  }
  async prompt(parts:MessagePart[],steer=false) {
    const textParts=parts.filter(p=>p.type!=="attachment" || !this.ctx.attachment(p.attachmentId).info.mimeType.startsWith("image/"));
    const params={message:textParts.length?this.text(textParts):"Analyse les pièces jointes.",images:this.images(parts)};
    if(steer){await this.peer!.request("steer",params);return;}
    await this.untilEnd(()=>this.peer!.request("prompt",params,0));
  }
  async interrupt(){
    const done=this.settled;this.restartAfterInterrupt=true;
    // Older RPC versions do not reply with an ID to unknown queue commands.
    // Abort first; rebuilding this connection discards pending native steering.
    await this.peer!.request("abort",{},10_000);
    this.ctx.emit({type:"turn.status",payload:{status:"interrupted"}});
    this.rejectTurn(new HarnessRuntimeError("Pi turn interrupted",499));
    try{await done;}catch(e:any){if(e.status!==499)throw e;}
  }
  async compact(instructions?:string){return this.peer!.request("compact",instructions?{customInstructions:instructions}:{},0);}
  async inspect(subject:string) {
    if(subject==="effort"){
      const state=await this.peer!.request("get_state");
      if(Array.isArray(state?.availableThinkingLevels))return effortOptions(state.availableThinkingLevels,state.thinkingLevel,this.defaultEffort);
      // Older Pi RPC versions answer unknown commands without a request id.
      // Bound the optional probe so those versions do not stall discovery.
      try {
        const levels=await this.peer!.request("get_available_thinking_levels",{},2000);
        return effortOptions(levels?.levels,state?.thinkingLevel,this.defaultEffort);
      } catch(error) {
        if(error instanceof HarnessRuntimeError && error.status===422 || error instanceof Error && /get_available_thinking_levels timed out/iu.test(error.message))return null;
        throw error;
      }
    }
    const methods:Record<string,string>={settings:"get_state",history:"get_messages",models:"get_available_models",commands:"get_commands",usage:"get_session_stats",checkpoints:"get_fork_messages"};
    return methods[subject]?this.peer!.request(methods[subject]):super.inspect(subject);
  }
  async configure(v:Record<string,unknown>) {
    if(typeof v.model==="string" && typeof v.provider==="string"){const result=await this.peer!.request("set_model",{provider:v.provider,modelId:v.model});this.ctx.session.model=v.model;this.ctx.session.configuration={...this.ctx.session.configuration,nativeProvider:v.provider};return result;}
    if(v.effort!==undefined || v.thinkingLevel!==undefined){
      const level=validateEffort(await this.inspect("effort") as HarnessEffort|null,v.effort===null?this.defaultEffort:v.effort??v.thinkingLevel);
      return this.peer!.request("set_thinking_level",{level});
    }
    if(typeof v.autoCompaction==="boolean")return this.peer!.request("set_auto_compaction",{enabled:v.autoCompaction});
    return super.configure(v);
  }
  async native(method:string,params:Record<string,unknown>) {
    if(["get_available_thinking_levels","get_fork_messages","set_session_name","get_tree"].includes(method))return this.peer!.request(method,params);
    return super.native(method,params);
  }
}

export class CodexAdapter extends Adapter {
  private threadId="";private turnId="";private currentModel="";private defaultEffort?:string;
  private compactionDone?:{resolve:(v:unknown)=>void;reject:(e:Error)=>void};
  async start() {
    const args=["app-server"];
    if(this.ctx.desktop){
      const d=this.ctx.desktop;
      // Per-process overrides preserve all user-configured MCP servers.
      args.push("-c",`mcp_servers.multivibe_desktop.command=${JSON.stringify(d.command)}`,"-c",`mcp_servers.multivibe_desktop.args=${JSON.stringify(d.args)}`,"-c",`mcp_servers.multivibe_desktop.env={${Object.entries(d.env).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join(",")}}`);
    }
    const child=startProcess(this.ctx,args);
    this.peer=new JsonPeer(child,v=>this.event(v),(m,p)=>this.request(m,p),e=>{this.failure=e;this.rejectTurn(e);},text=>this.ctx.emit({type:"diagnostic",payload:{message:text}}));
    await this.peer.request("initialize",{clientInfo:{name:"multivibe",version:"1"},capabilities:{experimentalApi:true}});
    this.peer.notify("initialized");
    if(this.ctx.desktop)this.ctx.capabilities({browser:supported("multivibe"),computer:supported("multivibe")});
    const s=this.ctx.session;
    if(this.ctx.modelDiscovery)return;
    if(s.nativeSessionId && s.configuration?.forkNativeSession){const fork=await this.peer.request("thread/fork",{threadId:s.nativeSessionId,cwd:s.workspace});this.ctx.nativeSession(fork.thread.id);delete s.configuration.forkNativeSession;}
    const result=await this.peer.request(s.nativeSessionId?"thread/resume":"thread/start",{
      ...(s.nativeSessionId?{threadId:s.nativeSessionId}:{}),cwd:s.workspace,...(s.model?{model:s.model}:{}),...(s.authMode==="multivibe"?{modelProvider:"multivibe"}:{}),
    });
    this.threadId=result.thread.id;this.defaultEffort=result.reasoningEffort;this.currentModel=result.model??s.model??"";if(this.currentModel)s.model=this.currentModel;this.ctx.nativeSession(this.threadId);
    if(s.configuration?.sourceId && !s.configuration?.historyImported){const history=await this.peer.request("thread/read",{threadId:this.threadId,includeTurns:true});for(const turn of history.thread?.turns??[])for(const item of turn.items??[]){if(item.type==="userMessage" || item.type==="agentMessage"){const text=item.type==="agentMessage"?item.text:(item.content??[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n");this.ctx.emit({type:"history.message",itemId:item.id,payload:{role:item.type==="userMessage"?"user":"assistant",text}});}}s.configuration.historyImported=true;}
    this.ctx.capabilities(Object.fromEntries(["sessions","history","fork","steer","interrupt","streaming","compaction","tools","skills","mcp","hooks","models","modes","plans","settings","usage","agents","images","interactions","workspace","git","terminals"].map(k=>[k,supported()])));
  }
  private async request(method:string,p:any):Promise<unknown> {
    if(p.threadId && p.threadId!==this.threadId)fail("Approval targets another thread",403);
    if(method==="item/commandExecution/requestApproval" || method==="item/fileChange/requestApproval") {
      const a=await this.ctx.ask("permission",p.reason??p.command??"Autoriser cette action Codex ?",{...p,options:[{optionId:"accept",name:"Autoriser une fois",kind:"allow_once"},{optionId:"decline",name:"Refuser",kind:"reject_once"}]});
      return {decision:a.optionId==="accept"?"accept":"decline"};
    }
    if(method==="item/tool/requestUserInput") {const a=await this.ctx.ask("question","Codex attend une réponse",p);return {answers:a.answers??{}};}
    if(method==="mcpServer/elicitation/request") {const a=await this.ctx.ask(p.mode==="url"?"authentication":"question",p.message??"Un connecteur attend une réponse",{...p,_kind:"mcp_elicitation"});return {action:a.action??"cancel",...(a.content?{content:a.content}:{})};}
    if(method==="item/permissions/requestApproval") {
      const a=await this.ctx.ask("permission","Autoriser les permissions demandées",{...p,options:[{optionId:"accept",name:"Autoriser une fois",kind:"allow_once"},{optionId:"decline",name:"Refuser",kind:"reject_once"}]});
      return {permissions:a.optionId==="accept"?p.permissions:{},scope:"turn"};
    }
    fail(`Unsupported Codex client request: ${method}`,422);
  }
  protected event(v:any) {
    const p=v.params??{};if(p.threadId && this.threadId && p.threadId!==this.threadId)return;
    if(v.method==="item/agentMessage/delta")this.ctx.emit({type:"message.delta",itemId:p.itemId,payload:{text:p.delta,role:"assistant"}});
    else if(v.method==="turn/started")this.turnId=p.turn.id;
    else if(v.method==="turn/completed") {
      if(p.turn.status==="failed"){this.ctx.emit({type:"turn.status",payload:{status:"failed",error:p.turn.error?.message}});this.rejectTurn(new HarnessRuntimeError(p.turn.error?.message??"Codex turn failed",422));}
      else this.finish({status:p.turn.status});
    } else if(v.method==="item/started" || v.method==="item/completed") {
      const item=p.item??{};
      if(item.type==="agentMessage" && v.method==="item/completed")this.ctx.emit({type:"message.part",itemId:item.id,payload:{text:item.text??"",role:"assistant",phase:item.phase}});
      else if(["commandExecution","fileChange","mcpToolCall","dynamicToolCall","webSearch","imageView","collabAgentToolCall","collabToolCall"].includes(item.type))this.ctx.emit({type:["collabAgentToolCall","collabToolCall"].includes(item.type)?"agent":"tool",itemId:item.id,payload:{phase:v.method,item}});
      else if(item.type==="contextCompaction"){this.ctx.emit({type:"compaction",payload:{phase:v.method,item}});if(v.method==="item/completed"){this.compactionDone?.resolve(item);this.compactionDone=undefined;}}
      else if(item.type==="plan")this.ctx.emit({type:"plan",payload:item});
      else this.ctx.emit({type:"native.event",payload:v});
    } else if(v.method==="thread/compacted"){this.ctx.emit({type:"compaction",payload:p});this.compactionDone?.resolve(p);this.compactionDone=undefined;}
    else if(v.method?.includes("tokenUsage"))this.ctx.emit({type:"usage",payload:p});
    else if(v.method?.includes("reasoning"))this.ctx.emit({type:"reasoning",payload:p});
    else if(v.method?.includes("outputDelta"))this.ctx.emit({type:"terminal.output",itemId:p.itemId,payload:p});
    else this.ctx.emit({type:"native.event",payload:v});
  }
  private input(parts:MessagePart[]) {
    return parts.map(p=>{
      if(p.type==="attachment") {const a=this.ctx.attachment(p.attachmentId);if(a.info.mimeType.startsWith("image/"))return {type:"image",url:`data:${a.info.mimeType};base64,${a.data.toString("base64")}`};}
      return {type:"text",text:this.text([p]),text_elements:[]};
    });
  }
  async prompt(parts:MessagePart[],steer=false) {
    if(steer){await this.peer!.request("turn/steer",{threadId:this.threadId,expectedTurnId:this.turnId,input:this.input(parts)});return;}
    const config=this.ctx.session.configuration??{};
    await this.untilEnd(async()=>{const r=await this.peer!.request("turn/start",{threadId:this.threadId,input:this.input(parts),...(typeof config.model==="string"?{model:config.model}:{}),...(typeof config.effort==="string"?{effort:config.effort}:{}),...(typeof config.mode==="string"?{collaborationMode:{mode:config.mode,settings:{model:this.ctx.session.model??this.currentModel,reasoning_effort:config.effort??null,developer_instructions:null}}}:{})});this.turnId=r.turn.id;});
  }
  async interrupt(){const done=this.settled;if(this.turnId)await this.peer!.request("turn/interrupt",{threadId:this.threadId,turnId:this.turnId});await done;}
  async compact(instructions?:string){
    if(instructions)fail("This Codex protocol does not expose custom compaction instructions",422);
    const completion=new Promise<unknown>((resolve,reject)=>{this.compactionDone={resolve,reject};});
    try{const [,result]=await Promise.all([this.peer!.request("thread/compact/start",{threadId:this.threadId}),completion]);return result;}
    finally{this.compactionDone=undefined;}
  }
  async inspect(subject:string) {
    if(subject==="effort"){
      const {data}=await this.inspect("models") as any;
      const model=data.find((m:any)=>(m.model??m.id)===(this.ctx.session.model??this.currentModel))??(!this.ctx.session.model?data.find((m:any)=>m.isDefault):undefined);
      return effortOptions(model?.supportedReasoningEfforts,this.ctx.session.configuration?.effort??this.defaultEffort??model?.defaultReasoningEffort,model?.defaultReasoningEffort);
    }
    const calls:Record<string,[string,Record<string,unknown>]>={
      models:["model/list",{}],skills:["skills/list",{cwds:[this.ctx.session.workspace]}],hooks:["hooks/list",{cwds:[this.ctx.session.workspace]}],
      mcp:["mcpServerStatus/list",this.threadId?{threadId:this.threadId}:{}],tools:["mcpServerStatus/list",this.threadId?{threadId:this.threadId}:{}],settings:["config/read",{}],
      plugins:["plugin/list",{cwds:[this.ctx.session.workspace],forceRefetch:false}],agents:["config/read",{}],
      modes:["collaborationMode/list",{}],history:["thread/read",{threadId:this.threadId,includeTurns:true}],terminals:["thread/backgroundTerminals/list",{threadId:this.threadId}],
    };
    if(subject==="models") {
      const data:any[]=[];let cursor:string|undefined;
      for(let page=0;page<100;page++){const result=await this.peer!.request("model/list",{limit:100,...(cursor?{cursor}:{})});data.push(...(result.data??[]));if(!result.nextCursor || result.nextCursor===cursor)break;cursor=result.nextCursor;}
      return {data};
    }
    const call=calls[subject];return call?this.peer!.request(call[0],call[1]):super.inspect(subject);
  }
  async configure(v:Record<string,unknown>) {
    // turn/start accepts these settings; no global config is rewritten.
    if(Object.keys(v).some(k=>!["model","effort","mode"].includes(k)))return super.configure(v);
    if(v.effort!==undefined){
      const effort=await this.inspect("effort") as HarnessEffort|null;
      if(v.effort===null){validateEffort(effort,effort?.defaultValue);if(this.ctx.session.configuration)delete this.ctx.session.configuration.effort;}
      else validateEffort(effort,v.effort);
    }
    if(typeof v.model==="string" && v.model!==this.ctx.session.model && this.ctx.session.configuration)delete this.ctx.session.configuration.effort;
    if(v.mode!==undefined && !["plan","default"].includes(String(v.mode)))fail("Unsupported Codex collaboration mode",422);
    this.ctx.session.configuration={...this.ctx.session.configuration,...v};if(typeof v.model==="string")this.ctx.session.model=v.model;
    return {effectiveFrom:"next_turn",...v};
  }
  async native(method:string,params:Record<string,unknown>) {
    if(method==="mcpServer/oauth/login"){const flow=await this.peer!.request(method,{...params,threadId:this.threadId});await this.ctx.ask("authentication","Connexion du serveur MCP",{...flow,mode:"url"});return {authentication:"requested"};}
    if(["thread/fork","thread/goal/get","thread/goal/set","thread/goal/clear","skills/config/write","config/mcpServer/reload","mcpServer/oauth/login","thread/backgroundTerminals/terminate"].includes(method))return this.peer!.request(method,{...params,threadId:this.threadId});
    return super.native(method,params);
  }
  close(){this.compactionDone?.reject(new Error("Codex compaction connection closed"));this.compactionDone=undefined;super.close();}
}

class InputQueue {
  private values:any[]=[];private resolver?:()=>void;private stopped=false;
  push(v:any){this.values.push(v);this.resolver?.();this.resolver=undefined;}
  close(){this.stopped=true;this.resolver?.();}
  async *stream(){while(!this.stopped){if(!this.values.length)await new Promise<void>(r=>{this.resolver=r;});while(this.values.length)yield this.values.shift();}}
}
export class ClaudeAdapter extends Adapter {
  private query:any;private queue=new InputQueue();private abort=new AbortController();
  private stderrBytes=0;private currentEffort?:string;private defaultEffort?:string;
  private settingsFile?:string;
  private currentMessageId="claude-assistant";private sawText=false;
  constructor(ctx:AdapterContext,private sdkLoader?:()=>Promise<any>){super(ctx);}
  async start() {
    if(this.ctx.target.kind==="container")fail("Claude SDK requires a Host inside the container",422);
    if(this.ctx.desktop)this.ctx.capabilities({browser:supported("multivibe"),computer:supported("multivibe")});
    const moduleName="@anthropic-ai/claude-agent-sdk";const sdk:any=this.sdkLoader?await this.sdkLoader():await import(moduleName);
    const s=this.ctx.session;
    if(this.ctx.modelConnection){
      this.settingsFile=path.join(this.ctx.root,`claude-session-settings-${randomBytes(12).toString("hex")}.json`);
      const connection=this.ctx.modelConnection;
      fs.writeFileSync(this.settingsFile,JSON.stringify({...(s.model?{model:s.model}:{}),env:{ANTHROPIC_BASE_URL:connection.baseUrl,ANTHROPIC_AUTH_TOKEN:connection.apiKey,ANTHROPIC_API_KEY:connection.apiKey,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",...(s.model?{ANTHROPIC_SMALL_FAST_MODEL:s.model,ANTHROPIC_DEFAULT_HAIKU_MODEL:s.model,ANTHROPIC_DEFAULT_SONNET_MODEL:s.model,ANTHROPIC_DEFAULT_OPUS_MODEL:s.model}:{})}}),{mode:0o600,flag:"wx"});
    }
    if(s.configuration?.sourceId && !s.configuration?.historyImported && typeof sdk.getSessionMessages==="function"){const history=await sdk.getSessionMessages(s.nativeSessionId,{dir:s.workspace});for(const [index,message] of history.entries()){if(["user","assistant"].includes(message.type)){const text=(message.message?.content??[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n");this.ctx.emit({type:"history.message",itemId:message.uuid??`claude-history-${index}`,payload:{role:message.type,text}});}}s.configuration.historyImported=true;}
    this.query=sdk.query({prompt:this.queue.stream(),options:{
      cwd:s.workspace,pathToClaudeCodeExecutable:this.ctx.executable,settingSources:["user","project","local"],
      systemPrompt:{type:"preset",preset:"claude_code"},includePartialMessages:true,permissionMode:"default",abortController:this.abort,
      env:harnessEnvironment(s.authMode==="native"),...(s.nativeSessionId?{resume:s.nativeSessionId}:{}),...(s.configuration?.forkNativeSession?{forkSession:true}:{}),...(s.model?{model:s.model}:{}),enableFileCheckpointing:true,
      ...(this.settingsFile?{settings:this.settingsFile}:{}),
      ...(this.ctx.desktop?{mcpServers:{multivibe_desktop:{type:"stdio",...this.ctx.desktop}},systemPrompt:{type:"preset",preset:"claude_code",append:"MultiVibe Host provides integrated browser and computer tools through multivibe_desktop. Use them for graphical actions; observe before input."}}:{}),
      stderr:(message:string)=>{if(this.stderrBytes<16_384){this.stderrBytes+=message.length;this.ctx.emit({type:"diagnostic",payload:{message:String(redact(message)).slice(0,2048)}});}},
      onElicitation:async(request:any)=>this.ctx.ask(request.mode==="url"?"authentication":"question",request.message??"Un connecteur attend une réponse",{...request,_kind:"mcp_elicitation"}),
      canUseTool:async(name:string,input:any,options:any)=>{
        const question=name==="AskUserQuestion";
        const answer=await this.ctx.ask(question?"question":"permission",question?"Claude attend une réponse":`Autoriser ${name} ?`,{name,input,toolUseId:options?.toolUseID,...(!question?{options:[{optionId:"allow",name:"Autoriser une fois",kind:"allow_once"},{optionId:"deny",name:"Refuser",kind:"reject_once"}]}:{})});
        return question?{behavior:"allow",updatedInput:{...input,answers:answer.answers??{}}}:answer.optionId==="allow"?{behavior:"allow",updatedInput:input}:{behavior:"deny",message:"Action refusée par l’utilisateur"};
      },
    }});
    void this.consume().catch(e=>{this.failure=e;this.rejectTurn(e);});
    if(typeof this.query.supportedCommands==="function")await this.query.supportedCommands();
    this.ctx.capabilities(Object.fromEntries(["sessions","history","fork","interrupt","streaming","tools","skills","commands","mcp","plugins","hooks","images","models","settings","plans","usage","agents","interactions","checkpoints"].map(k=>[k,supported()])));
  }
  private async consume() {for await(const event of this.query)this.event(event);if(!this.abort.signal.aborted){this.failure=new Error("Claude SDK stream ended before the session closed");this.rejectTurn(this.failure);}}
  protected event(v:any) {
    if(v.parent_tool_use_id && ["assistant","stream_event","user"].includes(v.type)){this.ctx.emit({type:"agent",itemId:v.parent_tool_use_id,payload:v});return;}
    if(v.type==="system" && v.subtype==="init"){
      if(typeof v.model==="string")this.ctx.session.model=v.model;
      if(typeof v.effort==="string"){this.currentEffort=v.effort;this.defaultEffort??=v.effort;}
    }
    if(v.session_id && v.session_id!==this.ctx.session.nativeSessionId)this.ctx.nativeSession(v.session_id);
    if(v.type==="stream_event") {
      const e=v.event;if(e?.type==="message_start")this.currentMessageId=e.message?.id??this.currentMessageId;
      else if(e?.type==="content_block_delta" && e.delta?.type==="text_delta"){this.sawText=true;this.ctx.emit({type:"message.delta",itemId:`${this.currentMessageId}:${e.index??0}`,payload:{text:e.delta.text,role:"assistant"}});}
      else if(e?.delta?.type==="thinking_delta")this.ctx.emit({type:"reasoning",payload:{text:e.delta.thinking}});
      else if(e?.content_block?.type==="tool_use")this.ctx.emit({type:"tool",itemId:e.content_block.id,payload:e.content_block});
    } else if(v.type==="assistant") {
      this.currentMessageId=v.message?.id??this.currentMessageId;
      for(const [index,p] of (v.message?.content??[]).entries()) {
        if(p.type==="tool_use")this.ctx.emit({type:"tool",itemId:p.id,payload:p});
        else if(p.type==="text"){this.sawText=true;this.ctx.emit({type:"message.part",itemId:`${this.currentMessageId}:${index}`,payload:{text:p.text,role:"assistant"}});}
      }
    } else if(v.type==="user") {
      for(const p of v.message?.content??[])if(p.type==="tool_result")this.ctx.emit({type:"tool",itemId:p.tool_use_id,payload:{status:p.is_error?"failed":"completed",...p}});
    } else if(v.type==="result") {
      if(!this.sawText && typeof v.result==="string" && v.result){this.sawText=true;this.ctx.emit({type:"message.part",itemId:"claude-final",payload:{text:v.result,role:"assistant"}});}
      this.ctx.emit({type:"usage",payload:{origin:"harness",usage:v.usage,modelUsage:v.modelUsage,estimatedCostUsd:v.total_cost_usd,durationMs:v.duration_ms}});
      if(v.is_error){this.ctx.emit({type:"turn.status",payload:{status:"failed",error:v.errors?.join("; ")}});this.rejectTurn(new HarnessRuntimeError(v.errors?.join("; ")??"Claude could not complete this turn",422));}else this.finish(v);
    } else if(v.type==="system" && v.subtype==="compact_boundary"){this.ctx.capabilities({compaction:supported()});this.ctx.emit({type:"compaction",payload:v});}
    else if(v.type==="system" && v.subtype==="api_retry")this.ctx.emit({type:"retry",payload:v});
    else if(v.type==="tool_progress")this.ctx.emit({type:"tool",itemId:v.tool_use_id,payload:v});
    else if(v.type==="system" && ["task_started","task_progress","task_notification"].includes(v.subtype))this.ctx.emit({type:"agent",itemId:v.task_id,payload:v});
    else this.ctx.emit({type:"native.event",payload:v});
  }
  async prompt(parts:MessagePart[],steer=false) {
    if(steer)fail("The SDK does not advertise true in-flight steer",422);
    this.sawText=false;
    const content=parts.map(p=>{
      if(p.type==="attachment"){const a=this.ctx.attachment(p.attachmentId);if(a.info.mimeType.startsWith("image/"))return {type:"image",source:{type:"base64",media_type:a.info.mimeType,data:a.data.toString("base64")}};}
      return {type:"text",text:this.text([p])};
    });
    await this.untilEnd(async()=>{this.queue.push({type:"user",session_id:this.ctx.session.nativeSessionId??"",parent_tool_use_id:null,message:{role:"user",content}});});
  }
  async interrupt(){const done=this.settled;await this.query.interrupt();await done;}
  async inspect(subject:string) {
    if(subject==="effort"){
      if(typeof this.query.applyFlagSettings!=="function")return null;
      const models=await this.query.supportedModels();
      const model=models.find((m:any)=>m.value===this.ctx.session.model || m.resolvedModel===this.ctx.session.model);
      return effortOptions(model?.supportedEffortLevels,this.ctx.session.configuration?.effort??this.currentEffort,this.defaultEffort);
    }
    if(subject==="commands")return this.query.supportedCommands();
    if(subject==="models")return this.query.supportedModels();
    if(subject==="mcp" || subject==="tools")return this.query.mcpServerStatus();
    if(subject==="agents" && typeof this.query.supportedAgents==="function")return this.query.supportedAgents();
    if(["settings","plugins","hooks"].includes(subject) && typeof this.query.initializationResult==="function")return this.query.initializationResult();
    return super.inspect(subject);
  }
  async configure(v:Record<string,unknown>) {
    if(v.effort!==undefined){
      const catalog=await this.inspect("effort") as HarnessEffort|null;
      if(v.effort===null){validateEffort(catalog,catalog?.defaultValue);await this.query.applyFlagSettings({effortLevel:null});this.currentEffort=this.defaultEffort;return {effort:this.currentEffort};}
      const effort=validateEffort(catalog,v.effort);
      await this.query.applyFlagSettings({effortLevel:effort});this.currentEffort=effort;return {effort};
    }
    if(typeof v.model==="string"){await this.query.setModel(v.model);
      if(this.ctx.session.configuration?.effort && typeof this.query.applyFlagSettings==="function")await this.query.applyFlagSettings({effortLevel:null});this.ctx.session.model=v.model;return {model:v.model};}
    if(typeof v.permissionMode==="string" && ["default","plan","acceptEdits"].includes(v.permissionMode)){await this.query.setPermissionMode(v.permissionMode);return {permissionMode:v.permissionMode};}
    return super.configure(v);
  }
  async compact(instructions?:string) {
    const commands=await this.query.supportedCommands();if(!commands.some((c:any)=>c.name==="compact"))return super.compact(instructions);
    await this.prompt([{type:"text",text:`/compact${instructions?" "+instructions:""}`}]);return {};
  }
  async native(method:string,params:Record<string,unknown>) {
    if(method==="rewindFiles" && typeof params.userMessageId==="string")return this.query.rewindFiles(params.userMessageId,{dryRun:params.dryRun!==false});
    if(method==="mcp.set" && params.servers && typeof params.servers==="object")return this.query.setMcpServers(params.servers);
    if(method==="mcp.reconnect" && typeof params.name==="string")return this.query.reconnectMcpServer(params.name);
    if(method==="mcp.toggle" && typeof params.name==="string" && typeof params.enabled==="boolean")return this.query.toggleMcpServer(params.name,params.enabled);
    if(method==="skills.reload")return this.query.reloadSkills();
    if(method==="plugins.reload")return this.query.reloadPlugins(params);
    return super.native(method,params);
  }
  close(){this.queue.close();this.abort.abort();this.query?.close();if(this.settingsFile)try{fs.unlinkSync(this.settingsFile);}catch{}super.close();}
}

export class OpenCodeAdapter extends Adapter {
  private child?:ChildProcessWithoutNullStreams;private origin="";private password=randomBytes(24).toString("base64url");private abort=new AbortController();private nativeId="";
  private messageRoles=new Map<string,string>();private pendingParts:any[]=[];private hasActivity=false;
  private headers(){return {authorization:`Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,"content-type":"application/json"};}
  private async call(method:string,route:string,body?:unknown) {
    const response=await fetch(`${this.origin}${route}${route.includes("?")?"&":"?"}directory=${encodeURIComponent(this.ctx.session.workspace)}`,{method,headers:this.headers(),...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)])});
    if(!response.ok)fail(`OpenCode ${method} ${route}: HTTP ${response.status}`,502);
    return response.status===204?{}:response.json();
  }
  async start() {
    if(this.ctx.target.kind==="container")fail("OpenCode HTTP requires a Host inside the container",422);
    const desktop=this.ctx.desktop;
    if(desktop)this.ctx.capabilities({browser:supported("multivibe"),computer:supported("multivibe")});
    const child=this.child=startProcess(this.ctx,["serve","--hostname","127.0.0.1","--port","0"],{OPENCODE_SERVER_PASSWORD:this.password,OPENCODE_SERVER_USERNAME:"opencode",...(desktop?{OPENCODE_CONFIG_CONTENT:JSON.stringify({mcp:{multivibe_desktop:{type:"local",command:[desktop.command,...desktop.args],environment:desktop.env,enabled:true}}})}:{})});
    this.origin=await new Promise<string>((resolve,reject)=>{
      let output="";const timer=setTimeout(()=>reject(new Error("OpenCode server startup timed out")),20_000);
      const consume=(c:Buffer)=>{output=(output+c.toString()).slice(-8000);const match=output.match(/http:\/\/127\.0\.0\.1:(\d+)/u);if(match){clearTimeout(timer);resolve(match[0]);}};
      child.stdout.on("data",consume);child.stderr.on("data",consume);child.once("error",e=>{clearTimeout(timer);reject(e);});child.once("close",()=>{clearTimeout(timer);reject(new Error("OpenCode server exited"));this.rejectTurn(new Error("OpenCode connection closed"));});
    });
    if(this.ctx.modelDiscovery)return;
    const source=this.ctx.session.nativeSessionId;
    const session=source?(this.ctx.session.configuration?.forkNativeSession?await this.call("POST",`/session/${encodeURIComponent(source)}/fork`,{}):await this.call("GET",`/session/${encodeURIComponent(source)}`)):await this.call("POST","/session",{title:this.ctx.session.title});
    if(this.ctx.session.configuration)delete this.ctx.session.configuration.forkNativeSession;
    this.nativeId=session.id;this.ctx.nativeSession(session.id);
    if(this.ctx.session.authMode==="native" && !this.ctx.session.model){try{const config=await this.call("GET","/config");if(typeof config.model==="string")this.ctx.session.model=config.model;}catch{/* The server may select a default only on its first turn. */}}
    if(this.ctx.session.configuration?.sourceId && !this.ctx.session.configuration?.historyImported){const history=await this.call("GET",`/session/${this.nativeId}/message`);for(const message of history){if(["user","assistant"].includes(message.info?.role))this.ctx.emit({type:"history.message",itemId:message.info.id,payload:{role:message.info.role,text:(message.parts??[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n")}});}this.ctx.session.configuration.historyImported=true;}
    await this.subscribe();
    this.ctx.capabilities(Object.fromEntries(["sessions","history","fork","interrupt","streaming","tools","skills","commands","mcp","models","modes","plans","usage","agents","interactions","images","compaction","checkpoints"].map(k=>[k,supported()])));
  }
  private async subscribe() {
    const response=await fetch(`${this.origin}/event?directory=${encodeURIComponent(this.ctx.session.workspace)}`,{headers:this.headers(),signal:this.abort.signal});if(!response.ok || !response.body)fail("OpenCode events unavailable",502);
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer="";
    void(async()=>{for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>4*1024*1024)throw new Error("OpenCode event exceeds limit");for(;;){const n=buffer.indexOf("\n");if(n<0)break;const line=buffer.slice(0,n).trim();buffer=buffer.slice(n+1);if(line.startsWith("data:")){try{this.event(JSON.parse(line.slice(5)));}catch(e){this.ctx.emit({type:"diagnostic",payload:{message:String(redact((e as Error).message))}});}}}}throw new Error("OpenCode event connection closed");})().catch(e=>{if(!this.abort.signal.aborted)this.rejectTurn(e);});
  }
  protected event(v:any) {
    const p=v.properties??{};const sid=p.sessionID??p.part?.sessionID??p.info?.sessionID;if(sid && sid!==this.nativeId)return;
    if(v.type==="message.updated") {
      if(p.info?.id && p.info?.role){this.messageRoles.set(p.info.id,p.info.role);const pending=this.pendingParts.filter(e=>(e.properties?.part?.messageID??e.properties?.messageID)===p.info.id);this.pendingParts=this.pendingParts.filter(e=>!pending.includes(e));for(const event of pending)this.event(event);}
      if(p.info?.role==="assistant" && p.info?.error)this.rejectTurn(new HarnessRuntimeError(p.info.error?.data?.message??p.info.error.message??"OpenCode model request failed",422));
      else this.ctx.emit({type:"native.event",payload:v});
    }else if(v.type==="message.part.updated" || v.type==="message.part.delta") {
      const messageId=p.part?.messageID??p.messageID;const role=this.messageRoles.get(messageId);
      if(role==="user")return;
      if(!role){if(this.pendingParts.length<256)this.pendingParts.push(v);return;}
      this.hasActivity=true;
      if(v.type==="message.part.delta"){this.ctx.emit({type:"message.delta",itemId:p.partID,payload:{text:p.delta??"",role:"assistant"}});return;}
      const part=p.part??{};
      if(part.type==="text")this.ctx.emit({type:"message.part",itemId:part.id,payload:{text:part.text??"",role:"assistant"}});
      else if(part.type==="tool")this.ctx.emit({type:"tool",itemId:part.callID??part.id,payload:part});
      else if(part.type==="reasoning")this.ctx.emit({type:"reasoning",payload:part});
      else this.ctx.emit({type:"artifact",payload:part});
    }else if(v.type==="session.status" && p.status?.type==="busy"){if(sid===this.nativeId)this.hasActivity=true;}
    else if(v.type==="session.idle" || (v.type==="session.status" && p.status?.type==="idle")){if(sid===this.nativeId && this.hasActivity){this.hasActivity=false;this.finish(p);}}
    else if(v.type==="session.error"){if(sid===this.nativeId){this.ctx.emit({type:"turn.status",payload:{status:"failed",error:p.error?.data?.message}});this.rejectTurn(new HarnessRuntimeError(p.error?.data?.message??"OpenCode session failed",422));}}
    else if(v.type==="permission.asked" || v.type==="permission.updated")void this.ctx.ask("permission",p.permission??"Autoriser cet outil OpenCode ?",{...p,options:[{optionId:"once",name:"Autoriser une fois",kind:"allow_once"},{optionId:"reject",name:"Refuser",kind:"reject_once"}]}).then(a=>this.call("POST",`/permission/${encodeURIComponent(p.id)}/reply`,{reply:a.optionId==="once"?"once":"reject"})).catch(e=>this.rejectTurn(e));
    else if(v.type==="question.asked")void this.ctx.ask("question","OpenCode attend une réponse",p).then(a=>this.call("POST",`/question/${encodeURIComponent(p.id)}/reply`,{answers:a.answers??[]})).catch(e=>this.rejectTurn(e));
    else this.ctx.emit({type:"native.event",payload:v});
  }
  async prompt(parts:MessagePart[],steer=false) {
    if(steer)fail("OpenCode does not advertise steer with a turn identity",422);
    this.hasActivity=false;
    const converted=parts.map(p=>{
      if(p.type==="attachment"){const a=this.ctx.attachment(p.attachmentId);return {type:"file",mime:a.info.mimeType,filename:a.info.name,url:`data:${a.info.mimeType};base64,${a.data.toString("base64")}`};}
      return {type:"text",text:this.text([p])};
    });
    const model=this.ctx.session.model;const slash=model?.indexOf("/")??-1;
    const selected=model?(this.ctx.session.authMode==="multivibe"?{providerID:"multivibe",modelID:model}:slash>0?{providerID:model.slice(0,slash),modelID:model.slice(slash+1)}:undefined):undefined;
    await this.untilEnd(()=>this.call("POST",`/session/${this.nativeId}/prompt_async`,{parts:converted,...(selected?{model:selected}:{}),...(typeof this.ctx.session.configuration?.effort==="string"?{variant:this.ctx.session.configuration.effort}:{}),...(this.ctx.session.configuration?.mode?{agent:this.ctx.session.configuration.mode}:{})}));
  }
  async interrupt(){const done=this.settled;await this.call("POST",`/session/${this.nativeId}/abort`);await done;}
  async compact(){const model=this.ctx.session.model??"";const slash=model.indexOf("/");if(!model || this.ctx.session.authMode!=="multivibe" && slash<0)fail("Select a provider/model before manual OpenCode compaction",422);return this.call("POST",`/session/${this.nativeId}/summarize`,this.ctx.session.authMode==="multivibe"?{providerID:"multivibe",modelID:model}:{providerID:model.slice(0,slash),modelID:model.slice(slash+1)});}
  async inspect(subject:string) {
    if(subject==="effort"){
      const catalog=await this.call("GET","/provider");const selected=this.ctx.session.model??"";const slash=selected.indexOf("/");
      const managed=this.ctx.session.authMode==="multivibe";
      const provider=catalog.all?.find((p:any)=>p.id===(managed?"multivibe":selected.slice(0,slash)));
      if(!catalog.connected?.includes(provider?.id))return null;
      const model=provider?.models?.[managed?selected:selected.slice(slash+1)];
      return effortOptions(Object.keys(model?.variants??{}),this.ctx.session.configuration?.effort);
    }
    const routes:Record<string,string>={history:`/session/${this.nativeId}/message`,models:"/provider",commands:"/command",mcp:"/mcp",tools:"/tool/ids",agents:this.ctx.modelDiscovery?"/agent":`/session/${this.nativeId}/children`,plans:`/session/${this.nativeId}/todo`,settings:"/config",modes:"/agent",skills:"/skill"};
    return routes[subject]?this.call("GET",routes[subject]):super.inspect(subject);
  }
  async configure(v:Record<string,unknown>){if(v.effort!==undefined)validateEffort(await this.inspect("effort") as HarnessEffort|null,v.effort);if(typeof v.model==="string" && v.model!==this.ctx.session.model && this.ctx.session.configuration)delete this.ctx.session.configuration.effort;if(Object.keys(v).some(k=>!["model","mode","effort"].includes(k)))return super.configure(v);this.ctx.session.configuration={...this.ctx.session.configuration,...v};if(typeof v.model==="string")this.ctx.session.model=v.model;return {effectiveFrom:"next_turn",...v};}
  async native(method:string,params:Record<string,unknown>){
    if(method==="fork")return this.call("POST",`/session/${this.nativeId}/fork`,params);
    if(method==="revert" && typeof params.messageID==="string")return this.call("POST",`/session/${this.nativeId}/revert`,params);
    if(method==="unrevert")return this.call("POST",`/session/${this.nativeId}/unrevert`);
    return super.native(method,params);
  }
  close(){this.abort.abort();if(this.child){this.child.stdin.destroy();this.child.stdout.destroy();this.child.stderr.destroy();this.child.kill("SIGTERM");}super.close();}
}

export function adapterFor(ctx:AdapterContext):HarnessAdapter {
  switch(ctx.session.harnessId){
    case "hermes-agent":return new AcpAdapter(ctx,["acp"]);
    case "gemini-cli":return new AcpAdapter(ctx,["--acp"]);
    case "pi":return new PiAdapter(ctx);
    case "openai-codex":return new CodexAdapter(ctx);
    case "claude-code":return new ClaudeAdapter(ctx);
    case "openwebui":return new OpenWebUIAdapter(ctx);
    case "librechat":return ctx.libreChatConnection?.userToken?new LibreChatNativeAdapter(ctx):new LibreChatAdapter(ctx);
    case "opencode":return new OpenCodeAdapter(ctx);
    default: {
      const args=ctx.session.configuration?.acpArgs;
      if(Array.isArray(args) && args.every(v=>typeof v==="string"))return new AcpAdapter(ctx,args);
      return fail("No conversation adapter is registered for this harness",422);
    }
  }
}
