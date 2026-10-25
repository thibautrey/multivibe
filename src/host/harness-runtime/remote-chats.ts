import { createHash } from "node:crypto";
import { RemoteChatConfiguration, remoteConnectionId } from "./librechat.js";
import { fail, requiredText } from "./types.js";

export type RemoteMessage={id:string;role:string;content:string;parentId?:string;done:boolean;native?:unknown};
export type RemoteChatSummary={id:string;title:string;updatedAt:number;archived:boolean;pinned:boolean;model?:string;active?:boolean};
export type RemoteChatSnapshot=RemoteChatSummary & {messages:RemoteMessage[];revision:string;endpoint?:string;native:any};
const time=(v:unknown)=>typeof v==="number"?(v<1e12?v*1000:v):typeof v==="string"?Date.parse(v)||0:0;
export function remoteText(value:any):string {
  if(typeof value==="string")return value;
  if(Array.isArray(value))return value.map(remoteText).filter(Boolean).join("\n\n");
  if(!value || typeof value!=="object")return "";
  if(typeof value.text==="string")return value.text;
  if(typeof value.text?.value==="string")return value.text.value;
  if(typeof value.content==="string" || Array.isArray(value.content))return remoteText(value.content);
  if(value.type==="image_url")return `[Image](${value.image_url?.url??""})`;
  if(value.type==="tool_call" || value.tool_call)return JSON.stringify(value.tool_call??value);
  return "";
}
function branch(rows:RemoteMessage[],current?:string):RemoteMessage[]{
  const map=new Map(rows.map(v=>[v.id,v]));
  if(!current)return rows;
  const result:RemoteMessage[]=[],seen=new Set<string>();let id:string|undefined=current;
  while(id && map.has(id)){
    if(seen.has(id))fail("Invalid remote conversation branch",502);seen.add(id);
    const row=map.get(id)!;result.unshift(row);id=row.parentId;
  }
  return result;
}
export class RemoteChats {
  private readonly boundIdentity:string;
  constructor(readonly id:"librechat"|"openwebui",readonly config:RemoteChatConfiguration){this.boundIdentity=remoteConnectionId(config.read()??fail("Configure the remote harness first",409));}
  identity(){const c=this.config.read()??fail("Configure the remote harness first",409);const connectionId=remoteConnectionId(c);if(connectionId!==this.boundIdentity)fail("Reconnect the original remote account",409);return {connectionId,endpoint:c.endpoint};}
  private summary(v:any,archived=false):RemoteChatSummary{
    const id=this.id==="librechat"?v.conversationId:v.id;
    if(typeof id!=="string" || !id || id.length>256)fail("Invalid remote conversation identifier",502);
    return {id,title:typeof v.title==="string"?v.title:"Conversation",updatedAt:time(v.updatedAt??v.updated_at),archived:v.isArchived??v.archived??archived,pinned:v.pinned===true,model:v.agent_id??v.model,active:v.active===true};
  }
  async list(){
    const identity=this.identity(),rows=new Map<string,RemoteChatSummary>();
    for(const archived of [false,true]){
      const cursors=new Set<string>();let cursor="";
      for(let page=1;;page++){
        if(page>500)fail("Remote conversation catalog exceeds the synchronization limit",413);
        const route=this.id==="librechat"?`/convos?limit=100&isArchived=${archived}&cursor=${encodeURIComponent(cursor)}`:`/v1/chats/${archived?"archived":""}?page=${page}&include_pinned=true&include_folders=true`;
        const result=await this.config.json(route);
        const batch=this.id==="librechat"?(result.conversations??result.data):result;
        if(!Array.isArray(batch))fail("Invalid remote conversation catalog",502);
        for(const row of batch){const v=this.summary(row,archived);rows.set(v.id,v);}
        if(this.id==="librechat"){
          const next=result.nextCursor;
          if(!next)break;
          if(typeof next!=="string" || cursors.has(next))fail("Invalid remote conversation cursor",502);
          cursors.add(next);cursor=next;
        }else if(batch.length<60)break;
      }
    }
    // A replacement connection must never apply an old account's in-flight response.
    if(this.identity().connectionId!==identity.connectionId)fail("Remote connection changed during synchronization",409);
    return {...identity,conversations:[...rows.values()],complete:true};
  }
  async snapshot(id:string):Promise<RemoteChatSnapshot>{
    requiredText(id,256);
    const identity=this.identity();let native:any,messages:RemoteMessage[],summary:RemoteChatSummary,endpoint:string|undefined;
    if(this.id==="openwebui"){
      native=await this.config.json(`/v1/chats/${encodeURIComponent(id)}`);
      if(native.id!==id || !native.chat)fail("Invalid Open WebUI conversation",502);
      summary=this.summary(native);const chat=native.chat;
      const source=chat.history?.messages?Object.values(chat.history.messages):chat.messages;
      if(!Array.isArray(source))fail("Invalid Open WebUI conversation history",502);
      messages=branch(source.map((m:any)=>({id:m.id,role:m.role,content:remoteText(m.content)||remoteText(m.output),parentId:m.parentId,done:m.role!=="assistant" || m.done!==false,native:m})),chat.history?.currentId);
      summary.model=chat.models?.[0]??(messages.slice().reverse().find(v=>v.role==="assistant")?.native as any)?.model;
    }else{
      native=await this.config.json(`/convos/${encodeURIComponent(id)}`);
      if(native.conversationId!==id)fail("Invalid LibreChat conversation",502);
      summary=this.summary(native);endpoint=native.endpoint;
      const source=await this.config.json(`/messages/${encodeURIComponent(id)}`);
      if(!Array.isArray(source))fail("Invalid LibreChat message history",502);
      const ordered=source.slice().sort((a:any,b:any)=>time(a.createdAt)-time(b.createdAt));
      messages=branch(ordered.map((m:any)=>({id:m.messageId,role:m.isCreatedByUser?"user":"assistant",content:remoteText(m.content)||m.text||"",parentId:m.parentMessageId,done:!m.unfinished,native:m})),native.lastMessageId??ordered.at(-1)?.messageId);
    }
    if(messages.length>20_000 || messages.some(m=>typeof m.id!=="string" || !m.id || !["user","assistant","system","tool"].includes(m.role)))fail("Invalid remote message history",502);
    if(this.identity().connectionId!==identity.connectionId)fail("Remote connection changed during synchronization",409);
    const value={...summary,messages,endpoint};
    return {...value,revision:createHash("sha256").update(JSON.stringify(value)).digest("hex"),native};
  }
  async update(id:string,input:any){
    const snapshot=await this.snapshot(id); // Ownership and current toggle states are read from the server.
    if(input.title!==undefined){
      const title=requiredText(input.title,200);
      await this.config.json(this.id==="librechat"?"/convos/update":`/v1/chats/${encodeURIComponent(id)}`,this.id==="librechat"?{conversationId:id,title}:{chat:{title}});
    }
    for(const key of ["archived","pinned"] as const){
      if(input[key]===undefined || snapshot[key]===input[key])continue;
      if(typeof input[key]!=="boolean")fail("Invalid remote conversation metadata");
      const operation=key==="archived"?"archive":"pin";
      await this.config.json(this.id==="librechat"?`/convos/${operation}`:`/v1/chats/${encodeURIComponent(id)}/${operation}`,this.id==="librechat"?{arg:{conversationId:id,[key==="archived"?"isArchived":"pinned"]:input[key]}}:{});
    }
    return this.snapshot(id);
  }
  async delete(id:string){
    await this.snapshot(id);
    await this.config.json(this.id==="librechat"?"/convos":`/v1/chats/${encodeURIComponent(id)}`,this.id==="librechat"?{arg:{conversationId:id}}:undefined,"DELETE");
  }
}
