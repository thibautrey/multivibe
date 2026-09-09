import {createAnthropicCodec} from "../ai-sdk/anthropic-model.js";
import {sdkCallOptions,chatResult,chatStream} from "../ai-sdk/protocol.js";
import type {LanguageModelV4Usage} from "@ai-sdk/provider";
import type {ManagedProviderAccount} from "./executor.js";

/** Validate native financial evidence before the shared SDK presentation codec.
 * SDK totals can deliberately exclude advisor or other separately priced work. */
export function nativeAnthropicUsageEligible(usage:LanguageModelV4Usage):boolean {
 const raw=usage.raw;
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return false;
 const allowed=new Set(["input_tokens","output_tokens","cache_creation_input_tokens","cache_read_input_tokens",
  "output_tokens_details","iterations","server_tool_use","service_tier","cache_creation","inference_geo"]);
 if(Object.keys(raw).some(key=>!allowed.has(key)))return false;
 const count=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
 if(!count(raw.input_tokens)||!count(raw.output_tokens))return false;
 for(const key of ["cache_creation_input_tokens","cache_read_input_tokens"]){
  if(raw[key]!==undefined&&raw[key]!==null&&!count(raw[key]))return false;
 }
 if(raw.iterations!=null&&(!Array.isArray(raw.iterations)||raw.iterations.length!==0))return false;
 if(raw.service_tier!==undefined&&raw.service_tier!=="standard")return false;
 if(raw.server_tool_use!=null&&(typeof raw.server_tool_use!=="object"||Array.isArray(raw.server_tool_use)
  ||Object.values(raw.server_tool_use).some(value=>value!==0)))return false;
 const cacheRead=Number(raw.cache_read_input_tokens??0),cacheWrite=Number(raw.cache_creation_input_tokens??0);
 const total=raw.input_tokens+cacheRead+cacheWrite;
 return Number.isSafeInteger(total)&&usage.inputTokens.total===total&&usage.outputTokens.total===raw.output_tokens
  &&(usage.inputTokens.cacheRead??0)===cacheRead&&(usage.inputTokens.cacheWrite??0)===cacheWrite;
}

/** Native codec reuse inside the credential injector only. This connector does
 * not activate a route or grant authority: the injector must authorize and fence
 * the original Cloud request before invoking it. No desktop router is imported. */
export function createManagedAnthropicAccount(options:{
 credentialRef:string;models:ReadonlySet<string>;maximumResponseBytes:number;
 readCredential:()=>Promise<string>;fetchViaEgress:typeof fetch;
}):ManagedProviderAccount {
 const models=new Set(options.models);
 if(!options.credentialRef||models.size>10000||!Number.isSafeInteger(options.maximumResponseBytes)||options.maximumResponseBytes<1)throw Error("invalid_managed_account");
 return {providerId:"anthropic",credentialRef:options.credentialRef,models,
 async chatCompletions(bytes,signal,authorization){
  const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  if(!models.has(body.model)||!Number.isSafeInteger(body.max_tokens)||body.max_tokens<1
   ||(body.n!==undefined&&body.n!==1)||(body.stream!==undefined&&typeof body.stream!=="boolean"))throw Error("invalid_native_managed_request");
  // These options can introduce separately priced operations or provider-owned
  // execution. Enable them only with matching grant and price semantics.
  for(const key of ["provider_options","tools","tool_choice","audio","modalities","service_tier"]){
   if(body[key]!==undefined)throw Error("unsupported_native_managed_option");
  }
  if(!Array.isArray(body.messages)||body.messages.some((message:unknown)=>!message||typeof message!=="object"
   ||"provider_options" in message||!("content" in message)||typeof message.content!=="string"||!("role" in message)
   ||!["user","assistant","system","developer"].includes(String(message.role))))throw Error("native_managed_text_required");
  let dispatched=false;
  const guardedFetch:typeof fetch=async(input,init)=>{
   if(dispatched)throw Error("native_managed_single_attempt_required");
   if(String(input)!=="https://api.anthropic.com/v1/messages"||init?.method!=="POST"||typeof init.body!=="string")throw Error("native_managed_destination_invalid");
   const native=JSON.parse(init.body);
   if(native.model!==body.model||native.max_tokens!==body.max_tokens||(native.stream??false)!==(body.stream??false))throw Error("native_managed_projection_invalid");
   // Fence before credential access; neither SDK retries nor parser failures can
   // obtain another provider invocation within this attempt.
   dispatched=true;
   signal.throwIfAborted();
   const credential=await options.readCredential();
   if(!credential||credential.length>16384||/[\r\n]/.test(credential))throw Error("managed_credential_unavailable");
   signal.throwIfAborted();
   const headers=new Headers(init.headers);
   headers.delete("authorization");headers.set("x-api-key",credential);
   await authorization.beforeDispatch?.();
   const response=await options.fetchViaEgress(input,{...init,headers,signal,redirect:"error"});
   const reader=response.body?.getReader();
   if(!reader)return response;
   let received=0;
   // Bound raw provider bytes before the SDK buffers/parses them. The outer
   // managed response bound applies after conversion and cannot protect this.
   return new Response(new ReadableStream<Uint8Array>({
    async pull(controller){try{
     const next=await reader.read();
     if(next.done){controller.close();reader.releaseLock();return;}
     received+=next.value.byteLength;
     if(received>options.maximumResponseBytes){await reader.cancel();reader.releaseLock();throw Error("native_managed_response_too_large");}
     controller.enqueue(next.value);
    }catch(error){controller.error(error);}},
    async cancel(){await reader.cancel();reader.releaseLock();}
   }),{status:response.status,headers:response.headers});
  };
  // A nonsecret placeholder prevents the SDK from consulting ambient keys.
  // Only the fixed guarded fetch can replace it with an actual credential.
  const model=createAnthropicCodec(body.model,"managed-placeholder","https://api.anthropic.com/v1",guardedFetch);
  const params=sdkCallOptions(body,signal);
  if(!body.stream){
   const result=chatResult(body.model,await model.doGenerate(params),nativeAnthropicUsageEligible);
   const {provider_metadata:_,...publicResult}=result;
   return Response.json(publicResult);
  }
  const result=await model.doStream(params);
  const iterator=chatStream(body.model,result.stream,true,nativeAnthropicUsageEligible);
  return new Response(new ReadableStream<Uint8Array>({
   async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(Buffer.from(next.value));}catch(error){controller.error(error);}},
   async cancel(){await iterator.return(undefined);}
  }),{headers:{"content-type":"text/event-stream"}});
 }};
}
