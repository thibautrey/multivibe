import {createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes} from "node:crypto";
import type {ExecutionGrant} from "./authorization.js";

export interface ExecutionRecoveryEnvelope {
  version: 1;
  algorithm: "X25519-HKDF-SHA256-AES-256-GCM";
  keyId: string;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  status: number;
  contentType: "application/json" | "application/json; charset=utf-8" | "text/event-stream";
  responseSha256: string;
  expiresAt: number;
}

function aad(grant:Readonly<ExecutionGrant>,envelope:Pick<ExecutionRecoveryEnvelope,"keyId"|"status"|"contentType"|"responseSha256"|"expiresAt">):Buffer {
  return Buffer.from(JSON.stringify({version:1,attemptId:grant.attemptId,reservationId:grant.reservationId,
    routeVersionId:grant.routeVersionId,providerId:grant.providerId,bodySha256:grant.bodySha256,keyId:envelope.keyId,
    status:envelope.status,contentType:envelope.contentType,responseSha256:envelope.responseSha256,expiresAt:envelope.expiresAt}));
}

/** Encrypt a bounded Cloud-facing response to the Cloud public key carried by
 * the signed execution grant. Core never receives the matching private key. */
export function encryptExecutionResponse(grant:Readonly<ExecutionGrant>,status:number,
  contentType:ExecutionRecoveryEnvelope["contentType"],body:Uint8Array):ExecutionRecoveryEnvelope {
  if(!Number.isInteger(status)||status<200||status>599||body.byteLength<1)throw Error("invalid_recovery_response");
  let cloudPublic;
  try{cloudPublic=createPublicKey({key:{kty:"OKP",crv:"X25519",x:grant.responseRecoveryPublicKey},format:"jwk"});}
  catch{throw Error("invalid_recovery_public_key");}
  const ephemeral=generateKeyPairSync("x25519");
  const shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:cloudPublic});
  let key:Buffer|undefined;
  try {
    if(shared.equals(Buffer.alloc(shared.length)))throw Error("invalid_recovery_public_key");
    key=Buffer.from(hkdfSync("sha256",shared,Buffer.from(grant.bodySha256,"hex"),
      Buffer.from("multivibe-managed-response-recovery-v1"),32));
    const nonce=randomBytes(12);
    const responseSha256=createHash("sha256").update(body).digest("hex");
    const fields={keyId:grant.responseRecoveryKeyId,status,contentType,responseSha256,expiresAt:grant.responseRecoveryExpiresAt};
    const cipher=createCipheriv("aes-256-gcm",key,nonce,{authTagLength:16});
    cipher.setAAD(aad(grant,fields));
    const ciphertext=Buffer.concat([cipher.update(body),cipher.final()]);
    const tag=cipher.getAuthTag();
    const exported=ephemeral.publicKey.export({format:"jwk"});
    if(typeof exported.x!=="string")throw Error("invalid_ephemeral_recovery_key");
    return {version:1,algorithm:"X25519-HKDF-SHA256-AES-256-GCM",...fields,
      ephemeralPublicKey:exported.x,nonce:nonce.toString("base64url"),ciphertext:ciphertext.toString("base64url"),
      tag:tag.toString("base64url")};
  } finally {
    key?.fill(0);
    shared.fill(0);
  }
}
