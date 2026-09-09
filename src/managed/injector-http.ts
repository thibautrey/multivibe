import { createServer, type ServerOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import type { ManagedCredentialInjector } from "./injector.js";
import type {ExecutionReceipt} from "./journal.js";
import {validateExecutionOwnership, type ExecutionOwnership} from "./coordination-client.js";
import type {ExecutionRecoveryEnvelope} from "./response-recovery.js";

/** Private credential-injector endpoint; never publish through the public ingress. */
export function createManagedInjectorServer(options: {
  tls: Pick<ServerOptions,"key"|"cert"|"ca">;
  allowedCoreUri: string;
  injector: Pick<ManagedCredentialInjector,"execute">;
  coordination: {finish(token:string,ownership:ExecutionOwnership,receipt:ExecutionReceipt,recovery?:ExecutionRecoveryEnvelope):Promise<void>};
  discovery?: {read():Promise<unknown>};
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  maximumConcurrentExecutions: number;
}) {
  if (!options.allowedCoreUri.startsWith("spiffe://") || !options.tls.key || !options.tls.cert || !options.tls.ca
    || [options.maximumRequestBytes,options.maximumResponseBytes,options.maximumConcurrentExecutions]
      .some(value=>!Number.isSafeInteger(value)||value<1)) throw Error("invalid_injector_server_configuration");
  let active=0;
  const server=createServer({...options.tls,requestCert:true,rejectUnauthorized:true,minVersion:"TLSv1.3"},async(req,res)=>{
    const fail=(status:number,code:string)=>{
      if(res.headersSent){res.destroy();return;}
      res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({error:{code}}));
    };
    const socket=req.socket as TLSSocket;
    if(!socket.authorized || !socket.getPeerCertificate().subjectaltname?.split(", ").includes(`URI:${options.allowedCoreUri}`)) {
      fail(403,"workload_forbidden");return;
    }
    if(req.method==="GET"&&req.url==="/internal/v1/providers/discovery"&&options.discovery){
      try{res.setHeader("content-type","application/json");res.setHeader("cache-control","no-store");res.end(JSON.stringify(await options.discovery.read()));}
      catch{fail(503,"provider_discovery_unavailable");}return;
    }
    if(req.method==="GET"&&req.url==="/health/live"){res.end('{"ok":true}');return;}
    if(req.method!=="POST"||!["/internal/v1/inject","/internal/v1/receipts"].includes(req.url??"")){fail(404,"not_found");return;}
    if(active>=options.maximumConcurrentExecutions){fail(503,"injector_busy");return;}
    const token=req.headers["x-multivibe-execution-grant"];
    if(typeof token!=="string"||token.length>8192){fail(403,"execution_grant_required");return;}
    if(req.headers["content-type"]!=="application/json"||req.headers["content-encoding"]){fail(415,"unsupported_body");return;}
    active++;
    try {
      const chunks:Buffer[]=[];let length=0;
      const envelopeLimit=req.url==="/internal/v1/receipts"?Math.ceil(options.maximumResponseBytes*4/3)+32768:Math.ceil(options.maximumRequestBytes*8/3)+1024;
      for await(const chunk of req){
        const bytes=Buffer.from(chunk);length+=bytes.byteLength;
        if(length>envelopeLimit){fail(413,"request_too_large");return;}chunks.push(bytes);
      }
      const envelope=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if(!envelope||typeof envelope!=="object"||Array.isArray(envelope))throw Error("invalid_envelope");
      if(req.url==="/internal/v1/receipts"){
        if(Object.keys(envelope).sort().join()!=="ownership,receipt,recovery")throw Error("invalid_envelope");
        await options.coordination.finish(token,validateExecutionOwnership(envelope.ownership),envelope.receipt as ExecutionReceipt,
          envelope.recovery===null?undefined:envelope.recovery as ExecutionRecoveryEnvelope);
        res.end('{"ok":true}');return;
      }
      if(Object.keys(envelope).sort().join()!=="originalBodyBase64,ownership,providerBodyBase64")throw Error("invalid_envelope");
      const decode=(value:unknown)=>{
        if(typeof value!=="string")throw Error("invalid_envelope");
        const bytes=Buffer.from(value,"base64");
        if(bytes.length>options.maximumRequestBytes||bytes.toString("base64")!==value)throw Error("invalid_envelope");
        return bytes;
      };
      const response=await options.injector.execute(decode(envelope.providerBodyBase64),{token,
        originalBody:decode(envelope.originalBodyBase64),ownership:validateExecutionOwnership(envelope.ownership)});
      res.writeHead(response.status,{"content-type":response.headers.get("content-type")??"application/octet-stream","cache-control":"no-store"});
      const reader=response.body?.getReader();
      if(!reader){res.end();return;}
      let total=0;
      try {
        for(;;){
          const next=await reader.read();if(next.done)break;
          total+=next.value.byteLength;
          if(total>options.maximumResponseBytes)throw Error("response_too_large");
          // Keep draining a bounded provider response after Core disconnects. The
          // injector claim stays consumed; an incomplete Core receipt is uncertain.
          if(!res.destroyed&&!res.write(next.value))await new Promise<void>(resolve=>{
            const done=()=>{res.off("drain",done);res.off("close",done);resolve();};
            res.once("drain",done);res.once("close",done);
          });
        }
        if(!res.destroyed)res.end();
      } catch(error){await reader.cancel().catch(()=>undefined);throw error;}
      finally{reader.releaseLock();}
    } catch {fail(502,"injector_execution_unavailable");}
    finally{active--;}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=32;
  return server;
}
