import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import {
  authenticationOptions,
  finishAuthentication,
  findPasskeyOwner,
  PasskeyError,
  registrationOptions,
  relyingParty,
} from "./passkeys.js";
import type { User, UserPasskey } from "./types.js";

function request(headers: Record<string, string>, protocol = "http"): Request {
  return { headers, protocol } as unknown as Request;
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: "usr_passkey",
    email: "member@example.com",
    name: "Member",
    role: "member",
    status: "active",
    quota: { period: "month" },
    usage: { requests: 0, tokens: 0, costUsd: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const passkey: UserPasskey = {
  id: "credential-id",
  publicKey: Buffer.from("public-key").toString("base64url"),
  counter: 0,
  transports: ["internal"],
  name: "Laptop",
  createdAt: Date.now(),
};

test("the relying party follows forwarded headers and explicit overrides", () => {
  const previousOrigin = process.env.MULTIVIBE_PUBLIC_ORIGIN;
  const previousRpID = process.env.MULTIVIBE_WEBAUTHN_RP_ID;
  delete process.env.MULTIVIBE_PUBLIC_ORIGIN;
  delete process.env.MULTIVIBE_WEBAUTHN_RP_ID;
  try {
    assert.deepEqual(
      relyingParty(request({ host: "127.0.0.1:1456", "x-forwarded-proto": "https" })),
      { rpID: "127.0.0.1", origin: "https://127.0.0.1:1456" },
    );
    assert.deepEqual(
      relyingParty(
        request({ host: "internal:1456", "x-forwarded-host": "vibe.example.com, proxy", "x-forwarded-proto": "https" }),
      ),
      { rpID: "vibe.example.com", origin: "https://vibe.example.com" },
    );
    process.env.MULTIVIBE_PUBLIC_ORIGIN = "https://app.example.com";
    assert.deepEqual(relyingParty(request({ host: "ignored" })), {
      rpID: "app.example.com",
      origin: "https://app.example.com",
    });
    process.env.MULTIVIBE_WEBAUTHN_RP_ID = "example.com";
    assert.equal(relyingParty(request({ host: "ignored" })).rpID, "example.com");
  } finally {
    if (previousOrigin === undefined) delete process.env.MULTIVIBE_PUBLIC_ORIGIN;
    else process.env.MULTIVIBE_PUBLIC_ORIGIN = previousOrigin;
    if (previousRpID === undefined) delete process.env.MULTIVIBE_WEBAUTHN_RP_ID;
    else process.env.MULTIVIBE_WEBAUTHN_RP_ID = previousRpID;
  }
});

test("registration options exclude existing credentials", async () => {
  const { flowId, options } = await registrationOptions(
    user({ passkeys: [passkey] }),
    request({ host: "localhost:1456" }),
  );
  assert.ok(flowId);
  assert.equal(options.rp.id, "localhost");
  assert.equal(options.user.name, "member@example.com");
  assert.deepEqual(options.excludeCredentials?.map((entry) => entry.id), ["credential-id"]);
});

test("authentication challenges are single-use and refuse unknown credentials", async () => {
  const req = request({ host: "localhost:1456" });
  const { flowId, options } = await authenticationOptions(req, user({ passkeys: [passkey] }));
  assert.deepEqual(options.allowCredentials?.map((entry) => entry.id), ["credential-id"]);

  const response = { id: "unknown", rawId: "unknown", type: "public-key", response: {} } as any;
  await assert.rejects(
    finishAuthentication(req, flowId, response, () => undefined),
    (error: unknown) => error instanceof PasskeyError && error.code === "invalid_credentials",
  );
  // The failed ceremony consumed the challenge, so a replay fails earlier.
  await assert.rejects(
    finishAuthentication(req, flowId, response, () => undefined),
    (error: unknown) => error instanceof PasskeyError && error.code === "challenge_expired",
  );
  await assert.rejects(
    finishAuthentication(req, "missing", response, () => undefined),
    (error: unknown) => error instanceof PasskeyError && error.status === 400,
  );
});

test("a credential resolves to its owner and nothing else", () => {
  const owner = user({ passkeys: [passkey] });
  assert.equal(findPasskeyOwner([user(), owner], "credential-id")?.user.id, "usr_passkey");
  assert.deepEqual(findPasskeyOwner([user()], "credential-id"), undefined);
});
