/** Execution inside an isolated credential process. The caller owns account
 * authorization, model grants, concurrency and credential persistence. */
import {createAnthropicCodec} from './ai-sdk/anthropic-model.js';
import {createOpenAICompatibleModel} from './ai-sdk/transports/openai-compatible.js';
import {sdkCallOptions, chatResult, chatStream} from './ai-sdk/protocol.js';
import {providerCredentialEndpoint} from './team-api-key-validation.js';
import {decodeTeamProviderCredential, type TeamProviderCredential} from './team-provider-credential.js';
import {buildCopilotHeaders} from './github-copilot.js';
import {openCodeAccountHeaders,openCodeInferenceToken} from './opencode.js';
import {chatCompletionsToResponsesPayload} from './responses/payloads.js';
import {createResponsesToChatCompletionStreamState,convertResponsesSSEToChatCompletionSSE,finalizeResponsesSSEToChatCompletionSSE,responseObjectToChatCompletion} from './responses/converters.js';

export interface PersonalProviderExecution {
  provider:string;
  endpoint:string;
  credential:TeamProviderCredential;
  body:Record<string,unknown>;
}

/** No implicit global fetch, retries, arbitrary endpoints or provider diagnostics. */
export async function executePersonalProviderChat(input:PersonalProviderExecution, transport:typeof fetch, signal:AbortSignal):Promise<Response> {
  try {
    const account = decodeTeamProviderCredential(input.credential,input.provider,input.endpoint);
    const body=input.body;
    const accepted=new Set(['model','messages','stream','max_tokens','max_completion_tokens','temperature','top_p','tools','tool_choice','response_format','stream_options']);
    if(!body||Array.isArray(body)||Object.keys(body).some(key=>!accepted.has(key))
      ||typeof body.model!=='string'||!body.model||body.model.length>512
      ||(body.stream!==undefined&&typeof body.stream!=='boolean')
      ||Buffer.byteLength(JSON.stringify(body))>256*1024)throw Error('invalid');
    const tokens=body.max_completion_tokens??body.max_tokens??4096;
    if(!Number.isSafeInteger(tokens)||(tokens as number)<1||(tokens as number)>32768)throw Error('invalid');
    const controller=new AbortController();
    const boundedSignal=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(120_000)]);
    let dispatched=false;
    const guarded:typeof fetch=async(url,init)=>{
      if(dispatched)throw Error('already_dispatched');
      dispatched=true;
      const response=await transport(url,{...init,redirect:'error',signal:boundedSignal});
      // Never pass an upstream error body to a public layer: it may echo secrets.
      if(!response.ok){await response.body?.cancel();throw Error('upstream_failed');}
      if(!response.body)throw Error('empty');
      let bytes=0;
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
        transform(chunk,out){bytes+=chunk.byteLength;if(bytes>8*1024*1024){controller.abort();throw Error('too_large');}out.enqueue(chunk);},
      })),{status:response.status,headers:response.headers});
    };
    if(account.provider!=='ai-sdk'){
      const mode=account.provider==='github-copilot'?account.copilotModelEndpoints?.[body.model]??account.upstreamMode:account.upstreamMode;
      if(mode!=='responses'&&mode!=='chat/completions')throw Error('unsupported');
      const responses=mode==='responses',payload=responses?chatCompletionsToResponsesPayload({...body,stream:Boolean(body.stream)}):{...body,max_tokens:tokens};
      const endpoint=account.provider==='openai'?'https://chatgpt.com/backend-api/codex/responses':`${input.endpoint}/${responses?'responses':'chat/completions'}`;
      const headers:Record<string,string>=account.provider==='github-copilot'?buildCopilotHeaders(account.accessToken,payload,body.stream?'text/event-stream':'application/json'):
        {'content-type':'application/json',accept:body.stream?'text/event-stream':'application/json',authorization:`Bearer ${account.provider==='opencode'?openCodeInferenceToken(account):account.accessToken}`,
          ...(account.provider==='openai'&&account.chatgptAccountId?{'chatgpt-account-id':account.chatgptAccountId}:{}),
          ...(account.provider==='opencode'?openCodeAccountHeaders(account):{})};
      const upstream=await guarded(endpoint,{method:'POST',headers,body:JSON.stringify(payload)});
      if(!responses)return new Response(upstream.body,{headers:{'content-type':body.stream?'text/event-stream':'application/json','cache-control':'no-store'}});
      if(!body.stream){const value=await upstream.json();return Response.json(responseObjectToChatCompletion(value,body.model),{headers:{'cache-control':'no-store'}});}
      const state=createResponsesToChatCompletionStreamState(body.model),decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='';
      const converted=upstream.body!.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
        transform(chunk,out){buffer+=decoder.decode(chunk,{stream:true});const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop()??'';for(const frame of frames){const value=convertResponsesSSEToChatCompletionSSE(frame,state);if(value)out.enqueue(encoder.encode(value));}},
        flush(out){buffer+=decoder.decode();if(buffer.trim()){const value=convertResponsesSSEToChatCompletionSSE(buffer,state);if(value)out.enqueue(encoder.encode(value));}const last=finalizeResponsesSSEToChatCompletionSSE(state);if(last)out.enqueue(encoder.encode(last));},
      }));
      return new Response(converted,{headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
    }
    const endpoint=providerCredentialEndpoint(input.provider);
    const model=input.provider==='anthropic'
      ?createAnthropicCodec(body.model,account.accessToken,endpoint,guarded)
      :createOpenAICompatibleModel({provider:input.provider,modelId:body.model,apiKey:account.accessToken,baseURL:endpoint,fetch:guarded});
    const options=sdkCallOptions({...body,max_completion_tokens:tokens},boundedSignal);
    if(!body.stream)return Response.json(chatResult(body.model,await model.doGenerate(options)),{headers:{'cache-control':'no-store'}});
    const result=await model.doStream(options);
    const iterator=chatStream(body.model,result.stream,true)[Symbol.asyncIterator]();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(out){try{const next=await iterator.next();if(next.done)out.close();else out.enqueue(new TextEncoder().encode(next.value));}
        catch{controller.abort();out.error(new Error('Provider stream interrupted'));}},
      async cancel(){controller.abort();await iterator.return?.(undefined);},
    }),{headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
  } catch {throw new Error('Personal provider request failed');}
}
