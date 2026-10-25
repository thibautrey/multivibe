import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { capabilities, fail, supported, unsupported, type AdapterContext, type HarnessAdapter, type HarnessDescriptor, type MessagePart } from "./types.js";

type Connection = {endpoint:string;apiKey:string;agentId:string};
type Agent = {id:string;name:string};
export function libreChatEndpoint(value:unknown):string {
  if(typeof value!=="string" || value.length>4096)fail("Enter a LibreChat endpoint");
  let url:URL;try{url=new URL(value);}catch{return fail("Invalid LibreChat endpoint");}
  if(!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)fail("Use an HTTP(S) endpoint without credentials, query or fragment");
  let base=url.pathname.replace(/\/+$/u,"");
  if(!base.endsWith("/api/agents/v1"))base+="/api/agents/v1";
  url.pathname=base;return url.href.replace(/\/$/u,"");
}
async function request(connection:Connection,route:string,body?:unknown,signal?:AbortSignal):Promise<Response> {
  let response:Response;
  try{response=await fetch(connection.endpoint+route,{method:body?"POST":"GET",headers:{authorization:`Bearer ${connection.apiKey}`,accept:body?"text/event-stream":"application/json",...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(600_000)]):AbortSignal.timeout(15_000)});}
  catch{ return fail("LibreChat connection failed or timed out. Check the endpoint and server.",502); }
  if(!response.ok){await response.body?.cancel();fail(`LibreChat returned HTTP ${response.status}. Check the API key, remote-agent access and permissions.`,response.status===401 || response.status===403?422:502);}
  return response;
}
async function boundedJson(response:Response):Promise<any>{
  let bytes=0;const chunks:Uint8Array[]=[];
  for await(const chunk of response.body??[]){bytes+=chunk.length;if(bytes>4*1024*1024)fail("LibreChat response exceeds its limit",502);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{return fail("Invalid LibreChat JSON response",502);}
}
export async function libreChatAgents(connection:Connection):Promise<Agent[]> {
  const result=await boundedJson(await request(connection,"/models"));
  if(!Array.isArray(result.data) || result.data.length>2000)fail("Invalid LibreChat agent catalog",502);
  return result.data.map((v:any)=>{if(typeof v.id!=="string" || !v.id || v.id.length>256)fail("Invalid LibreChat agent identifier",502);return {id:v.id,name:typeof v.name==="string"?v.name.slice(0,256):v.id};});
}
export class LibreChatConfiguration {
  private file:string;
  constructor(root:string){this.file=path.join(root,"librechat-connection.json");}
  read():Connection|undefined {
    try{const stat=fs.lstatSync(this.file);if(!stat.isFile() || (stat.mode&0o077)!==0)fail("LibreChat credentials must be a private file",409);return JSON.parse(fs.readFileSync(this.file,"utf8"));}catch(e:any){if(e.code==="ENOENT")return;throw e;}
  }
  publicConfiguration(){const v=this.read();return {endpoint:v?.endpoint??"",agentId:v?.agentId??"",configured:Boolean(v),hasApiKey:Boolean(v?.apiKey)};}
  async configure(input:any){
    const endpoint=libreChatEndpoint(input.endpoint),old=this.read();
    const apiKey=input.apiKey || (old?.endpoint===endpoint?old.apiKey:undefined);
    if(typeof apiKey!=="string" || !apiKey || apiKey.length>4096 || /[\r\n\0]/u.test(apiKey))fail("Enter the LibreChat API key");
    const connection={endpoint,apiKey,agentId:typeof input.agentId==="string"?input.agentId:""};
    const agents=await libreChatAgents(connection);
    // Discovery is read-only until the user selects an agent and saves.
    if(input.discover===true)return {agents};
    if(!agents.some(v=>v.id===connection.agentId))fail("Select an available LibreChat agent",422);
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const temporary=this.file+"."+randomUUID();
    try{fs.writeFileSync(temporary,JSON.stringify(connection),{mode:0o600,flag:"wx"});fs.renameSync(temporary,this.file);}finally{fs.rmSync(temporary,{force:true});}
    return {...this.publicConfiguration(),agents};
  }
  descriptor():HarnessDescriptor {
    const configured=Boolean(this.read()),caps=capabilities();
    for(const key of ["sessions","streaming"] as const)caps[key]=supported();
    for(const key of ["queue","history","attachments","diagnostics","automations"] as const)caps[key]=supported("multivibe");
    caps.attachments=supported("multivibe",{mimeTypes:["text/*","application/json"],transport:"inline text"});
    caps.tools=supported("native",{execution:"LibreChat agent server",visibility:"Only events exposed by the remote API"});
    caps.interrupt=unsupported("The Chat Completions API does not acknowledge remote cancellation");
    return {id:"librechat",name:"LibreChat",protocol:"librechat",detected:true,configured,available:configured,authentication:configured?"unknown":"required",capabilities:caps,...(!configured?{reason:"Configure the LibreChat endpoint, API key and agent"}:{})};
  }
}

/** LibreChat owns agent execution; Desktop retains the transcript for subsequent turns. */
export class LibreChatAdapter implements HarnessAdapter {
  private abort=new AbortController();
  private history:Array<{role:string;content:string}>=[];
  private file:string;
  private connection:Connection;
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
    const response=await request({...this.connection,agentId:this.ctx.session.model??this.connection.agentId},"/chat/completions",{model:this.ctx.session.model??this.connection.agentId,messages,stream:true},this.abort.signal);
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
    fs.writeFileSync(this.file,JSON.stringify(this.history),{mode:0o600});
    this.ctx.emit({type:"turn.status",payload:{status:"completed"}});
  }
  async interrupt():Promise<void>{fail("Remote cancellation is not acknowledged by the LibreChat Chat Completions API",422);}
  async compact():Promise<unknown>{return fail("Manual LibreChat compaction is unavailable",422);}
  async inspect(subject:string):Promise<unknown>{if(subject==="history")return {messages:this.history};if(subject==="models")return {models:await libreChatAgents(this.connection)};return fail("This inspection is unavailable through the LibreChat API",422);}
  async configure():Promise<unknown>{return fail("Choose the LibreChat agent when configuring a new conversation",422);}
  async native():Promise<unknown>{return fail("This operation is unavailable through the LibreChat API",422);}
  close(){this.abort.abort();}
}
