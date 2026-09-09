import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { signExecutionGrant, executionBodyDigest, type ExecutionGrant } from "./authorization.js";
import { managedProviderRequest } from "./request.js";
import { authorizeManagedInjection } from "./injector-authorization.js";
const keys = generateKeyPairSync("ed25519");
function fixture(operation: ExecutionGrant["operation"] = "responses") {
  const originalBody = Buffer.from(JSON.stringify({model:"public/model",stream:false,max_output_tokens:8,
    ...(operation === "responses" ? {input:"hello"} : {messages:[{role:"user",content:"hello"}]})}));
  const grant: ExecutionGrant = {version:1,audience:"multivibe-core-managed",attemptId:"attempt",reservationId:"reservation",
    routeVersionId:"route",providerId:"mistral",credentialRef:"scoped-account",model:"public/model",upstreamModel:"upstream",
    operation,stream:false,bodySha256:executionBodyDigest(originalBody),maximumOutputTokens:8,issuedAt:1000,expiresAt:61000};
  return {token:signExecutionGrant(grant,keys.privateKey,1000),originalBody,providerBody:managedProviderRequest(grant,originalBody),
    verificationKey:keys.publicKey,now:1001,maximumRequestBytes:10000};
}
test("injector accepts only the exact provider projection of the signed request", () => {
  for (const operation of ["responses","chat_completions"] as const) {
    const input=fixture(operation);
    assert.equal(authorizeManagedInjection(input).credentialRef,"scoped-account");
    const parsed=JSON.parse(Buffer.from(input.providerBody).toString());
    for (const changed of [{...parsed,model:"different"},{...parsed,max_tokens:9},
      {...parsed,messages:[{role:"user",content:"substituted"}]},{...parsed,extra:"unapproved"}]) {
      assert.throws(()=>authorizeManagedInjection({...input,providerBody:Buffer.from(JSON.stringify(changed))}),/injector_provider_body_mismatch/);
    }
  }
});
test("injector independently rejects modified originals, expired grants and request overflow", () => {
  const input=fixture();
  assert.throws(()=>authorizeManagedInjection({...input,originalBody:Buffer.from('{}')}),/execution_body_mismatch/);
  assert.throws(()=>authorizeManagedInjection({...input,now:61000}),/invalid_execution_grant/);
  assert.throws(()=>authorizeManagedInjection({...input,maximumRequestBytes:1}),/injector_request_too_large/);
  assert.throws(()=>authorizeManagedInjection({...input,verificationKey:generateKeyPairSync('ed25519').publicKey}),/invalid_execution_grant/);
});
