import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { capabilities, fail, supported, unsupported, type AdapterContext, type HarnessAdapter, type HarnessDescriptor, type MessagePart } from "./types.js";

export type RemoteChatConnection = {endpoint:string;apiKey:string;agentId:string;userId?:string;userToken?:string;cookies?:string};
export const remoteConnectionId=(v:RemoteChatConnection)=>createHash("sha256").update(v.endpoint+"\0"+(v.userId??v.apiKey)).digest("hex");
type Agent = {id:string;name:string};
export function remoteChatEndpoint(value:unknown,suffix:string,name:string):string {
  if(typeof value!=="string" || value.length>4096)fail(`Enter a ${name} endpoint`);
  let url:URL;try{url=new URL(value);}catch{return fail(`Invalid ${name} endpoint`);}
  if(!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)fail("Use an HTTP(S) endpoint without credentials, query or fragment");
  let base=url.pathname.replace(/\/+$/u,"");
  if(suffix==="/api" && base.endsWith("/api/v1"))base=base.slice(0,-3);
  if(!base.endsWith(suffix))base+=suffix;
  url.pathname=base;return url.href.replace(/\/$/u,"");
}
export function libreChatEndpoint(value:unknown){return remoteChatEndpoint(value,"/api/agents/v1","LibreChat");}
export async function remoteChatRequest(connection:RemoteChatConnection,route:string,body?:unknown,signal?:AbortSignal,name="LibreChat"):Promise<Response> {
  let response:Response;
  try{response=await fetch(connection.endpoint+route,{method:body?"POST":"GET",headers:{authorization:`Bearer ${connection.apiKey}`,accept:body?"text/event-stream":"application/json",...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(600_000)]):AbortSignal.timeout(15_000)});}
  catch{ return fail(`${name} connection failed or timed out. Check the endpoint and server.`,502); }
  if(!response.ok){await response.body?.cancel();fail(`${name} returned HTTP ${response.status}. Check the API key and permissions.`,response.status===401 || response.status===403?422:502);}
  return response;
}
export async function boundedJson(response:Response,name="LibreChat"):Promise<any>{
  let bytes=0;const chunks:Uint8Array[]=[];
  for await(const chunk of response.body??[]){bytes+=chunk.length;if(bytes>4*1024*1024)fail(`${name} response exceeds its limit`,502);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{return fail(`Invalid ${name} JSON response`,502);}
}
export async function remoteChatModels(connection:RemoteChatConnection,name="LibreChat"):Promise<Agent[]> {
  const result=await boundedJson(await remoteChatRequest(connection,"/models",undefined,undefined,name),name);
  if(!Array.isArray(result.data) || result.data.length>2000)fail(`Invalid ${name} model catalog`,502);
  return result.data.map((v:any)=>{if(typeof v.id!=="string" || !v.id || v.id.length>256)fail(`Invalid ${name} model identifier`,502);return {id:v.id,name:typeof v.name==="string"?v.name.slice(0,256):v.id};});
}
export const libreChatAgents=(connection:RemoteChatConnection)=>remoteChatModels(connection);
export class RemoteChatConfiguration {
  private file:string;
  constructor(root:string,private service:{id:"librechat"|"openwebui";name:string;suffix:string}={id:"librechat",name:"LibreChat",suffix:"/api/agents/v1"}){this.file=path.join(root,`${service.id}-connection.json`);}
  read():RemoteChatConnection|undefined {
    try{const stat=fs.lstatSync(this.file);if(!stat.isFile() || (stat.mode&0o077)!==0)fail(`${this.service.name} credentials must be a private file`,409);return JSON.parse(fs.readFileSync(this.file,"utf8"));}catch(e:any){if(e.code==="ENOENT")return;throw e;}
  }
  publicConfiguration(){const v=this.read();return {endpoint:v?.endpoint??"",agentId:v?.agentId??"",configured:Boolean(v),hasApiKey:Boolean(v?.apiKey),hasUserSession:Boolean(v?.userToken),connectionId:v?remoteConnectionId(v):undefined};}
  private persist(connection:RemoteChatConnection){
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const temporary=this.file+"."+randomUUID();
    try{fs.writeFileSync(temporary,JSON.stringify(connection),{mode:0o600,flag:"wx"});fs.renameSync(temporary,this.file);}finally{fs.rmSync(temporary,{force:true});}
  }
  private refreshing?:Promise<void>;
  async userRequest(route:string,body?:unknown,method=body?"POST":"GET",signal?:AbortSignal):Promise<Response>{
    const connection=this.read()??fail(`Configure ${this.service.name} first`,409);
    return this.requestWith(connection,route,body,method,signal,true);
  }
  private async requestWith(connection:RemoteChatConnection,route:string,body:unknown,method:string,signal?:AbortSignal,retry=false):Promise<Response>{
    const isLibre=this.service.id==="librechat";
    if(isLibre && !connection.userToken)fail("Reconnect LibreChat with your account to synchronize conversations",409);
    const endpoint=isLibre?connection.endpoint.replace(/\/api\/agents\/v1$/u,"/api"):connection.endpoint;
    let response:Response;
    try{response=await fetch(endpoint+route,{method,headers:{authorization:`Bearer ${isLibre?connection.userToken:connection.apiKey}`,accept:"application/json, text/event-stream",origin:new URL(endpoint).origin,...(connection.cookies?{cookie:connection.cookies}:{}),...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(600_000)]):AbortSignal.timeout(15_000)});}catch{return fail(`${this.service.name} connection failed or timed out`,502);}
    if(response.status===401 && retry && isLibre && connection.cookies){
      await response.body?.cancel();
      if(!this.refreshing)this.refreshing=this.refresh(connection).finally(()=>{this.refreshing=undefined;});
      await this.refreshing;return this.requestWith(this.read()!,route,body,method,signal);
    }
    if(!response.ok){await response.body?.cancel();fail(`${this.service.name} returned HTTP ${response.status}. Reconnect or check account permissions.`,response.status===404?404:response.status===401 || response.status===403?422:502);}
    return response;
  }
  private cookies(response:Response,previous=""){
    const jar=new Map(previous.split("; ").filter(Boolean).map(v=>[v.slice(0,v.indexOf("=")),v]));
    for(const header of response.headers.getSetCookie()){const pair=header.split(";")[0];jar.set(pair.slice(0,pair.indexOf("=")),pair);}
    return [...jar.values()].join("; ");
  }
  private async refresh(connection:RemoteChatConnection){
    // Never replay a submitted prompt: only refresh after a rejected authentication check.
    const endpoint=connection.endpoint.replace(/\/api\/agents\/v1$/u,"/api");
    let response:Response;try{response=await fetch(endpoint+"/auth/refresh",{method:"POST",headers:{cookie:connection.cookies!,origin:new URL(endpoint).origin},redirect:"error",signal:AbortSignal.timeout(15_000)});}catch{return fail("LibreChat session refresh failed. Reconnect your account.",422);}
    if(!response.ok){await response.body?.cancel();fail("LibreChat session expired. Reconnect your account.",422);}
    const result=await boundedJson(response);
    if(typeof result.token!=="string" || !result.token)fail("LibreChat session expired. Reconnect your account.",422);
    if(remoteConnectionId(this.read()!)!==remoteConnectionId(connection))fail("Remote connection changed",409);
    this.persist({...this.read()!,userToken:result.token,cookies:this.cookies(response,connection.cookies)});
  }
  async json(route:string,body?:unknown,method?:string){return boundedJson(await this.userRequest(route,body,method),this.service.name);}

  async models(){
    if(this.service.id==="librechat" && this.read()?.userToken){
      const catalog=await this.json("/agents?limit=100");const rows=Array.isArray(catalog)?catalog:catalog.data;
      if(!Array.isArray(rows))fail("Invalid LibreChat agent catalog",502);
      return rows.map((v:any)=>({id:v.id,name:v.name??v.id}));
    }
    return remoteChatModels(this.read()??fail("Configure the remote harness first",409),this.service.name);
  }
  async configure(input:any){
    if(input.userToken && (typeof input.userToken!=="string" || input.userToken.length>16_384 || /[\r\n\0]/u.test(input.userToken)))fail("Enter a valid LibreChat user session token",422);
    if(input.password && (typeof input.password!=="string" || input.password.length>4096 || typeof input.email!=="string" || input.email.length>320))fail("Enter valid LibreChat account credentials",422);
    const endpoint=remoteChatEndpoint(input.endpoint,this.service.suffix,this.service.name),old=this.read();
    const apiKey=input.apiKey || (old?.endpoint===endpoint?old.apiKey:undefined);
    if(apiKey && (typeof apiKey!=="string" || apiKey.length>4096 || /[\r\n\0]/u.test(apiKey)))fail(`Enter the ${this.service.name} API key`);
    let connection:RemoteChatConnection={endpoint,apiKey:apiKey??"",agentId:typeof input.agentId==="string"?input.agentId:"",...(old?.endpoint===endpoint?{userToken:old.userToken,userId:old.userId,cookies:old.cookies}:{})};
    if(this.service.id==="librechat" && input.email && input.password){
      const base=endpoint.replace(/\/api\/agents\/v1$/u,"/api");
      let response:Response;try{response=await fetch(base+"/auth/login",{method:"POST",headers:{"content-type":"application/json",origin:new URL(base).origin},body:JSON.stringify({email:input.email,password:input.password}),redirect:"error",signal:AbortSignal.timeout(15_000)});}catch{return fail("LibreChat sign-in failed",422);}
      if(!response.ok){await response.body?.cancel();fail("LibreChat sign-in refused. Check your account credentials.",422);}
      const result=await boundedJson(response);
      if(typeof result.token!=="string" || !result.user?.id)fail("LibreChat requires an interactive sign-in. Use a user session token instead.",422);
      connection={...connection,userToken:result.token,userId:result.user.id,cookies:this.cookies(response)};
    }
    if(this.service.id==="librechat" && input.userToken){
      connection={...connection,userToken:input.userToken,cookies:undefined};
      const user=await boundedJson(await this.requestWith(connection,"/user",undefined,"GET"));
      if(typeof user.id!=="string")fail("Invalid LibreChat user session",422);connection.userId=user.id;
    }
    let agents:Agent[];
    if(this.service.id==="librechat" && connection.userToken){
      const catalog=await boundedJson(await this.requestWith(connection,"/agents?limit=100",undefined,"GET"));
      const rows=Array.isArray(catalog)?catalog:catalog.data;
      if(!Array.isArray(rows))fail("Invalid LibreChat agent catalog",502);
      agents=rows.map((v:any)=>({id:v.id,name:v.name??v.id}));
      await boundedJson(await this.requestWith(connection,"/convos?limit=1",undefined,"GET"));
    }else {
      if(!connection.apiKey)fail(`Enter the ${this.service.name} API key`);
      agents=await remoteChatModels(connection,this.service.name);
      if(this.service.id==="openwebui"){
        // Identity is account-scoped so API-key rotation preserves the conversation mapping.
        const user=await boundedJson(await this.requestWith(connection,"/v1/auths/",undefined,"GET"),this.service.name);
        if(typeof user.id!=="string")fail("Invalid Open WebUI user identity",502);connection.userId=user.id;
        await boundedJson(await this.requestWith(connection,"/v1/chats/?page=1&include_pinned=true&include_folders=true",undefined,"GET"),this.service.name);
      }
    }
    // Discovery is read-only until the user selects an agent and saves.
    if(input.discover===true)return {agents};
    if(!agents.some(v=>v.id===connection.agentId))fail(`Select an available ${this.service.name} model or agent`,422);
    this.persist(connection);
    return {...this.publicConfiguration(),agents};
  }
  descriptor():HarnessDescriptor {
    const configured=Boolean(this.read()),caps=capabilities();
    for(const key of ["sessions","streaming"] as const)caps[key]=supported();
    for(const key of ["queue","attachments","diagnostics","automations"] as const)caps[key]=supported("multivibe");
    caps.attachments=supported("multivibe",{mimeTypes:["text/*","application/json"],transport:"inline text"});
    caps.tools=supported("native",{execution:`${this.service.name} server`,visibility:"Only events exposed by the remote API"});
    caps.models=supported();
    caps.history=supported(this.service.id==="openwebui" || this.read()?.userToken?"native":"multivibe");
    if(this.service.id==="openwebui")caps.streaming=supported("multivibe",{transport:"saved response polling"});
    caps.interrupt=unsupported("This adapter does not support acknowledged remote cancellation");
    return {id:this.service.id,name:this.service.name,protocol:this.service.id,detected:true,configured:configured && (this.service.id!=="librechat" || Boolean(this.read()?.userToken)),available:configured,authentication:configured?"unknown":"required",capabilities:caps,...(!configured?{reason:`Configure the ${this.service.name} endpoint, API key and model`}:{})};
  }
}

export { RemoteChatConfiguration as LibreChatConfiguration };

/** LibreChat owns agent execution; Desktop retains the transcript for subsequent turns. */
export class LibreChatAdapter implements HarnessAdapter {
  private abort=new AbortController();
  private history:Array<{role:string;content:string}>=[];
  private file:string;
  private connection:RemoteChatConnection;
  constructor(private ctx:AdapterContext){this.file=path.join(ctx.root,"librechat-history.json");this.connection=ctx.libreChatConnection??fail("Configure LibreChat first",409);}
  async start(){
    if(this.ctx.target.kind!=="local")fail("Use the LibreChat connection on the executing Host",422);
    try{this.history=JSON.parse(fs.readFileSync(this.file,"utf8"));}catch(e:any){if(e.code!=="ENOENT")throw e;}
    // Session capabilities were set from the Host catalog at creation.
    this.ctx.emit({type:"harness.metadata",payload:{name:"LibreChat",protocolVersion:"chat.completions"}});
  }
  async prompt(parts:MessagePart[],steer=false){
    if(steer)fail("LibreChat does not expose in-flight steering through this API",422);
    const text=parts.map(p=>{
      if(p.type==="text")return p.text;
      if(p.type==="resource" && p.text!==undefined)return `[${p.uri}]\n${p.text}`;
      if(p.type==="attachment"){const a=this.ctx.attachment(p.attachmentId);if(a.info.mimeType.startsWith("text/") || a.info.mimeType==="application/json")return `[${a.info.name}]\n${a.data.toString("utf8")}`;}
      return fail("This LibreChat adapter accepts text and text documents only",422);
    }).join("\n\n");
    const messages=[...this.history,{role:"user",content:text}];
    if(Buffer.byteLength(JSON.stringify(messages))>16*1024*1024)fail("LibreChat conversation exceeds 16 MiB; start a new conversation",413);
    const response=await remoteChatRequest({...this.connection,agentId:this.ctx.session.model??this.connection.agentId},"/chat/completions",{model:this.ctx.session.model??this.connection.agentId,messages,stream:true},this.abort.signal);
    let answer="",terminal=false,bytes=0;
    const event=(value:any)=>{
      if(value.error)fail("LibreChat reported an execution error",502);
      if(value.usage)this.ctx.emit({type:"usage",payload:value.usage});
      const choice=value.choices?.[0],delta=choice?.delta??choice?.message;
      if(typeof delta?.content==="string"){answer+=delta.content;this.ctx.emit({type:"message.delta",payload:{text:delta.content,role:"assistant"}});}
      if(typeof delta?.reasoning==="string")this.ctx.emit({type:"reasoning",payload:{text:delta.reasoning}});
      if(delta?.tool_calls)this.ctx.emit({type:"tool",payload:{tool_calls:delta.tool_calls}});
      if(choice?.finish_reason){if(!["stop","tool_calls"].includes(choice.finish_reason))fail(`LibreChat ended with ${String(choice.finish_reason).slice(0,64)}`,502);terminal=true;}
    };
    if(response.headers.get("content-type")?.includes("application/json")){event(await boundedJson(response));}
    else {
      const decoder=new TextDecoder();let buffer="",data:string[]=[];
      const line=(s:string)=>{if(s===""){if(data.length){const raw=data.join("\n");data=[];if(raw!=="[DONE]"){let value;try{value=JSON.parse(raw);}catch{return fail("Invalid LibreChat stream event",502);}event(value);}}}else if(s.startsWith("data:"))data.push(s.slice(5).trimStart());};
      for await(const chunk of response.body??[]){bytes+=chunk.length;if(bytes>32*1024*1024)fail("LibreChat stream exceeds its limit",502);buffer+=decoder.decode(chunk,{stream:true});if(buffer.length>2*1024*1024)fail("LibreChat stream event exceeds its limit",502);let end;while((end=buffer.indexOf("\n"))>=0){line(buffer.slice(0,end).replace(/\r$/u,""));buffer=buffer.slice(end+1);}}
      buffer+=decoder.decode();if(buffer)line(buffer.replace(/\r$/u,""));line("");
    }
    if(!terminal)fail("LibreChat stream ended before a completion was acknowledged; do not automatically retry",502);
    this.history=[...messages,{role:"assistant",content:answer}];
    const temporary=this.file+"."+randomUUID();
    try{fs.writeFileSync(temporary,JSON.stringify(this.history),{mode:0o600,flag:"wx"});fs.renameSync(temporary,this.file);}finally{fs.rmSync(temporary,{force:true});}
    this.ctx.emit({type:"turn.status",payload:{status:"completed"}});
  }
  async interrupt():Promise<void>{fail("Remote cancellation is not acknowledged by the LibreChat Chat Completions API",422);}
  async compact():Promise<unknown>{return fail("Manual LibreChat compaction is unavailable",422);}
  async inspect(subject:string):Promise<unknown>{if(subject==="history")return {messages:this.history};if(subject==="models")return {models:await libreChatAgents(this.connection)};return fail("This inspection is unavailable through the LibreChat API",422);}
  async configure():Promise<unknown>{return fail("Choose the LibreChat agent when configuring a new conversation",422);}
  async native():Promise<unknown>{return fail("This operation is unavailable through the LibreChat API",422);}
  close(){this.abort.abort();}
}
