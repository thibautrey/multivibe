import { randomUUID } from "node:crypto";
import type { ConversationHarnessRun, ConversationHarnessResult } from "../conversation-harnesses.js";
import type { HostHarnessRuntime } from "./runtime.js";
import { fail } from "./types.js";

/** Compatibility clients receive cumulative text; their display connection never owns the turn. */
export async function legacyHarnessRun(runtime:HostHarnessRuntime,input:ConversationHarnessRun,signal:AbortSignal,update:(text:string)=>void):Promise<ConversationHarnessResult> {
  if(signal.aborted)throw new DOMException("Display disconnected","AbortError");
  if(!/^[0-9a-f-]{36}$/iu.test(input.conversationId))fail("Invalid conversation identifier");
  const sessionId=input.conversationId.toLowerCase();
  const existing=runtime.store.sessions().find(s=>s.id===sessionId);
  if(input.sessionId && input.sessionId!==existing?.nativeSessionId)fail("Import this older native session in Desktop before continuing it",409);
  const session=await runtime.create({id:sessionId,harnessId:input.harnessId,authMode:"multivibe",model:input.model});
  if(session.model!==input.model){const change=await runtime.command(session.id,{id:randomUUID(),type:"configure",value:{model:input.model,...(input.harnessId==="pi"?{provider:"multivibe"}:{})}});if(change.state!=="completed")fail(change.error??"Change the model between turns",409);}
  const id=randomUUID();const parts=new Map<string,string>();
  return new Promise((resolve,reject)=>{
    let off=()=>{};let settled=false;
    const done=(error?:Error)=>{if(settled)return;settled=true;off();signal.removeEventListener("abort",abort);if(error)reject(error);else resolve({text:[...parts.values()].join("\n\n"),sessionId:runtime.session(session.id).nativeSessionId});};
    const abort=()=>done(new DOMException("Display disconnected; the Host keeps supervising this turn","AbortError"));
    off=runtime.subscribe(session.id,event=>{
      if(event.turnId!==id)return;const payload=event.payload as any;
      if(event.type==="message.delta" || event.type==="message.part"){
        const key=event.itemId??"assistant";parts.set(key,event.type==="message.part"?payload.text??"":(parts.get(key)??"")+(payload.text??""));update([...parts.values()].join("\n\n"));
      }else if(payload?.commandId===id && ["turn.completed","turn.failed","turn.cancelled","turn.uncertain"].includes(event.type))done(event.type==="turn.completed"?undefined:new Error(payload.error??`Harness turn ${event.type.slice(5)}; inspect the session before retrying`));
    });
    signal.addEventListener("abort",abort,{once:true});
    if(signal.aborted){abort();return;}
    void runtime.command(session.id,{id,type:"prompt",parts:[{type:"text",text:input.prompt}]}).catch(done);
  });
}
