import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

type Ticket = { ticketId: string; challenge: string; eventId: string; expiresAt: string; difficulty: number };

export async function solveAnonymousUsageProof(
  value: unknown,
  eventId: string,
  cancelled: () => boolean,
  now = new Date(),
): Promise<{ ticketId: string; nonce: string; challenge: string; expiresAt: string }> {
  const ticket = value as Ticket | null;
  if (!ticket || typeof ticket !== "object" ||
      typeof ticket.ticketId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(ticket.ticketId) ||
      typeof ticket.challenge !== "string" || !/^[0-9a-f]{64}$/u.test(ticket.challenge) ||
      ticket.eventId !== eventId || ticket.difficulty !== 18 ||
      typeof ticket.expiresAt !== "string" || !Number.isFinite(Date.parse(ticket.expiresAt)) ||
      Date.parse(ticket.expiresAt) <= now.getTime() || Date.parse(ticket.expiresAt) > now.getTime() + 11 * 60_000) {
    throw new Error("anonymous usage admission challenge is invalid");
  }
  const deadline = performance.now() + Math.min(10_000, Date.parse(ticket.expiresAt) - now.getTime());
  const prefix = `multivibe-telemetry-v1:${ticket.ticketId}:${ticket.challenge}:${eventId}:`;
  // Fixed difficulty, bounded work and short batches prevent a remote service
  // from requesting arbitrary CPU work or blocking inference / opt-out.
  for (let counter = 0; counter < 2 ** 22; counter += 1) {
    if (counter % 1024 === 0) {
      await yieldToEventLoop();
      if (cancelled()) throw new Error("anonymous usage admission cancelled");
      if (performance.now() >= deadline) break;
    }
    const nonce = counter.toString(16);
    const digest = createHash("sha256").update(prefix + nonce).digest();
    if (digest.readUInt32BE(0) < 2 ** 14) return { ticketId: ticket.ticketId, nonce, challenge: ticket.challenge, expiresAt: ticket.expiresAt };
  }
  throw new Error("anonymous usage admission work limit reached");
}
