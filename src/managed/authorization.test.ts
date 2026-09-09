import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionBodyDigest, signExecutionGrant, verifyExecutionGrant, type ExecutionGrant } from "./authorization.js";
import { ExecutionJournal } from "./journal.js";
const keys = generateKeyPairSync("ed25519");
const body = Buffer.from('{"model":"test"}');
const grant: ExecutionGrant = { version: 2, audience: "multivibe-core-managed", attemptId: "attempt-1",
  reservationId: "reservation-1", routeVersionId: "route-1", providerId: "mistral",
  credentialRef: "mistral/account-1", model: "mistral/model", upstreamModel: "model",
  operation: "responses", stream: false, bodySha256: executionBodyDigest(body), maximumOutputTokens: 32,
  responseRecoveryKeyId:"test-key",responseRecoveryPublicKey:"A5wnJM5Y01mDWCA4MsbAtTGS_l8BI4-JNVWY_KRBH1I",responseRecoveryExpiresAt:120000,
  issuedAt: 1000, expiresAt: 61000 };
test("execution authorization binds payload, trusted issuer, schema, and validity", () => {
  const token = signExecutionGrant(grant, keys.privateKey, 1000);
  assert.deepEqual(verifyExecutionGrant(token, body, keys.publicKey, 1001), grant);
  assert.throws(() => verifyExecutionGrant(token, Buffer.from("changed"), keys.publicKey, 1001), /mismatch/);
  assert.throws(() => verifyExecutionGrant(token, body, keys.publicKey, 61000));
  assert.throws(() => verifyExecutionGrant(token, body, keys.publicKey, 999));
  assert.throws(() => verifyExecutionGrant(token, body, generateKeyPairSync("ed25519").publicKey, 1001));
  assert.throws(() => signExecutionGrant({ ...grant, upstreamUrl: "https://evil.test" } as ExecutionGrant, keys.privateKey, 1000));
  assert.throws(() => signExecutionGrant({ ...grant, expiresAt: 61001 }, keys.privateKey, 1000));
});
test("durable claim prevents concurrent execution and replay after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multivibe-journal-test-"));
  try {
    const journal = new ExecutionJournal(directory);
    const claims = await Promise.allSettled([journal.claim(grant), journal.claim(grant)]);
    assert.equal(claims.filter(c => c.status === "fulfilled").length, 1);
    await assert.rejects(new ExecutionJournal(directory).claim(grant), /already_claimed/);
    assert.equal(await journal.receipt(grant.attemptId), undefined);
    const receipt = { version: 1 as const, attemptId: grant.attemptId, reservationId: grant.reservationId,
      routeVersionId: grant.routeVersionId, providerId: grant.providerId, bodySha256: grant.bodySha256,
      state: "uncertain" as const, usage: null, responseSha256: null, status: null, finishedAt: 2000 };
    await journal.finish(receipt);
    assert.deepEqual(await new ExecutionJournal(directory).receipt(grant.attemptId), receipt);
    await assert.rejects(journal.finish(receipt));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
