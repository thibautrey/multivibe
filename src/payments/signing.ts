import crypto from "node:crypto";

/**
 * Tiny signing helpers shared by the instance client. Deliberately duplicated
 * from the broker rather than imported: the instance is distributed without
 * the `services/` tree, and the wire format is the contract.
 */

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** `sha256=<hex>` signature of a response body, verified by the instance. */
export function bodySignature(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}
