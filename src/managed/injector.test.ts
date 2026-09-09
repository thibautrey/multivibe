import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { ManagedCredentialInjector } from "./injector.js";
import type {ManagedInvocationAuthorization} from "./executor.js";
import { createManagedProviderAccount } from "./provider.js";
import { managedProviderRequest } from "./request.js";
import { executionBodyDigest, signExecutionGrant, type ExecutionGrant } from "./authorization.js";
const keys=generateKeyPairSync("ed25519");
const ownership={ownerId:"11111111-1111-4111-8111-111111111111",epoch:1};
function fixture() {
 const originalBody=Buffer.from(JSON.stringify({model:"public",input:"hello",max_output_tokens:8}));
 const grant:ExecutionGrant={version:2,audience:"multivibe-core-managed",attemptId:"a",reservationId:"r",routeVersionId:"v",
 providerId:"mistral",credentialRef:"account",model:"public",upstreamModel:"upstream",operation:"responses",stream:false,
 bodySha256:executionBodyDigest(originalBody),maximumOutputTokens:8,responseRecoveryKeyId:"test-key",
 responseRecoveryPublicKey:"A5wnJM5Y01mDWCA4MsbAtTGS_l8BI4-JNVWY_KRBH1I",responseRecoveryExpiresAt:120000,issuedAt:1000,expiresAt:61000};
 return {body:managedProviderRequest(grant,originalBody),authorization:{token:signExecutionGrant(grant,keys.privateKey,1000),originalBody,ownership}};
}
test("injector consumes one shared dispatch fence across concurrent replicas",async()=>{
  let calls=0,consumed=false;
  const coordination={async dispatch(){if(consumed)throw Error("fenced");consumed=true;}};
  const options={verificationKey:keys.publicKey,coordination,maximumRequestBytes:10000,
   executionTimeoutMs:1000,clock:()=>1001,accounts:[{providerId:"mistral",credentialRef:"account",models:new Set(["upstream"]),
    async chatCompletions(_body:Uint8Array,_signal:AbortSignal,authorization:ManagedInvocationAuthorization){await authorization.beforeDispatch?.();calls++;
     return new Response("ok",{headers:{"x-provider-secret":"hidden","content-type":"text/plain"}});}}]};
  const f=fixture(),injector=new ManagedCredentialInjector(options);
  const results=await Promise.allSettled([injector.execute(f.body,f.authorization),injector.execute(f.body,f.authorization)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(calls,1);
  const response=results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<Response>;
  assert.equal(response.value.headers.get("x-provider-secret"),null);
  assert.equal(await response.value.text(),"ok");
  await assert.rejects(new ManagedCredentialInjector(options).execute(f.body,f.authorization),/injector_execution_uncertain/);
  assert.equal(calls,1);
});
test("injector never reads a credential for invalid requests and never retries ambiguous dispatch",async()=>{
 let dispatches=0,calls=0;
 const f=fixture();
 const injector=new ManagedCredentialInjector({verificationKey:keys.publicKey,maximumRequestBytes:10000,executionTimeoutMs:1000,
  clock:()=>1001,coordination:{async dispatch(){if(dispatches++)throw Error("fenced");}},
  accounts:[{providerId:"mistral",credentialRef:"account",models:new Set(["upstream"]),async chatCompletions(_body,_signal,authorization){
   await authorization.beforeDispatch?.();calls++;throw Error("credential-detail");}}]});
 await assert.rejects(injector.execute(Buffer.from('{}'),f.authorization),/provider_body_mismatch/);
 assert.equal(dispatches,0);assert.equal(calls,0);
 await assert.rejects(injector.execute(f.body,f.authorization),/^Error: injector_execution_uncertain$/);
 await assert.rejects(injector.execute(f.body,f.authorization),/injector_execution_uncertain/);
 assert.equal(calls,1);
});
test("injector rechecks expiry after durable persistence",async()=>{
 let now=1001,calls=0,dispatches=0;
 const f=fixture();
 const injector=new ManagedCredentialInjector({verificationKey:keys.publicKey,maximumRequestBytes:10000,executionTimeoutMs:1000,
 clock:()=>now,coordination:{async dispatch(){dispatches++;}},accounts:[{providerId:"mistral",credentialRef:"account",models:new Set(["upstream"]),
 async chatCompletions(_body,_signal,authorization){now=61000;await authorization.beforeDispatch?.();calls++;return new Response();}}]});
 await assert.rejects(injector.execute(f.body,f.authorization),/injector_execution_uncertain/);
 assert.equal(dispatches,0);
 assert.equal(calls,0);
});

test("injector independently enforces OpenAI completion projection before credential access",async()=>{
 const originalBody=Buffer.from(JSON.stringify({model:"public",input:"hello",max_output_tokens:8}));
 const grant:ExecutionGrant={version:2,audience:"multivibe-core-managed",attemptId:"openai",reservationId:"r",routeVersionId:"v",
 providerId:"openai",credentialRef:"account",model:"public",upstreamModel:"o3",operation:"responses",stream:false,
 bodySha256:executionBodyDigest(originalBody),maximumOutputTokens:8,responseRecoveryKeyId:"test-key",
 responseRecoveryPublicKey:"A5wnJM5Y01mDWCA4MsbAtTGS_l8BI4-JNVWY_KRBH1I",responseRecoveryExpiresAt:120000,issuedAt:1000,expiresAt:61000};
 const authorization={token:signExecutionGrant(grant,keys.privateKey,1000),originalBody,ownership};
 let calls=0,dispatches=0;
 const injector=new ManagedCredentialInjector({verificationKey:keys.publicKey,maximumRequestBytes:10000,executionTimeoutMs:1000,
 clock:()=>1001,coordination:{async dispatch(){dispatches++;}},accounts:[{providerId:"openai",credentialRef:"account",models:new Set(["o3"]),
 async chatCompletions(bytes,_signal,authorization){await authorization.beforeDispatch?.();calls++;const payload=JSON.parse(Buffer.from(bytes).toString());
 assert.equal(payload.max_completion_tokens,8);assert.equal(payload.max_tokens,undefined);return new Response("ok");}}]});
 const body=managedProviderRequest(grant,originalBody);
 const stale=JSON.parse(Buffer.from(body).toString());delete stale.max_completion_tokens;stale.max_tokens=8;
 await assert.rejects(injector.execute(Buffer.from(JSON.stringify(stale)),authorization),/provider_body_mismatch/);
 assert.equal(dispatches,0);assert.equal(calls,0);
 assert.equal(await (await injector.execute(body,authorization)).text(),"ok");
 assert.equal(dispatches,1);assert.equal(calls,1);
});

test("credential access cannot extend compatible or native grant dispatch validity",async()=>{
 for(const providerId of ["mistral","anthropic"] as const){
  let now=1001,reads=0,calls=0,dispatches=0;
  const originalBody=Buffer.from(JSON.stringify({model:"public",input:"hello",max_output_tokens:8}));
  const grant:ExecutionGrant={version:2,audience:"multivibe-core-managed",attemptId:"expiry",reservationId:"r",routeVersionId:"v",
   providerId,credentialRef:"account",model:"public",upstreamModel:"upstream",operation:"responses",stream:false,
   bodySha256:executionBodyDigest(originalBody),maximumOutputTokens:8,responseRecoveryKeyId:"test-key",
   responseRecoveryPublicKey:"A5wnJM5Y01mDWCA4MsbAtTGS_l8BI4-JNVWY_KRBH1I",responseRecoveryExpiresAt:120000,issuedAt:1000,expiresAt:61000};
  const account=createManagedProviderAccount({providerId,credentialRef:"account",models:new Set(["upstream"]),maximumResponseBytes:8192,
   async readCredential(){reads++;now=61000;return "fixture-key";},async fetchViaEgress(){calls++;return new Response("must not execute");}});
  const injector=new ManagedCredentialInjector({verificationKey:keys.publicKey,maximumRequestBytes:8192,executionTimeoutMs:1000,clock:()=>now,
   coordination:{async dispatch(){dispatches++;}},accounts:[account]});
  await assert.rejects(injector.execute(managedProviderRequest(grant,originalBody),{token:signExecutionGrant(grant,keys.privateKey,1000),originalBody,ownership}),/^Error: injector_execution_uncertain$/);
  assert.equal(reads,1);assert.equal(dispatches,0);assert.equal(calls,0);
 }
});
