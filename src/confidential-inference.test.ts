import assert from "node:assert/strict";
import {
  createDecipheriv,
  createCipheriv,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import test from "node:test";
import {
  CONFIDENTIAL_CAPABILITIES_PATH,
  CONFIDENTIAL_CONTENT_TYPE,
  CONFIDENTIAL_EXECUTION_PATH,
  ConfidentialInferenceClient,
  ConfidentialInferenceError,
  canonicalJson,
  confidentialRequestAad,
  confidentialResponseAad,
  deriveConfidentialSessionKeys,
  type ConfidentialAttestationPayload,
  type ConfidentialMeasurements,
  type ConfidentialRequestEnvelope,
  type ConfidentialTrustPolicy,
} from "./confidential-inference.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const MODEL = "verified-model";
const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const measurements: ConfidentialMeasurements = {
  runtime: digest("1"),
  model: digest("2"),
  cpuFirmware: digest("3"),
  gpuFirmware: digest("4"),
  gpuDriver: digest("5"),
};

type FixtureOptions = {
  mutatePayload?: (payload: ConfidentialAttestationPayload) => ConfidentialAttestationPayload;
  mutateAfterSigning?: (payload: ConfidentialAttestationPayload) => ConfidentialAttestationPayload;
  untrustedSigner?: boolean;
  tamperResponse?: boolean;
};

function fixture(options: FixtureOptions = {}) {
  const attestation = generateKeyPairSync("ed25519");
  const otherAttestation = generateKeyPairSync("ed25519");
  const runtime = generateKeyPairSync("x25519");
  const runtimePublic = runtime.publicKey.export({ format: "jwk" });
  const rootPublic = attestation.publicKey.export({ format: "jwk" });
  assert.equal(typeof runtimePublic.x, "string");
  const policy: ConfidentialTrustPolicy = {
    roots: [{ keyId: "test-root", publicKey: rootPublic }],
    profiles: [{ model: MODEL, regions: ["eu-test-1"], measurements }],
  };
  let executeCalls = 0;
  let conventionalCalls = 0;
  let relayBody = "";
  let lastEvidence: ConfidentialAttestationPayload | undefined;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === CONFIDENTIAL_CAPABILITIES_PATH) {
      const base: ConfidentialAttestationPayload = {
        version: "mvci-attestation-v1",
        evidenceId: randomUUID(),
        challenge: url.searchParams.get("challenge") ?? "",
        issuer: "test-attester",
        issuedAt: new Date(NOW - 1_000).toISOString(),
        expiresAt: new Date(NOW + 60_000).toISOString(),
        runtimeId: "runtime-test-1",
        model: url.searchParams.get("model") ?? "",
        region: "eu-test-1",
        recipientPublicKey: runtimePublic.x!,
        measurements,
        security: {
          debug: false,
          tcbStatus: "current",
          cpuMemoryEncrypted: true,
          gpuMemoryEncrypted: true,
          operatorAccessBlocked: true,
        },
      };
      const signedPayload = options.mutatePayload?.(base) ?? base;
      const signingKey = options.untrustedSigner
        ? otherAttestation.privateKey
        : attestation.privateKey;
      const signature = sign(
        null,
        Buffer.from(canonicalJson(signedPayload)),
        signingKey,
      ).toString("base64url");
      const deliveredPayload = options.mutateAfterSigning?.(signedPayload) ?? signedPayload;
      lastEvidence = deliveredPayload;
      return Response.json({
        version: "mvci-capabilities-v1",
        mode: "confidential_verified",
        evidence: {
          version: "mvci-attestation-document-v1",
          keyId: "test-root",
          payload: deliveredPayload,
          signature,
        },
      }, { headers: { "content-type": CONFIDENTIAL_CONTENT_TYPE } });
    }
    if (url.pathname !== CONFIDENTIAL_EXECUTION_PATH) {
      conventionalCalls += 1;
      throw new Error("Conventional provider transport must not be called");
    }
    executeCalls += 1;
    relayBody = String(init?.body ?? "");
    const envelope = JSON.parse(relayBody) as ConfidentialRequestEnvelope;
    assert.ok(lastEvidence);
    const peer = createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: envelope.ephemeralPublicKey },
      format: "jwk",
    });
    const keys = deriveConfidentialSessionKeys(runtime.privateKey, peer, lastEvidence);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keys.request,
      Buffer.from(envelope.nonce, "base64url"),
      { authTagLength: 16 },
    );
    const { ciphertext: _ciphertext, tag: _tag, ...requestAad } = envelope;
    decipher.setAAD(confidentialRequestAad(requestAad));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    const innerRequest = JSON.parse(clear.toString("utf8"));
    const promptBody = Buffer.from(innerRequest.body, "base64url").toString("utf8");
    assert.match(promptBody, /private canary message/u);

    const responseBody = Buffer.from(JSON.stringify({
      id: "resp_confidential",
      object: "response",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "protected answer" }] }],
    }));
    const innerResponse = Buffer.from(canonicalJson({
      version: "mvci-inner-response-v1",
      status: 200,
      headers: { "content-type": "application/json" },
      body: responseBody.toString("base64url"),
    }));
    const nonce = randomBytes(12);
    const responseAad = {
      version: "mvci-1" as const,
      responseTo: envelope.requestId,
      evidenceId: envelope.evidenceId,
      nonce: nonce.toString("base64url"),
    };
    const cipher = createCipheriv("aes-256-gcm", keys.response, nonce, { authTagLength: 16 });
    cipher.setAAD(confidentialResponseAad(responseAad));
    const ciphertext = Buffer.concat([cipher.update(innerResponse), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (options.tamperResponse) tag[0] = tag[0]! ^ 1;
    return Response.json({
      ...responseAad,
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url"),
    }, { headers: { "content-type": CONFIDENTIAL_CONTENT_TYPE } });
  };

  return {
    client: new ConfidentialInferenceClient(policy, fetchImpl, () => NOW),
    stats: () => ({ executeCalls, conventionalCalls, relayBody }),
  };
}

async function execute(client: ConfidentialInferenceClient): Promise<Response> {
  return client.execute({
    baseUrl: "https://api.multivibe.cloud",
    accessToken: "mvs_test_credential",
    model: MODEL,
    path: "/v1/responses",
    body: JSON.stringify({ model: MODEL, input: "private canary message" }),
  });
}

test("verifies attestation before encrypting and only sends ciphertext through Cloud", async () => {
  const run = fixture();
  const response = await execute(run.client);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { id: string }).id, "resp_confidential");
  const stats = run.stats();
  assert.equal(stats.executeCalls, 1);
  assert.equal(stats.conventionalCalls, 0);
  assert.doesNotMatch(stats.relayBody, /private canary message|protected answer/u);
  assert.match(stats.relayBody, /"privacy":"confidential_verified"/u);
});

for (const scenario of [
  {
    name: "an untrusted root",
    options: { untrustedSigner: true },
    code: "invalid_attestation_signature",
  },
  {
    name: "stale evidence",
    options: {
      mutatePayload: (payload: ConfidentialAttestationPayload) => ({
        ...payload,
        issuedAt: new Date(NOW - 8 * 60_000).toISOString(),
        expiresAt: new Date(NOW + 30_000).toISOString(),
      }),
    },
    code: "stale_attestation",
  },
  {
    name: "debug mode",
    options: {
      mutatePayload: (payload: ConfidentialAttestationPayload) => ({
        ...payload,
        security: { ...payload.security, debug: true },
      }),
    },
    code: "ineligible_confidential_runtime",
  },
  {
    name: "a revoked TCB",
    options: {
      mutatePayload: (payload: ConfidentialAttestationPayload) => ({
        ...payload,
        security: { ...payload.security, tcbStatus: "revoked" },
      }),
    },
    code: "ineligible_confidential_runtime",
  },
  {
    name: "an unapproved measurement",
    options: {
      mutatePayload: (payload: ConfidentialAttestationPayload) => ({
        ...payload,
        measurements: { ...payload.measurements, runtime: digest("a") },
      }),
    },
    code: "measurement_mismatch",
  },
  {
    name: "recipient key substitution after signing",
    options: {
      mutateAfterSigning: (payload: ConfidentialAttestationPayload) => ({
        ...payload,
        recipientPublicKey: randomBytes(32).toString("base64url"),
      }),
    },
    code: "invalid_attestation_signature",
  },
] as const) {
  test(`rejects ${scenario.name} before the prompt is sent`, async () => {
    const run = fixture(scenario.options);
    await assert.rejects(
      execute(run.client),
      (error: unknown) => error instanceof ConfidentialInferenceError
        && error.disposition === "not_sent"
        && error.code === scenario.code,
    );
    assert.equal(run.stats().executeCalls, 0);
    assert.equal(run.stats().conventionalCalls, 0);
  });
}

test("treats an authenticated-response failure as execution uncertain", async () => {
  const run = fixture({ tamperResponse: true });
  await assert.rejects(
    execute(run.client),
    (error: unknown) => error instanceof ConfidentialInferenceError
      && error.disposition === "execution_uncertain"
      && error.code === "confidential_response_authentication_failed",
  );
  assert.equal(run.stats().executeCalls, 1);
  assert.equal(run.stats().conventionalCalls, 0);
});
