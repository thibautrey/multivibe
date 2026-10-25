/** SSH stdio entrypoint. The persistent Host uses a private Unix socket; no token crosses SSH. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import express from "express";
import { HostHarnessIntegrationManager } from "../harness-integrations.js";
import { HostHarnessRuntime } from "./runtime.js";
import { harnessRuntimeRoutes } from "./routes.js";
import { redact } from "./types.js";

const root=process.env.MULTIVIBE_HARNESS_STATE_DIRECTORY??path.join(os.homedir(),".local/state/multivibe/harness-runtime");
const preferredSocket=path.join(root,"bridge.sock");
const socket=Buffer.byteLength(preferredSocket)>100?path.join(os.tmpdir(),`mvh-${createHash("sha256").update(root).digest("hex").slice(0,16)}.sock`):preferredSocket;
async function call(method:string,route:string,body?:unknown):Promise<{status:number;body:unknown}> {
  if(!["GET","POST","PATCH","DELETE"].includes(method) || !route.startsWith("/") || route.includes(".."))throw new Error("Invalid bridge request");
  return new Promise((resolve,reject)=>{
    const request=http.request({socketPath:socket,path:route,method,headers:{"content-type":"application/json"}},response=>{const parts:Buffer[]=[];let bytes=0;response.on("data",(c:Buffer)=>{bytes+=c.length;if(bytes>32*1024*1024){request.destroy(new Error("Bridge response exceeds limit"));return;}parts.push(c);});response.on("end",()=>{try{resolve({status:response.statusCode??500,body:JSON.parse(Buffer.concat(parts).toString())});}catch{reject(new Error("Invalid Host response"));}});});
    request.setTimeout(60_000,()=>request.destroy(new Error("Remote Host request timed out")));request.on("error",reject);request.end(body===undefined?undefined:JSON.stringify(body));
  });
}
async function daemon() {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(fs.existsSync(socket)){try{await call("GET","/targets");return;}catch(e:any){if(!["ECONNREFUSED","ENOENT"].includes(e.code))throw e;if(fs.lstatSync(socket).isSocket())fs.unlinkSync(socket);else throw new Error("Bridge socket path is not a socket");}}
  const integrations=new HostHarnessIntegrationManager({homeDirectory:os.homedir(),statePath:path.join(root,"integrations.json"),baseUrl:process.env.MULTIVIBE_HARNESS_MODEL_BASE_URL??"http://127.0.0.1:1455"});
  const runtime=new HostHarnessRuntime(root,integrations);const app=express();app.use(harnessRuntimeRoutes(runtime));
  const pidFile=path.join(root,"daemon.pid");
  const server=app.listen(socket,()=>{fs.chmodSync(socket,0o600);fs.writeFileSync(pidFile,String(process.pid),{mode:0o600});});server.on("error",()=>process.exitCode=1);
  const stop=async()=>{server.close();await runtime.close();for(const file of [socket,pidFile])try{fs.unlinkSync(file);}catch{}};
  process.once("SIGTERM",()=>void stop());process.once("SIGINT",()=>void stop());
}
async function bridge() {
  try{await call("GET","/targets");}catch(e:any){
    if(!["ENOENT","ECONNREFUSED"].includes(e.code))throw e;
    fs.mkdirSync(root,{recursive:true,mode:0o700});const child=spawn(process.execPath,[fileURLToPath(import.meta.url),"--daemon"],{detached:true,stdio:"ignore",env:process.env});child.unref();
    let ready=false;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));try{await call("GET","/targets");ready=true;break;}catch{}}
    if(!ready)throw new Error("The remote harness Host could not start; verify Node.js and the installed MultiVibe runtime");
  }
  let bufferBytes=0;
  for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
    bufferBytes=Buffer.byteLength(line);if(bufferBytes>25*1024*1024)throw new Error("Bridge input exceeds limit");
    let request:any;try{request=JSON.parse(line);}catch{continue;}
    if(request.method!=="request")continue;
    void call(request.params.method,request.params.route,request.params.body).then(result=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\n"),error=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32603,message:redact(error.message)}})+"\n"));
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  (process.argv.includes("--daemon")?daemon():bridge()).catch(error=>{process.stderr.write(String(redact(error.message))+"\n");process.exitCode=1;});
}
