import crypto from "node:crypto";
import type { Request } from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { User, UserPasskey } from "./types.js";

/**
 * Passkeys (WebAuthn).
 *
 * Challenges are short-lived and single-use, held in memory because the
 * control plane is a single process. A restart during a ceremony simply asks
 * the browser to start again. Credentials are stored on the user record as a
 * base64url public key plus the signature counter.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 500;

type ChallengeKind = "registration" | "authentication";

type PendingChallenge = {
  kind: ChallengeKind;
  challenge: string;
  userId?: string;
  expiresAt: number;
};

const pending = new Map<string, PendingChallenge>();

export class PasskeyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function prune(now = Date.now()): void {
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
  while (pending.size >= MAX_PENDING_CHALLENGES) {
    const oldest = pending.keys().next().value;
    if (!oldest) break;
    pending.delete(oldest);
  }
}

function issueChallenge(entry: Omit<PendingChallenge, "expiresAt">): string {
  prune();
  const id = crypto.randomBytes(24).toString("base64url");
  pending.set(id, { ...entry, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return id;
}

function consumeChallenge(id: unknown, kind: ChallengeKind): PendingChallenge {
  const key = typeof id === "string" ? id : "";
  const entry = key ? pending.get(key) : undefined;
  if (key) pending.delete(key);
  if (!entry || entry.kind !== kind || entry.expiresAt <= Date.now()) {
    throw new PasskeyError(400, "challenge_expired");
  }
  return entry;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

/**
 * WebAuthn binds a credential to one RP ID and origin. Behind a proxy the
 * forwarded headers are the public identity; an operator can pin both with
 * `MULTIVIBE_WEBAUTHN_RP_ID` and `MULTIVIBE_PUBLIC_ORIGIN`.
 */
export function relyingParty(req: Request): { rpID: string; origin: string } {
  const pinnedOrigin = process.env.MULTIVIBE_PUBLIC_ORIGIN?.trim();
  const pinnedRpID = process.env.MULTIVIBE_WEBAUTHN_RP_ID?.trim();
  if (pinnedOrigin) {
    const url = new URL(pinnedOrigin);
    return { rpID: pinnedRpID || url.hostname, origin: url.origin };
  }
  const proto =
    firstHeader(req.headers["x-forwarded-proto"]) ?? req.protocol ?? "http";
  const host =
    firstHeader(req.headers["x-forwarded-host"]) ??
    firstHeader(req.headers.host) ??
    "localhost";
  const origin = `${proto}://${host}`;
  return { rpID: pinnedRpID || new URL(origin).hostname, origin };
}

function transports(passkey: UserPasskey): string[] | undefined {
  return passkey.transports?.length ? passkey.transports : undefined;
}

export async function registrationOptions(user: User, req: Request) {
  const { rpID } = relyingParty(req);
  const options = await generateRegistrationOptions({
    rpName: "MultiVibe",
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.name || user.email,
    attestationType: "none",
    excludeCredentials: (user.passkeys ?? []).map((passkey) => ({
      id: passkey.id,
      ...(transports(passkey) ? { transports: transports(passkey) } : {}),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  const flowId = issueChallenge({
    kind: "registration",
    challenge: options.challenge,
    userId: user.id,
  });
  return { flowId, options };
}

export async function finishRegistration(
  req: Request,
  user: User,
  flowId: unknown,
  response: RegistrationResponseJSON,
  name: unknown,
): Promise<UserPasskey> {
  const challenge = consumeChallenge(flowId, "registration");
  if (challenge.userId !== user.id) throw new PasskeyError(400, "challenge_expired");
  const { rpID, origin } = relyingParty(req);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch {
    throw new PasskeyError(400, "registration_failed");
  }
  if (!verified.verified || !verified.registrationInfo) {
    throw new PasskeyError(400, "registration_failed");
  }
  if ((user.passkeys ?? []).length >= 10) {
    throw new PasskeyError(409, "too_many_passkeys");
  }
  const { credential } = verified.registrationInfo;
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : "Passkey";
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    ...(credential.transports?.length ? { transports: credential.transports } : {}),
    name: label,
    createdAt: Date.now(),
  };
}

export async function authenticationOptions(req: Request, user?: User) {
  const { rpID } = relyingParty(req);
  const allowCredentials = (user?.passkeys ?? []).map((passkey) => ({
    id: passkey.id,
    ...(transports(passkey) ? { transports: transports(passkey) } : {}),
  }));
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    ...(allowCredentials.length ? { allowCredentials } : {}),
  });
  const flowId = issueChallenge({
    kind: "authentication",
    challenge: options.challenge,
    ...(user ? { userId: user.id } : {}),
  });
  return { flowId, options };
}

export function findPasskeyOwner(
  users: User[],
  credentialId: string,
): { user: User; passkey: UserPasskey } | undefined {
  for (const user of users) {
    const passkey = (user.passkeys ?? []).find((entry) => entry.id === credentialId);
    if (passkey) return { user, passkey };
  }
  return undefined;
}

export async function finishAuthentication(
  req: Request,
  flowId: unknown,
  response: AuthenticationResponseJSON,
  resolve: (credentialId: string) => { user: User; passkey: UserPasskey } | undefined,
) {
  const challenge = consumeChallenge(flowId, "authentication");
  const credentialId = typeof response?.id === "string" ? response.id : "";
  const owner = credentialId ? resolve(credentialId) : undefined;
  if (!owner) throw new PasskeyError(401, "invalid_credentials");
  if (challenge.userId && challenge.userId !== owner.user.id) {
    throw new PasskeyError(401, "invalid_credentials");
  }
  const { rpID, origin } = relyingParty(req);
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: owner.passkey.id,
        publicKey: new Uint8Array(Buffer.from(owner.passkey.publicKey, "base64url")),
        counter: owner.passkey.counter,
        ...(transports(owner.passkey) ? { transports: transports(owner.passkey) } : {}),
      },
      requireUserVerification: false,
    });
  } catch {
    throw new PasskeyError(401, "invalid_credentials");
  }
  if (!verified.verified) throw new PasskeyError(401, "invalid_credentials");
  return {
    user: owner.user,
    passkeyId: owner.passkey.id,
    counter: verified.authenticationInfo.newCounter,
  };
}
