import { randomUUID } from "node:crypto";
import { boundedJson } from "./librechat.js";
import { remoteText } from "./remote-chats.js";
import { fail, type AdapterContext, type HarnessAdapter, type MessagePart } from "./types.js";

/** Uses LibreChat's user chat API so tools and history belong to the original server chat. */
export class LibreChatNativeAdapter implements HarnessAdapter {
  private abort=new AbortController();
  private remote;
  constructor(private ctx:AdapterContext){this.remote=ctx.remoteChats??fail("LibreChat account connection is required",409);}
  async start(){this.ctx.emit({type:"harness.metadata",payload:{name:"LibreChat",protocolVersion:"native-user-chat"}});}
  async prompt(parts:MessagePart[],steer=false){
    if(steer)fail("In-flight steering is unavailable through this adapter",422);
    const text=parts.map(p=>{
      if(p.type==="text")return p.text;
      if(p.type==="resource" && p.text!==undefined)return `[${p.uri}]\n${p.text}`;
      if(p.type==="attachment"){const a=this.ctx.attachment(p.attachmentId);if(a.info.mimeType.startsWith("text/") || a.info.mimeType==="application/json")return `[${a.info.name}]\n${a.data.toString("utf8")}`;}
      return fail("LibreChat accepts text and text documents through this adapter",422);
    }).join("\n\n");
    const previous=this.ctx.session.nativeSessionId?await this.remote.snapshot(this.ctx.session.nativeSessionId):undefined;
    if(previous?.messages.at(-1)?.done===false)fail("LibreChat is still processing this conversation",409);
    const endpoint=previous?.endpoint??"agents";
    const model=previous?.model??this.ctx.session.model;
    const body={text,endpoint,agent_id:endpoint==="agents"?model:undefined,model:endpoint==="agents"?undefined:model,conversationId:previous?.id??null,parentMessageId:previous?.messages.at(-1)?.id??"00000000-0000-0000-0000-000000000000",isContinued:false,isRegenerate:false,clientRequestId:this.ctx.session.activeTurnId??randomUUID(),messageId:randomUUID()};
    // Pin the remote identity as soon as the server acknowledges the chat; never replay on disconnect.
    const response=await this.remote.config.userRequest(endpoint==="agents"?"/agents/chat":`/ask/${encodeURIComponent(endpoint)}`,body,"POST",this.abort.signal);
    let final=false,chatId=previous?.id;
    const event=(v:any)=>{
      if(v.error)fail("LibreChat reported an execution error; inspect the remote chat before retrying",502);
      const id=v.conversationId??v.conversation?.conversationId??v.requestMessage?.conversationId??v.responseMessage?.conversationId;
      if(typeof id==="string"){chatId=id;this.ctx.nativeSession(id);}
      if(v.final===true){
        if(v.responseMessage?.error || v.responseMessage?.unfinished)fail("LibreChat did not complete the remote response",502);
        this.ctx.emit({type:"message.part",payload:{text:remoteText(v.responseMessage?.content)||v.responseMessage?.text||""}});final=true;
      }else if(v.event==="on_message_delta" || v.type==="text_delta"){
        const delta=v.data?.delta??v.delta;
        const text=typeof delta==="string"?delta:remoteText(delta?.content??delta);
        if(text)this.ctx.emit({type:"message.delta",payload:{text}});
      }else this.ctx.emit({type:"native.event",payload:v});
    };
    const consume=async(response:Response)=>{
      let buffer="",data:string[]=[],bytes=0;const decoder=new TextDecoder();
      const line=(s:string)=>{if(!s){if(data.length){const raw=data.join("\n");data=[];if(raw!=="[DONE]"){let value;try{value=JSON.parse(raw);}catch{return fail("Invalid LibreChat native stream",502);}event(value);}}}else if(s.startsWith("data:"))data.push(s.slice(5).trimStart());};
      for await(const chunk of response.body??[]){bytes+=chunk.length;if(bytes>32*1024*1024)fail("LibreChat stream exceeds its limit",502);buffer+=decoder.decode(chunk,{stream:true});if(buffer.length>2*1024*1024)fail("LibreChat event exceeds its limit",502);let end;while((end=buffer.indexOf("\n"))>=0){line(buffer.slice(0,end).replace(/\r$/u,""));buffer=buffer.slice(end+1);}}
      if(buffer)line(buffer);line("");
    };
    if(response.headers.get("content-type")?.includes("application/json")){
      const ack=await boundedJson(response);
      chatId=ack.conversationId??ack.streamId;
      if(typeof chatId!=="string" || !chatId)fail("LibreChat did not acknowledge a native conversation",502);
      this.ctx.nativeSession(chatId);
      // The saved chat is authoritative even if the resumable SSE subscription ends after persistence.
      const stream=await this.remote.config.userRequest(`/agents/chat/stream/${encodeURIComponent(ack.streamId??chatId)}${ack.generationCreatedAt?`?generationCreatedAt=${ack.generationCreatedAt}`:""}`,undefined,"GET",this.abort.signal);
      await consume(stream);
    }else await consume(response);
    if(!chatId || !final)fail("LibreChat stream ended before completion; inspect the remote chat before retrying",502);
    const saved=await this.remote.snapshot(chatId);
    if(saved.messages.at(-1)?.role!=="assistant" || saved.messages.at(-1)?.done!==true)fail("LibreChat response was not persisted",502);
    this.ctx.emit({type:"message.part",payload:{text:saved.messages.at(-1)!.content}});
    this.ctx.emit({type:"turn.status",payload:{status:"completed"}});
  }
  async interrupt():Promise<void>{fail("Acknowledged LibreChat cancellation is unavailable through this adapter",422);}
  async compact():Promise<unknown>{return fail("Manual compaction is unavailable",422);}
  async inspect(subject:string):Promise<unknown>{if(subject==="history" && this.ctx.session.nativeSessionId){const {native,...snapshot}=await this.remote.snapshot(this.ctx.session.nativeSessionId);return snapshot;}return fail("Inspection is unavailable",422);}
  async configure():Promise<unknown>{return fail("Configure the connection from the harness picker",422);}
  async native():Promise<unknown>{return fail("Native operation is unavailable",422);}
  close(){this.abort.abort();}
}
