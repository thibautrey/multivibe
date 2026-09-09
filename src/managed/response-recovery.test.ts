import assert from "node:assert/strict";
import test from "node:test";
import {createDecipheriv,createPublicKey,diffieHellman,generateKeyPairSync,hkdfSync} from "node:crypto";
import type {ExecutionGrant} from "./authorization.js";
import {encryptExecutionResponse} from "./response-recovery.js";

test("managed response recovery encrypts to the grant-bound Cloud key",()=>{
  const cloud=generateKeyPairSync("x25519");
  const publicJwk=cloud.publicKey.export({format:"jwk"});
  assert.equal(typeof publicJwk.x,"string");
  const grant:ExecutionGrant={version:2,audience:"multivibe-core-managed",attemptId:"attempt",reservationId:"reservation",
    routeVersionId:"route",providerId:"mistral",credentialRef:"account",model:"public/model",upstreamModel:"upstream-model",
    operation:"responses",stream:false,bodySha256:"a".repeat(64),maximumOutputTokens:8,responseRecoveryKeyId:"recovery-key-1",
    responseRecoveryPublicKey:publicJwk.x!,responseRecoveryExpiresAt:601000,issuedAt:1000,expiresAt:61000};
  const plaintext=Buffer.from('{"output_text":"RECOVERY_FIXTURE"}');
  const envelope=encryptExecutionResponse(grant,200,"application/json",plaintext);
  assert.doesNotMatch(JSON.stringify(envelope),/RECOVERY_FIXTURE/);
  const ephemeral=createPublicKey({key:{kty:"OKP",crv:"X25519",x:envelope.ephemeralPublicKey},format:"jwk"});
  const shared=diffieHellman({privateKey:cloud.privateKey,publicKey:ephemeral});
  const key=Buffer.from(hkdfSync("sha256",shared,Buffer.from(grant.bodySha256,"hex"),
    Buffer.from("multivibe-managed-response-recovery-v1"),32));
  try {
    const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.nonce,"base64url"),{authTagLength:16});
    decipher.setAAD(Buffer.from(JSON.stringify({version:1,attemptId:grant.attemptId,reservationId:grant.reservationId,
      routeVersionId:grant.routeVersionId,providerId:grant.providerId,bodySha256:grant.bodySha256,keyId:envelope.keyId,
      status:envelope.status,contentType:envelope.contentType,responseSha256:envelope.responseSha256,expiresAt:envelope.expiresAt})));
    decipher.setAuthTag(Buffer.from(envelope.tag,"base64url"));
    assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64url")),decipher.final()]),plaintext);
  } finally {key.fill(0);shared.fill(0);}
});
