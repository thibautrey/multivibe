import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
  type JsonWebKey as NodeJsonWebKey,
  type KeyObject,
} from "node:crypto";

export const CONFIDENTIAL_PRIVACY_MODE = "confidential_verified" as const;
export const CONFIDENTIAL_CAPABILITIES_PATH = "/v1/confidential/capabilities";
export const CONFIDENTIAL_EXECUTION_PATH = "/v1/confidential/responses";
export const CONFIDENTIAL_CONTENT_TYPE =
  "application/vnd.multivibe.confidential-envelope+json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const REGION = /^[a-z0-9][a-z0-9.-]{0,62}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const MAX_ATTESTATION_BYTES = 32 * 1024;
const MAX_ENVELOPE_BYTES = 100 * 1024 * 1024;
const MAX_EVIDENCE_LIFETIME_MS = 10 * 60_000;
const DEFAULT_MAX_EVIDENCE_AGE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;

export type ConfidentialMeasurements = Readonly<{
  runtime: string;
  model: string;
  cpuFirmware: string;
  gpuFirmware: string;
  gpuDriver: string;
}>;

export type ConfidentialAttestationPayload = Readonly<{
  version: "mvci-attestation-v1";
  evidenceId: string;
  challenge: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  runtimeId: string;
  model: string;
  region: string;
  recipientPublicKey: string;
  measurements: ConfidentialMeasurements;
  security: Readonly<{
    debug: boolean;
    tcbStatus: "current" | "outdated" | "revoked";
    cpuMemoryEncrypted: boolean;
    gpuMemoryEncrypted: boolean;
    operatorAccessBlocked: boolean;
  }>;
}>;

export type ConfidentialAttestationDocument = Readonly<{
  version: "mvci-attestation-document-v1";
  keyId: string;
  payload: ConfidentialAttestationPayload;
  signature: string;
}>;

export type ConfidentialCapabilities = Readonly<{
  version: "mvci-capabilities-v1";
  mode: "confidential_verified";
  evidence: ConfidentialAttestationDocument;
}>;

export type ConfidentialRequestEnvelope = Readonly<{
  version: "mvci-1";
  requestId: string;
  evidenceId: string;
  expiresAt: string;
  policy: Readonly<{
    privacy: "confidential_verified";
    model: string;
    path: "/v1/responses" | "/v1/chat/completions";
  }>;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}>;

export type ConfidentialResponseEnvelope = Readonly<{
  version: "mvci-1";
  responseTo: string;
  evidenceId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}>;

export type ConfidentialTrustRoot = Readonly<{
  keyId: string;
  publicKey: NodeJsonWebKey;
}>;

export type ConfidentialRuntimeProfile = Readonly<{
  model: string;
  regions: readonly string[];
  measurements: ConfidentialMeasurements;
}>;

export type ConfidentialTrustPolicy = Readonly<{
  roots: readonly ConfidentialTrustRoot[];
  profiles: readonly ConfidentialRuntimeProfile[];
  maxEvidenceAgeMs?: number;
}>;

export type ConfidentialExecutionInput = Readonly<{
  baseUrl: string;
  accessToken: string;
  model: string;
  path: "/v1/responses" | "/v1/chat/completions";
  body: BodyInit;
  signal?: AbortSignal;
  requestId?: string;
}>;

export class ConfidentialInferenceError extends Error {
  constructor(
    readonly disposition: "not_sent" | "execution_uncertain",
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfidentialInferenceError";
  }
}

type SessionKeys = Readonly<{ request: Buffer; response: Buffer }>;

function failure(
  disposition: ConfidentialInferenceError["disposition"],
  code: string,
  message: string,
  cause?: unknown,
): never {
  throw new ConfidentialInferenceError(disposition, code, message, cause);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure("not_sent", "invalid_attestation", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    failure("not_sent", "invalid_attestation", `${label} contains unexpected fields`);
  }
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) failure("not_sent", "invalid_attestation", `${label} is invalid`);
  return value;
}

function base64url(value: unknown, bytes: number | readonly [number, number], label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) {
    failure("not_sent", "invalid_attestation", `${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64url");
  const canonical = decoded.toString("base64url");
  const same = canonical.length === value.length
    && timingSafeEqual(Buffer.from(canonical), Buffer.from(value));
  const validLength = typeof bytes === "number"
    ? decoded.length === bytes
    : decoded.length >= bytes[0] && decoded.length <= bytes[1];
  if (!same || !validLength) failure("not_sent", "invalid_attestation", `${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, RFC3339, label);
  if (!Number.isFinite(Date.parse(result))) failure("not_sent", "invalid_attestation", `${label} is invalid`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") failure("not_sent", "invalid_attestation", `${label} is invalid`);
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  const rendered = JSON.stringify(value);
  if (rendered === undefined) throw new Error("Canonical JSON cannot contain undefined");
  return rendered;
}

function parseCapabilities(value: unknown): ConfidentialCapabilities {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch (error) { failure("not_sent", "invalid_attestation", "Attestation response is invalid", error); }
  if (Buffer.byteLength(encoded!, "utf8") > MAX_ATTESTATION_BYTES) {
    failure("not_sent", "invalid_attestation", "Attestation response is too large");
  }
  const root = record(value, "capabilities");
  exactKeys(root, ["version", "mode", "evidence"], "capabilities");
  if (root.version !== "mvci-capabilities-v1" || root.mode !== CONFIDENTIAL_PRIVACY_MODE) {
    failure("not_sent", "invalid_attestation", "Capabilities version or mode is invalid");
  }
  const evidence = record(root.evidence, "evidence");
  exactKeys(evidence, ["version", "keyId", "payload", "signature"], "evidence");
  if (evidence.version !== "mvci-attestation-document-v1") {
    failure("not_sent", "invalid_attestation", "Evidence version is invalid");
  }
  const payload = record(evidence.payload, "attestation payload");
  exactKeys(payload, [
    "version", "evidenceId", "challenge", "issuer", "issuedAt", "expiresAt",
    "runtimeId", "model", "region", "recipientPublicKey", "measurements", "security",
  ], "attestation payload");
  if (payload.version !== "mvci-attestation-v1") failure("not_sent", "invalid_attestation", "Attestation version is invalid");
  const measurements = record(payload.measurements, "measurements");
  exactKeys(measurements, ["runtime", "model", "cpuFirmware", "gpuFirmware", "gpuDriver"], "measurements");
  const security = record(payload.security, "security");
  exactKeys(security, [
    "debug", "tcbStatus", "cpuMemoryEncrypted", "gpuMemoryEncrypted", "operatorAccessBlocked",
  ], "security");
  if (!["current", "outdated", "revoked"].includes(String(security.tcbStatus))) {
    failure("not_sent", "invalid_attestation", "TCB status is invalid");
  }
  const issuedAt = timestamp(payload.issuedAt, "issuedAt");
  const expiresAt = timestamp(payload.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0 || lifetime > MAX_EVIDENCE_LIFETIME_MS) {
    failure("not_sent", "invalid_attestation", "Attestation lifetime is invalid");
  }
  return {
    version: "mvci-capabilities-v1",
    mode: CONFIDENTIAL_PRIVACY_MODE,
    evidence: {
      version: "mvci-attestation-document-v1",
      keyId: text(evidence.keyId, IDENTIFIER, "keyId"),
      payload: {
        version: "mvci-attestation-v1",
        evidenceId: text(payload.evidenceId, UUID, "evidenceId"),
        challenge: base64url(payload.challenge, 32, "challenge"),
        issuer: text(payload.issuer, IDENTIFIER, "issuer"),
        issuedAt,
        expiresAt,
        runtimeId: text(payload.runtimeId, IDENTIFIER, "runtimeId"),
        model: text(payload.model, MODEL, "model"),
        region: text(payload.region, REGION, "region"),
        recipientPublicKey: base64url(payload.recipientPublicKey, 32, "recipientPublicKey"),
        measurements: {
          runtime: text(measurements.runtime, DIGEST, "runtime measurement"),
          model: text(measurements.model, DIGEST, "model measurement"),
          cpuFirmware: text(measurements.cpuFirmware, DIGEST, "CPU firmware measurement"),
          gpuFirmware: text(measurements.gpuFirmware, DIGEST, "GPU firmware measurement"),
          gpuDriver: text(measurements.gpuDriver, DIGEST, "GPU driver measurement"),
        },
        security: {
          debug: boolean(security.debug, "debug"),
          tcbStatus: security.tcbStatus as "current" | "outdated" | "revoked",
          cpuMemoryEncrypted: boolean(security.cpuMemoryEncrypted, "cpuMemoryEncrypted"),
          gpuMemoryEncrypted: boolean(security.gpuMemoryEncrypted, "gpuMemoryEncrypted"),
          operatorAccessBlocked: boolean(security.operatorAccessBlocked, "operatorAccessBlocked"),
        },
      },
      signature: base64url(evidence.signature, 64, "signature"),
    },
  };
}

function publicKeyFromRawX25519(value: string): KeyObject {
  try {
    return createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: value },
      format: "jwk",
    });
  } catch (error) {
    failure("not_sent", "invalid_recipient_key", "Attested recipient key is invalid", error);
  }
}

function publicKeyFromTrustRoot(root: ConfidentialTrustRoot): KeyObject {
  try {
    if (root.publicKey.kty !== "OKP" || root.publicKey.crv !== "Ed25519" || typeof root.publicKey.x !== "string") {
      throw new Error("Trust root must be an Ed25519 public JWK");
    }
    return createPublicKey({ key: root.publicKey, format: "jwk" });
  } catch (error) {
    failure("not_sent", "invalid_trust_policy", "Configured attestation trust root is invalid", error);
  }
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyEvidence(
  capabilities: ConfidentialCapabilities,
  challenge: string,
  model: string,
  policy: ConfidentialTrustPolicy,
  now: number,
): ConfidentialAttestationPayload {
  const { evidence } = capabilities;
  const root = policy.roots.find((candidate) => equalText(candidate.keyId, evidence.keyId));
  if (!root) failure("not_sent", "untrusted_attestation_root", "Attestation root is not trusted");
  const signature = Buffer.from(evidence.signature, "base64url");
  if (!verify(null, Buffer.from(canonicalJson(evidence.payload), "utf8"), publicKeyFromTrustRoot(root), signature)) {
    failure("not_sent", "invalid_attestation_signature", "Attestation signature is invalid");
  }
  const payload = evidence.payload;
  if (!equalText(payload.challenge, challenge)) {
    failure("not_sent", "attestation_challenge_mismatch", "Attestation is not bound to this client challenge");
  }
  if (!equalText(payload.model, model)) {
    failure("not_sent", "attestation_model_mismatch", "Attestation is not bound to the requested model");
  }
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const maximumAge = policy.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  if (issuedAt > now + CLOCK_SKEW_MS || issuedAt < now - maximumAge || expiresAt <= now) {
    failure("not_sent", "stale_attestation", "Attestation is stale or expired");
  }
  if (
    payload.security.debug
    || payload.security.tcbStatus !== "current"
    || !payload.security.cpuMemoryEncrypted
    || !payload.security.gpuMemoryEncrypted
    || !payload.security.operatorAccessBlocked
  ) {
    failure("not_sent", "ineligible_confidential_runtime", "Runtime security state is not eligible");
  }
  const profile = policy.profiles.find((candidate) => candidate.model === model);
  if (!profile || !profile.regions.includes(payload.region)) {
    failure("not_sent", "unapproved_runtime_profile", "Runtime model or region is not approved");
  }
  for (const field of ["runtime", "model", "cpuFirmware", "gpuFirmware", "gpuDriver"] as const) {
    if (!equalText(profile.measurements[field], payload.measurements[field])) {
      failure("not_sent", "measurement_mismatch", `Runtime ${field} measurement is not approved`);
    }
  }
  return payload;
}

export function deriveConfidentialSessionKeys(
  privateKey: KeyObject,
  peerPublicKey: KeyObject,
  evidence: ConfidentialAttestationPayload,
): SessionKeys {
  const shared = diffieHellman({ privateKey, publicKey: peerPublicKey });
  const salt = createHash("sha256").update(canonicalJson(evidence)).digest();
  return {
    request: Buffer.from(hkdfSync("sha256", shared, salt, "multivibe-confidential-request-v1", 32)),
    response: Buffer.from(hkdfSync("sha256", shared, salt, "multivibe-confidential-response-v1", 32)),
  };
}

export function confidentialRequestAad(envelope: Omit<ConfidentialRequestEnvelope, "ciphertext" | "tag">): Buffer {
  return Buffer.from(canonicalJson(envelope), "utf8");
}

export function confidentialResponseAad(envelope: Omit<ConfidentialResponseEnvelope, "ciphertext" | "tag">): Buffer {
  return Buffer.from(canonicalJson(envelope), "utf8");
}

function parseResponseEnvelope(value: unknown): ConfidentialResponseEnvelope {
  const root = record(value, "confidential response envelope");
  exactKeys(root, ["version", "responseTo", "evidenceId", "nonce", "ciphertext", "tag"], "confidential response envelope");
  if (root.version !== "mvci-1") failure("execution_uncertain", "invalid_confidential_response", "Response protocol version is invalid");
  return {
    version: "mvci-1",
    responseTo: text(root.responseTo, UUID, "responseTo"),
    evidenceId: text(root.evidenceId, UUID, "evidenceId"),
    nonce: base64url(root.nonce, 12, "response nonce"),
    ciphertext: base64url(root.ciphertext, [1, MAX_ENVELOPE_BYTES], "response ciphertext"),
    tag: base64url(root.tag, 16, "response tag"),
  };
}

async function boundedJson(response: Response, maximum: number, disposition: ConfidentialInferenceError["disposition"]): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximum) {
    failure(disposition, "confidential_response_too_large", "Confidential response exceeds the size limit");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    failure(disposition, "confidential_transport_failed", "Confidential response could not be read", error);
  }
  if (bytes.length > maximum) failure(disposition, "confidential_response_too_large", "Confidential response exceeds the size limit");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { failure(disposition, "invalid_confidential_response", "Confidential response is not valid JSON", error); }
}

function bodyBytes(body: BodyInit): Buffer {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  failure("not_sent", "unsupported_confidential_body", "Confidential inference requires an in-memory request body");
}

function normalizedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { failure("not_sent", "invalid_confidential_origin", "Confidential inference origin is invalid"); }
  const loopback = url!.hostname === "localhost" || url!.hostname === "127.0.0.1" || url!.hostname === "[::1]";
  if (url!.username || url!.password || url!.search || url!.hash
    || (url!.pathname !== "" && url!.pathname !== "/")
    || (url!.protocol !== "https:" && !(url!.protocol === "http:" && loopback))) {
    failure("not_sent", "invalid_confidential_origin", "Confidential inference requires HTTPS or loopback HTTP");
  }
  return url!.origin;
}

function validAccessToken(value: string): string {
  if (!value || value.length > 8192 || /[\s\r\n]/u.test(value)) {
    failure("not_sent", "invalid_confidential_credential", "Confidential inference credential is invalid");
  }
  return value;
}

export class ConfidentialInferenceClient {
  private readonly now: () => number;

  constructor(
    private readonly trustPolicy: ConfidentialTrustPolicy,
    private readonly fetchImpl: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    if (!trustPolicy.roots.length || !trustPolicy.profiles.length) {
      throw new Error("Confidential inference requires pinned roots and runtime profiles");
    }
    this.now = now;
  }

  async execute(input: ConfidentialExecutionInput): Promise<Response> {
    const session = await this.prepare(input);
    return session.execute(input.body);
  }

  /** Attest without receiving prompt content, then return a single-use session. */
  async prepare(input: Omit<ConfidentialExecutionInput, "body">): Promise<Readonly<{
    evidence: ConfidentialAttestationPayload;
    execute(body: BodyInit, signal?: AbortSignal): Promise<Response>;
  }>> {
    const origin = normalizedOrigin(input.baseUrl);
    const accessToken = validAccessToken(input.accessToken);
    const challenge = randomBytes(32).toString("base64url");
    const capabilitiesUrl = new URL(CONFIDENTIAL_CAPABILITIES_PATH, `${origin}/`);
    capabilitiesUrl.searchParams.set("challenge", challenge);
    capabilitiesUrl.searchParams.set("model", input.model);

    let capabilitiesResponse: Response;
    try {
      capabilitiesResponse = await this.fetchImpl(capabilitiesUrl, {
        method: "GET",
        headers: { accept: CONFIDENTIAL_CONTENT_TYPE },
        redirect: "manual",
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      failure("not_sent", "attestation_unavailable", "The protected destination could not be verified. The message was not sent.", error);
    }
    if (!capabilitiesResponse!.ok) {
      await capabilitiesResponse!.body?.cancel().catch(() => undefined);
      failure("not_sent", "attestation_unavailable", "The protected destination could not be verified. The message was not sent.");
    }
    const capabilities = parseCapabilities(
      await boundedJson(capabilitiesResponse!, MAX_ATTESTATION_BYTES, "not_sent"),
    );
    const evidence = verifyEvidence(capabilities, challenge, input.model, this.trustPolicy, this.now());
    let used = false;
    return Object.freeze({ evidence, execute: async (body: BodyInit, signal = input.signal) => {
      if (used) failure("not_sent", "confidential_session_used", "Confidential session was already used");
      used = true;
      // Recheck pinned policy and freshness at dispatch, after any scheduling delay.
      verifyEvidence(capabilities, challenge, input.model, this.trustPolicy, this.now());
      return this.executeVerified({ ...input, body, signal }, evidence, origin, accessToken);
    } });
  }

  private async executeVerified(input: ConfidentialExecutionInput, evidence: ConfidentialAttestationPayload,
    origin: string, accessToken: string): Promise<Response> {

    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const ephemeralJwk = publicKey.export({ format: "jwk" });
    if (typeof ephemeralJwk.x !== "string") failure("not_sent", "local_crypto_failed", "Could not create a confidential session key");
    const recipient = publicKeyFromRawX25519(evidence.recipientPublicKey);
    const keys = deriveConfidentialSessionKeys(privateKey, recipient, evidence);
    const requestId = input.requestId ?? randomUUID();
    if (!UUID.test(requestId)) failure("not_sent", "invalid_confidential_request_id", "Confidential request identifier is invalid");
    const expiresAt = new Date(Math.min(Date.parse(evidence.expiresAt), this.now() + 60_000)).toISOString();
    const nonce = randomBytes(12);
    const aadEnvelope = {
      version: "mvci-1" as const,
      requestId,
      evidenceId: evidence.evidenceId,
      expiresAt,
      policy: {
        privacy: CONFIDENTIAL_PRIVACY_MODE,
        model: input.model,
        path: input.path,
      },
      ephemeralPublicKey: ephemeralJwk.x!,
      nonce: nonce.toString("base64url"),
    };
    const innerRequest = Buffer.from(canonicalJson({
      version: "mvci-inner-request-v1",
      method: "POST",
      path: input.path,
      headers: { "content-type": "application/json" },
      body: bodyBytes(input.body).toString("base64url"),
    }), "utf8");
    const cipher = createCipheriv("aes-256-gcm", keys.request, nonce, { authTagLength: 16 });
    cipher.setAAD(confidentialRequestAad(aadEnvelope));
    const ciphertext = Buffer.concat([cipher.update(innerRequest), cipher.final()]);
    const envelope: ConfidentialRequestEnvelope = {
      ...aadEnvelope,
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };

    let executionResponse: Response;
    try {
      executionResponse = await this.fetchImpl(new URL(CONFIDENTIAL_EXECUTION_PATH, `${origin}/`), {
        method: "POST",
        headers: {
          accept: CONFIDENTIAL_CONTENT_TYPE,
          authorization: `Bearer ${accessToken}`,
          "content-type": CONFIDENTIAL_CONTENT_TYPE,
        },
        body: JSON.stringify(envelope),
        redirect: "manual",
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      failure("execution_uncertain", "confidential_transport_failed", "The confidential execution outcome is uncertain.", error);
    }
    if (!executionResponse!.ok) {
      const state = executionResponse!.headers.get("x-multivibe-execution-state");
      await executionResponse!.body?.cancel().catch(() => undefined);
      failure(
        state === "not_sent" ? "not_sent" : "execution_uncertain",
        state === "not_sent" ? "confidential_request_not_sent" : "confidential_execution_uncertain",
        state === "not_sent"
          ? "The protected runtime did not start the request. No unprotected fallback was attempted."
          : "The confidential execution outcome is uncertain.",
      );
    }
    let sealed: ConfidentialResponseEnvelope;
    try {
      sealed = parseResponseEnvelope(
        await boundedJson(executionResponse!, MAX_ENVELOPE_BYTES, "execution_uncertain"),
      );
    } catch (error) {
      if (error instanceof ConfidentialInferenceError && error.disposition === "execution_uncertain") throw error;
      failure("execution_uncertain", "invalid_confidential_response", "The confidential response could not be authenticated", error);
    }
    if (!equalText(sealed.responseTo, requestId) || !equalText(sealed.evidenceId, evidence.evidenceId)) {
      failure("execution_uncertain", "confidential_response_binding_failed", "The confidential response does not match this request");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        keys.response,
        Buffer.from(sealed.nonce, "base64url"),
        { authTagLength: 16 },
      );
      decipher.setAAD(confidentialResponseAad({
        version: sealed.version,
        responseTo: sealed.responseTo,
        evidenceId: sealed.evidenceId,
        nonce: sealed.nonce,
      }));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const inner = JSON.parse(clear.toString("utf8")) as Record<string, unknown>;
      exactKeys(inner, ["version", "status", "headers", "body"], "confidential inner response");
      if (inner.version !== "mvci-inner-response-v1" || !Number.isSafeInteger(inner.status)
        || Number(inner.status) < 100 || Number(inner.status) > 599) {
        throw new Error("Invalid confidential inner response");
      }
      const headersRecord = record(inner.headers, "confidential response headers");
      const headers = new Headers();
      for (const [name, value] of Object.entries(headersRecord)) {
        const normalized = name.toLowerCase();
        if (!["content-type", "request-id", "openai-request-id", "anthropic-request-id"].includes(normalized)
          || typeof value !== "string" || /[\r\n]/u.test(value) || value.length > 1_024) {
          throw new Error("Invalid confidential response header");
        }
        headers.set(normalized, value);
      }
      const body = base64url(inner.body, [0, MAX_ENVELOPE_BYTES], "confidential response body");
      return new Response(Buffer.from(body, "base64url"), {
        status: Number(inner.status),
        headers,
      });
    } catch (error) {
      failure("execution_uncertain", "confidential_response_authentication_failed", "The confidential response could not be authenticated", error);
    }
  }
}

export function parseConfidentialTrustPolicy(value: string | undefined): ConfidentialTrustPolicy | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("MULTIVIBE_CONFIDENTIAL_INFERENCE_TRUST_POLICY must be valid JSON"); }
  const root = parsed as Partial<ConfidentialTrustPolicy>;
  if (!root || typeof root !== "object" || !Array.isArray(root.roots) || !Array.isArray(root.profiles)) {
    throw new Error("Confidential inference trust policy is invalid");
  }
  return root as ConfidentialTrustPolicy;
}
