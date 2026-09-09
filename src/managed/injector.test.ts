import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionJournal } from "./journal.js";
import { ManagedCredentialInjector } from "./injector.js";
import { managedProviderRequest } from "./request.js";
import { executionBodyDigest, signExecutionGrant, type ExecutionGrant } from "./authorization.js";
const keys=generateKeyPairSync("ed25519");
function fixture() {
 const originalBody=Buffer.from(JSON.stringify({model:"public",input:"hello",max_output_tokens:8}));
 const grant:ExecutionGrant={version:1,audience:"multivibe-core-managed",attemptId:"a",reservationId:"r",routeVersionId:"v",
 providerId:"mistral",credentialRef:"account",model:"public",upstreamModel:"upstream",operation:"responses",stream:false,
 bodySha256:executionBodyDigest(originalBody),maximumOutputTokens:8,issuedAt:1000,expiresAt:61000};
 return {body:managedProviderRequest(grant,originalBody),authorization:{token:signExecutionGrant(grant,keys.privateKey,1000),originalBody}};
}
test("injector fences concurrent dispatch and restart independently of Core",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"injector-fence-"));
 try {
  let calls=0;
  const options={verificationKey:keys.publicKey,journal:new ExecutionJournal(directory),maximumRequestBytes:10000,
   executionTimeoutMs:1000,clock:()=>1001,accounts:[{providerId:"mistral",credentialRef:"account",models:new Set(["upstream"]),
    async chatCompletions(){calls++;return new Response("ok",{headers:{"x-provider-secret":"hidden","content-type":"text/plain"}});}}]};
  const f=fixture(),injector=new ManagedCredentialInjector(options);
  const results=await Promise.allSettled([injector.execute(f.body,f.authorization),injector.execute(f.body,f.authorization)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(calls,1);
  const response=results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<Response>;
  assert.equal(response.value.headers.get("x-provider-secret"),null);
  assert.equal(await response.value.text(),"ok");
  await assert.rejects(new ManagedCredentialInjector({...options,journal:new ExecutionJournal(directory)}).execute(f.body,f.authorization),/already_claimed/);
  assert.equal(calls,1);
 } finally {await rm(directory,{recursive:true,force:true});}
});
test("injector never reads a credential for invalid requests and never retries ambiguous dispatch",async()=>{
 let claims=0,calls=0;
 const f=fixture();
 const injector=new ManagedCredentialInjector({verificationKey:keys.publicKey,maximumRequestBytes:10000,executionTimeoutMs:1000,
  clock:()=>1001,journal:{async claim(){if(claims++)throw Error("claimed");}},
  accounts:[{providerId:"mistral",credentialRef:"account",models:new Set(["upstream"]),async chatCompletions(){calls++;throw Error("credential-detail");}}]});
 await assert.rejects(injector.execute(Buffer.from('{}'),f.authorization),/provider_body_mismatch/);
 assert.equal(claims,0);assert.equal(calls,0);
 await assert.rejects(injector.execute(f.body,f.authorization),/^Error: injector_execution_uncertain$/);
 await assert.rejects(injector.execute(f.body,f.authorization),/claimed/);
 assert.equal(calls,1);
});
test("injector rechecks expiry after durable persistence",async()=>{
 let now=1001,calls=0;
 const f=fixture();
 const injector=new ManagedCredentialInjector({verificationKey:keys.publicKey,maximumRequestBytes:10000,executionTimeoutMs:1000,
 clock:()=>now,journal:{async claim(){now=61000;}},accounts:[{providerId:"mistral",credentialRef:"account",models:new Set(["upstream"]),
 async chatCompletions(){calls++;return new Response();}}]});
 await assert.rejects(injector.execute(f.body,f.authorization),/invalid_execution_grant/);
 assert.equal(calls,0);
});
