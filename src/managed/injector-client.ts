import { request } from "node:https";
import type { ManagedInvocationAuthorization } from "./executor.js";
import type {ExecutionReceipt} from "./journal.js";
import {validateExecutionOwnership, type ExecutionOwnership} from "./coordination-client.js";

/** Core-side transport: only workload TLS keys, never provider API credentials. */
export class ManagedInjectorClient {
  private readonly base: URL;
  constructor(baseUrl:string,private readonly tls:{ca:Buffer;cert:Buffer;key:Buffer},
    private readonly maximumRequestBytes:number,private readonly maximumResponseBytes:number,
    private readonly timeoutMs:number) {
    this.base=new URL(baseUrl);
    if(this.base.protocol!=="https:"||this.base.username||this.base.password||this.base.pathname!=="/"
      ||this.base.search||this.base.hash||!tls.ca.length||!tls.cert.length||!tls.key.length
      ||[maximumRequestBytes,maximumResponseBytes,timeoutMs].some(v=>!Number.isSafeInteger(v)||v<1))throw Error("invalid_injector_client");
  }
  execute(body:Uint8Array,signal:AbortSignal,authorization:ManagedInvocationAuthorization):Promise<Response> {
    if(body.byteLength>this.maximumRequestBytes||authorization.originalBody.byteLength>this.maximumRequestBytes
      ||authorization.token.length>8192||/[\r\n]/.test(authorization.token))throw Error("invalid_injector_request");
    const envelope=JSON.stringify({originalBodyBase64:Buffer.from(authorization.originalBody).toString("base64"),
      ownership:validateExecutionOwnership(authorization.ownership),providerBodyBase64:Buffer.from(body).toString("base64")});
    return this.open("/internal/v1/inject",signal,envelope,authorization.token);
  }
  async finish(token:string,ownership:ExecutionOwnership,receipt:ExecutionReceipt):Promise<void> {
    const envelope=JSON.stringify({ownership:validateExecutionOwnership(ownership),receipt});
    if(Buffer.byteLength(envelope)>16384)throw Error("injector_receipt_too_large");
    const response=await this.open("/internal/v1/receipts",AbortSignal.timeout(this.timeoutMs),envelope,token);
    let result:unknown;
    try{result=JSON.parse(await response.text());}catch{throw Error("injector_receipt_response_invalid");}
    if(!result||typeof result!=="object"||Array.isArray(result)||Object.keys(result).join()!=="ok"
      ||(result as {ok?:unknown}).ok!==true)throw Error("injector_receipt_response_invalid");
  }
  async discovery():Promise<unknown> {
    const response=await this.open("/internal/v1/providers/discovery",AbortSignal.timeout(this.timeoutMs));
    return JSON.parse(await response.text());
  }
  private open(path:string,signal:AbortSignal,envelope?:string,token?:string):Promise<Response> {
    return new Promise((resolve,reject)=>{
      const req=request(new URL(path,this.base),{...this.tls,method:envelope ? "POST" : "GET",minVersion:"TLSv1.3",rejectUnauthorized:true,
        signal:AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]),headers:{"content-type":"application/json",
          ...(token ? {"x-multivibe-execution-grant":token} : {})}},res=>{
        if(!res.statusCode||res.statusCode<200||res.statusCode>=300){res.destroy();reject(Error("injector_execution_unavailable"));return;}
        const iterator=res[Symbol.asyncIterator]();let bytes=0;
        const stream=new ReadableStream<Uint8Array>({
          async pull(controller){
            try{
              const next=await iterator.next();
              if(next.done){controller.close();return;}
              bytes+=next.value.byteLength;
              if(bytes>maximum)throw Error("response_limit");
              controller.enqueue(new Uint8Array(next.value));
            }catch{res.destroy();controller.error(Error("injector_response_unavailable"));}
          },
          cancel(){res.destroy();},
        });
        const maximum=this.maximumResponseBytes;
        resolve(new Response(stream,{status:res.statusCode,headers:{"content-type":String(res.headers["content-type"]??"application/octet-stream")}}));
      });
      req.on("error",()=>reject(Error("injector_connection_unavailable")));
      req.end(envelope);
    });
  }
}
