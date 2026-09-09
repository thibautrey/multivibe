import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { createManagedInjectorServer } from "./injector-http.js";

test("injector mTLS enforces Core identity, bounded envelope and sanitized streaming response",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"injector-tls-"));
 let server:ReturnType<typeof createManagedInjectorServer>|undefined;
 try {
  const openssl=(args:string[])=>execFileSync("openssl",args,{cwd:dir,stdio:"ignore"});
  openssl(["req","-x509","-newkey","rsa:2048","-nodes","-keyout","ca.key","-out","ca.crt","-days","1","-subj","/CN=fixture-ca"]);
  for(const [name,san] of [["server","DNS:localhost"],["core","URI:spiffe://multivibe/core"],["other","URI:spiffe://multivibe/other"]]){
   openssl(["req","-newkey","rsa:2048","-nodes","-keyout",`${name}.key`,"-out",`${name}.csr`,"-subj",`/CN=${name}`]);
   await writeFile(join(dir,`${name}.ext`),`subjectAltName=${san}\nextendedKeyUsage=serverAuth,clientAuth\n`);
   openssl(["x509","-req","-in",`${name}.csr`,"-CA","ca.crt","-CAkey","ca.key","-CAcreateserial","-out",`${name}.crt`,"-days","1","-extfile",`${name}.ext`]);
  }
  const ca=await readFile(join(dir,"ca.crt"));let calls=0;
  server=createManagedInjectorServer({tls:{ca,key:await readFile(join(dir,"server.key")),cert:await readFile(join(dir,"server.crt"))},
   allowedCoreUri:"spiffe://multivibe/core",maximumRequestBytes:128,maximumResponseBytes:128,maximumConcurrentExecutions:1,
   injector:{async execute(body,authorization){calls++;assert.equal(Buffer.from(body).toString(),"provider");
    assert.equal(Buffer.from(authorization.originalBody).toString(),"original");assert.equal(authorization.token,"signed-fixture");
    return new Response("data: hello\n\n",{headers:{"content-type":"text/event-stream","x-secret":"not-forwarded"}});}}});
  await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const port=address.port;
  const send=async(name:string,body:string)=>{
   const cert=await readFile(join(dir,`${name}.crt`)),key=await readFile(join(dir,`${name}.key`));
   return new Promise<{status:number|undefined;body:string;secret:unknown}>((resolve,reject)=>{
    const req=request({host:"127.0.0.1",port,servername:"localhost",path:"/internal/v1/inject",method:"POST",ca,cert,key,
     headers:{"content-type":"application/json","x-multivibe-execution-grant":"signed-fixture"}},res=>{
      const chunks:Buffer[]=[];res.on("data",chunk=>chunks.push(chunk));res.on("error",reject);
      res.on("end",()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),secret:res.headers["x-secret"]}));
     });req.on("error",reject);req.end(body);
   });
  };
  const envelope=JSON.stringify({originalBodyBase64:Buffer.from("original").toString("base64"),providerBodyBase64:Buffer.from("provider").toString("base64")});
  assert.equal((await send("other",envelope)).status,403);assert.equal(calls,0);
  assert.equal((await send("core",JSON.stringify({originalBodyBase64:"!!!",providerBodyBase64:"!!!"}))).status,502);assert.equal(calls,0);
  assert.equal((await send("core","x".repeat(2000))).status,413);assert.equal(calls,0);
  assert.deepEqual(await send("core",envelope),{status:200,body:"data: hello\n\n",secret:undefined});assert.equal(calls,1);
 } finally {
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  await rm(dir,{recursive:true,force:true});
 }
});
