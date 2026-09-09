import { createHash, sign, verify, type KeyObject } from "node:crypto";

/** Versioned internal contract. Never accept a customer-supplied execution grant. */
export interface ExecutionGrant {
  version: 1;
  audience: "multivibe-core-managed";
  attemptId: string;
  reservationId: string;
  routeVersionId: string;
  providerId: string;
  credentialRef: string;
  model: string;
  upstreamModel: string;
  operation: "responses" | "chat_completions";
  stream: boolean;
  bodySha256: string;
  maximumOutputTokens: number;
  issuedAt: number;
  expiresAt: number;
}
const fields = ["version", "audience", "attemptId", "reservationId", "routeVersionId",
  "providerId", "credentialRef", "model", "upstreamModel", "operation", "stream",
  "bodySha256", "maximumOutputTokens", "issuedAt", "expiresAt"].sort();
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
export function executionBodyDigest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
function validate(value: unknown, now: number): asserts value is ExecutionGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_execution_grant");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== fields.join()
    || v.version !== 1 || v.audience !== "multivibe-core-managed"
    || !["responses", "chat_completions"].includes(String(v.operation))
    || typeof v.stream !== "boolean"
    || typeof v.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.bodySha256)
    || !Number.isSafeInteger(v.maximumOutputTokens) || Number(v.maximumOutputTokens) <= 0
    || !Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt)
    || !Number.isSafeInteger(now) || Number(v.issuedAt) > now
    || Number(v.expiresAt) <= now || Number(v.expiresAt) - Number(v.issuedAt) > 60_000
    || Number(v.expiresAt) <= Number(v.issuedAt)) throw Error("invalid_execution_grant");
  for (const key of ["attemptId", "reservationId", "routeVersionId", "providerId", "credentialRef", "model", "upstreamModel"]) {
    if (typeof v[key] !== "string" || !identifier.test(v[key] as string)) throw Error("invalid_execution_grant");
  }
}
export function signExecutionGrant(grant: ExecutionGrant, key: KeyObject, now = Date.now()): string {
  validate(grant, now);
  if (key.asymmetricKeyType !== "ed25519" || key.type !== "private") throw Error("invalid_execution_signing_key");
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const signature = sign(null, Buffer.from(`multivibe-execution-v1.${payload}`), key).toString("base64url");
  return `${payload}.${signature}`;
}
/** Signature and bounded claims only; does not authorize execution without body verification. */
export function verifyExecutionGrantClaims(token: string, key: KeyObject, now = Date.now(), allowExpired = false): Readonly<ExecutionGrant> {
  if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    || key.asymmetricKeyType !== "ed25519" || key.type !== "public") throw Error("invalid_execution_grant");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw Error("invalid_execution_grant");
  if (!verify(null, Buffer.from(`multivibe-execution-v1.${payload}`), key, Buffer.from(signature, "base64url"))) throw Error("invalid_execution_grant");
  const grant: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  // Receipt persistence/recovery may outlive the execution window. Validate the
  // complete original time contract, and still reject future issuance.
  const issuedAt = (grant as Partial<ExecutionGrant> | null)?.issuedAt;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(issuedAt) || Number(issuedAt) > now) throw Error("invalid_execution_grant");
  validate(grant, allowExpired ? Number(issuedAt) : now);
  return Object.freeze(grant);
}
export function verifyExecutionGrant(token: string, body: Uint8Array, key: KeyObject, now = Date.now()): Readonly<ExecutionGrant> {
  const grant = verifyExecutionGrantClaims(token, key, now);
  if (grant.bodySha256 !== executionBodyDigest(body)) throw Error("execution_body_mismatch");
  return grant;
}
