import crypto from "node:crypto";

/** Constant-time string comparison for tokens of equal or different length. */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Human code such as `K7F2-M9QA`, easy to read over a call. */
export function enrollmentCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const draw = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  return `${draw()}-${draw()}`;
}

function encryptionKey(material: string | undefined): Buffer | null {
  if (!material) return null;
  const trimmed = material.trim();
  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  return buffer.length === 32 ? buffer : null;
}

/**
 * Seal the instance secret at rest. Without a configured key the secret is
 * stored base64-encoded: it must remain readable to verify the request HMAC,
 * so it cannot be hashed like a password.
 */
export function sealSecret(secret: string, keyMaterial?: string): string {
  const key = encryptionKey(keyMaterial);
  if (!key) return `plain:${Buffer.from(secret, "utf8").toString("base64")}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function openSecret(sealed: string, keyMaterial?: string): string {
  if (sealed.startsWith("plain:")) {
    return Buffer.from(sealed.slice("plain:".length), "base64").toString("utf8");
  }
  if (!sealed.startsWith("v1:")) throw new Error("unknown sealed secret format");
  const [, iv, tag, payload] = sealed.split(":");
  const key = encryptionKey(keyMaterial);
  if (!key) throw new Error("MARKETPLACE_ENCRYPTION_KEY is required to open sealed secrets");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

/** `sha256=<hex>` signature of a response body, checked by the instance. */
export function bodySignature(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

export type RequestSignatureInput = {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
  signature: string;
  now?: number;
  windowMs?: number;
};

/**
 * Instance authentication: the client signs
 * `timestamp.METHOD.path.sha256(body)` with its secret. The window bounds
 * replay; the body hash binds the payload.
 */
export function verifyRequestSignature(input: RequestSignatureInput): boolean {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? 5 * 60 * 1000;
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > windowMs) return false;
  const material = `${input.timestamp}.${input.method.toUpperCase()}.${input.path}.${sha256(input.body)}`;
  const expected = crypto.createHmac("sha256", input.secret).update(material).digest("hex");
  return safeEqual(expected, input.signature);
}

type StripeSignatureHeader = { timestamp: number; signatures: string[] };

function parseStripeSignature(header: string): StripeSignatureHeader | null {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  return Number.isFinite(timestamp) && signatures.length > 0 ? { timestamp, signatures } : null;
}

/** Verify a `Stripe-Signature` header against the raw request body. */
export function verifyStripeSignature(
  raw: string,
  header: string | undefined,
  secret: string,
  options: { now?: number; toleranceMs?: number } = {},
): boolean {
  if (!header) return false;
  const parsed = parseStripeSignature(header);
  if (!parsed) return false;
  const now = options.now ?? Date.now();
  const tolerance = options.toleranceMs ?? 5 * 60 * 1000;
  if (Math.abs(now - parsed.timestamp * 1000) > tolerance) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${raw}`)
    .digest("hex");
  return parsed.signatures.some((signature) => safeEqual(expected, signature));
}

/** Sign a webhook-style payload in tests and tools. */
export function stripeSignature(raw: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}
