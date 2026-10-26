import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { boundedJson, remoteChatRequest, remoteChatModels, remoteChatEndpoint, type RemoteChatConnection } from "./librechat.js";
import { fail, type AdapterContext, type HarnessAdapter, type MessagePart } from "./types.js";

export const openWebUIEndpoint=(value:unknown)=>remoteChatEndpoint(value,"/api","Open WebUI");
type Checkpoint={chatId:string;assistantId:string};
/** Saved remote chats activate Open WebUI's native tool loop; raw completions do not. */
export class OpenWebUIAdapter implements HarnessAdapter {
  private abort=new AbortController();
  private checkpoint?:Checkpoint;
  private file:string;
  private connection:RemoteChatConnection;
  constructor(private ctx:AdapterContext){this.file=path.join(ctx.root,"openwebui-session.json");this.connection=ctx.openWebUIConnection??fail("Configure Open WebUI first",409);}
  private async call(route:string,body?:unknown){this.ctx.remoteChats?.identity();return boundedJson(await (this.ctx.remoteChats?this.ctx.remoteChats.config.userRequest(route,body,body?"POST":"GET",this.abort.signal):remoteChatRequest(this.connection,route,body,this.abort.signal,"Open WebUI")),"Open WebUI");}
  private chatPath(id:string){return `/v1/chats/${encodeURIComponent(id)}`;}
  private save(checkpoint:Checkpoint){
    const temporary=this.file+"."+randomUUID();
    try{fs.writeFileSync(temporary,JSON.stringify(checkpoint),{mode:0o600,flag:"wx"});fs.renameSync(temporary,this.file);}finally{fs.rmSync(temporary,{force:true});}
    this.checkpoint=checkpoint;this.ctx.nativeSession(checkpoint.chatId);
  }
  async start(){
    if(this.ctx.target.kind!=="local")fail("Configure Open WebUI on the executing Host",422);
    try{this.checkpoint=JSON.parse(fs.readFileSync(this.file,"utf8"));}catch(e:any){if(e.code!=="ENOENT")throw e;}
    if(this.ctx.session.nativeSessionId && !this.checkpoint){
      const snapshot=await this.call(this.chatPath(this.ctx.session.nativeSessionId));
      const current=snapshot?.chat?.history?.currentId;
      if(typeof current!=="string")fail("Open WebUI conversation has no active branch",409);
      this.save({chatId:this.ctx.session.nativeSessionId,assistantId:current});
    }
    if(this.ctx.session.nativeSessionId && this.ctx.session.nativeSessionId!==this.checkpoint?.chatId)fail("Open WebUI session checkpoint is missing or inconsistent",409);
    this.ctx.emit({type:"harness.metadata",payload:{name:"Open WebUI",protocolVersion:"saved-chat"}});
  }
  private text(parts:MessagePart[]){return parts.map(p=>{
    if(p.type==="text")return p.text;
    if(p.type==="resource" && p.text!==undefined)return `[${p.uri}]\n${p.text}`;
    if(p.type==="attachment"){const a=this.ctx.attachment(p.attachmentId);if(a.info.mimeType.startsWith("text/") || a.info.mimeType==="application/json")return `[${a.info.name}]\n${a.data.toString("utf8")}`;}
    return fail("Open WebUI accepts text and text documents through this adapter",422);
  }).join("\n\n");}
  async prompt(parts:MessagePart[],steer=false){
    this.ctx.remoteChats?.identity();
    if(steer)fail("Open WebUI in-flight steering is unavailable",422);
    const text=this.text(parts),model=this.ctx.session.model??this.connection.agentId;
    let chat:any={title:this.ctx.session.title,models:[model],history:{currentId:null,messages:{}},messages:[]};
    let previous=this.checkpoint;
    let baseline:string|undefined;
    if(previous){
      chat=(await this.call(this.chatPath(previous.chatId))).chat;
      baseline=JSON.stringify(chat);
      // Read the latest native branch so a turn written in the web client is included.
      const current=chat?.history?.currentId;
      if(typeof current!=="string")fail("Open WebUI conversation has no active branch",409);
      previous={chatId:previous.chatId,assistantId:current};
      const last=chat?.history?.messages?.[current];
      if(!last || last.role==="assistant" && last.done!==true)fail("Previous Open WebUI execution has not been reconciled. Inspect the remote chat before sending again.",409);

    }
    const userId=randomUUID(),assistantId=randomUUID(),timestamp=Math.floor(Date.now()/1000);
    const user={id:userId,role:"user",content:text,parentId:previous?.assistantId??null,childrenIds:[assistantId],models:[model],timestamp};
    const assistant={id:assistantId,role:"assistant",content:"",parentId:userId,childrenIds:[],model,modelName:model,modelIdx:0,done:false,timestamp:timestamp+1};
    if(previous)chat.history.messages[previous.assistantId].childrenIds=[...(chat.history.messages[previous.assistantId].childrenIds??[]),userId];
    chat.history.messages[userId]=user;chat.history.messages[assistantId]=assistant;chat.history.currentId=assistantId;
    // Build context from the active branch only, preserving structured remote output in storage.
    const branch:any[]=[];const seen=new Set<string>();let cursor:string|null=userId;
    while(cursor){if(seen.has(cursor) || seen.size>20_000)fail("Invalid Open WebUI conversation history",502);seen.add(cursor);const message:any=chat.history.messages[cursor];if(!message)fail("Incomplete Open WebUI conversation history",502);branch.unshift(message);cursor=message.parentId??null;}
    chat.messages=[...branch,assistant];
    if(Buffer.byteLength(JSON.stringify(chat))>16*1024*1024)fail("Open WebUI conversation exceeds 16 MiB; start a new conversation",413);
    if(previous){
      const latest=await this.call(this.chatPath(previous.chatId));
      if(JSON.stringify(latest?.chat)!==baseline)fail("Open WebUI changed while preparing this message. Synchronize and send again.",409);
    }
    const saved=await this.call(previous?this.chatPath(previous.chatId):"/v1/chats/new",{chat});
    const chatId=previous?.chatId??saved?.id;if(typeof chatId!=="string" || !chatId || chatId.length>256)fail("Open WebUI did not return a valid chat identifier",502);
    this.save({chatId,assistantId});
    const accepted=await this.call("/chat/completions",{model,messages:branch.map(m=>({role:m.role,content:m.content})),user_message:user,stream:true,chat_id:chatId,id:assistantId,session_id:`multivibe-${this.ctx.session.id}`,params:{function_calling:"native"},background_tasks:{title_generation:false,tags_generation:false,follow_up_generation:false}});
    if(accepted?.status!==true || !Array.isArray(accepted.task_ids))fail("Open WebUI did not acknowledge the remote execution; inspect the chat before retrying",502);
    let content="",output="",usage="",emptyTaskPolls=0;const deadline=Date.now()+600_000;
    for(;;){
      const snapshot=await this.call(this.chatPath(chatId));const message=snapshot?.chat?.history?.messages?.[assistantId];
      if(!message)fail("Open WebUI response message is missing",502);
      if(message.error)fail("Open WebUI reported an execution error. Inspect the remote chat for details.",502);
      if(typeof message.content==="string" && message.content!==content){content=message.content;this.ctx.emit({type:"message.part",itemId:assistantId,payload:{role:"assistant",text:content}});}
      if(message.output && JSON.stringify(message.output)!==output){
        output=JSON.stringify(message.output);const values=Array.isArray(message.output)?message.output:[];
        const tools=values.filter((value:any)=>["function_call","tool_call","mcp_call"].includes(value?.type) || typeof value?.name==="string");
        for(const [index,value] of tools.entries())this.ctx.emit({type:"tool",itemId:value.call_id??value.id??`${assistantId}-tool-${index}`,payload:{...value,status:value.status??(message.done===true?"completed":"running")}});
        if(!tools.length)this.ctx.emit({type:"native.event",itemId:assistantId,payload:{output:message.output}});
      }
      if(message.usage && JSON.stringify(message.usage)!==usage){usage=JSON.stringify(message.usage);this.ctx.emit({type:"usage",payload:message.usage});}
      if(message.done===true){this.ctx.emit({type:"turn.status",payload:{status:"completed"}});return;}
      const tasks=await this.call(`/tasks/chat/${encodeURIComponent(chatId)}`);
      if(!Array.isArray(tasks.task_ids))fail("Invalid Open WebUI task status",502);
      if(!tasks.task_ids.length){if(++emptyTaskPolls>=2)fail("Open WebUI task ended without a completed response; inspect the remote chat before retrying",502);}else emptyTaskPolls=0;
      if(Date.now()>deadline)fail("Open WebUI execution timed out; the remote task may still be running",504);
      await delay(750,undefined,{signal:this.abort.signal});
    }
  }
  async interrupt():Promise<void>{fail("Acknowledged remote cancellation is unavailable in this adapter",422);}
  async compact():Promise<unknown>{return fail("Manual Open WebUI compaction is unavailable",422);}
  async inspect(subject:string):Promise<unknown>{
    if(subject==="models")return {models:await remoteChatModels(this.connection,"Open WebUI")};
    if(subject==="history" && this.checkpoint)return this.call(this.chatPath(this.checkpoint.chatId));
    return fail("This inspection is unavailable through the Open WebUI adapter",422);
  }
  async configure():Promise<unknown>{return fail("Choose the Open WebUI model for a new conversation",422);}
  async native():Promise<unknown>{return fail("This operation is unavailable through the Open WebUI adapter",422);}
  close(){this.abort.abort();}
}
