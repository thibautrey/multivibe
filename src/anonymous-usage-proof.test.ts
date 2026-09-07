import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { solveAnonymousUsageProof } from "./anonymous-usage-proof.js";

test("admission proof matches the Cloud protocol and yields for cancellation", async () => {
  const eventId = randomUUID();
  const ticket = { ticketId: randomUUID(), challenge: "ab".repeat(32), eventId,
    difficulty: 18, expiresAt: new Date(Date.now() + 600_000).toISOString() };
  const proof = await solveAnonymousUsageProof(ticket, eventId, () => false);
  const hash = createHash("sha256").update(
    `multivibe-telemetry-v1:${ticket.ticketId}:${ticket.challenge}:${eventId}:${proof.nonce}`,
  ).digest();
  assert.ok(hash.readUInt32BE(0) < 2 ** 14);
  await assert.rejects(solveAnonymousUsageProof(ticket, eventId, () => true), /cancelled/);
});

test("untrusted servers cannot request excessive work, substitute events, or replay expired tickets", async () => {
  const eventId = randomUUID();
  const ticket = { ticketId: randomUUID(), challenge: "ab".repeat(32), eventId,
    difficulty: 18, expiresAt: new Date(Date.now() + 600_000).toISOString() };
  for (const value of [null, {}, { ...ticket, difficulty: 30 }, { ...ticket, eventId: randomUUID() },
    { ...ticket, expiresAt: "2000-01-01T00:00:00Z" }, { ...ticket, challenge: "x".repeat(10000) }]) {
    await assert.rejects(solveAnonymousUsageProof(value, eventId, () => false), /invalid/);
  }
});
