import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AccountStoreManagedEnrollmentInstaller,
  ManagedTeamEnrollmentService,
  validateManagedTeamEnrollmentProfile,
  type ManagedTeamEnrollmentResult,
} from "./managed-team-enrollment.js";
import { AccountStore } from "./store.js";

const now = Date.UTC(2026, 8, 10, 10, 0, 0);
const organizationId = "10000000-0000-4000-8000-000000000001";
const membershipId = "20000000-0000-4000-8000-000000000002";
const instanceId = "30000000-0000-4000-8000-000000000003";
const profileId = "40000000-0000-4000-8000-000000000004";
const deviceClaim = { issuer: "com.jamf.inventory", subject: "serial:C02TEST", nonce: "a".repeat(22) } as const;

function profile(origin = "https://app.multivibe.cloud") {
  return {
    schemaVersion: "multivibe-managed-enrollment-v1", profileId, managementChannel: "device",
    organizationId, membershipId, deviceClaim, instanceName: "Alice MacBook",
    bootstrapToken: `mvmb_${"a".repeat(43)}`, cloudApiOrigin: origin, issuedAt: now - 60_000, expiresAt: now + 60_000,
  } as const;
}

function result(): ManagedTeamEnrollmentResult {
  const secret = `mvt_${"c".repeat(43)}`;
  return {
    schemaVersion: "multivibe-managed-enrollment-result-v1", enrollmentId: "50000000-0000-4000-8000-000000000005",
    organizationId, membershipId, instanceId, managementChannel: "device", deviceClaim,
    instanceAccessToken: `mvmi_${"b".repeat(43)}`, instanceRefreshToken: `mvir_${"d".repeat(43)}`,
    instanceAccessTokenExpiresAt: now + 3_600_000,
    teamPersonalKey: { id: "60000000-0000-4000-8000-000000000006", secret, prefix: secret.slice(0, 12), expiresAt: now + 86_400_000 },
  };
}

function identity() {
  const keys = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    getIdentity: () => ({ instanceId, publicKeySpki: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      encryptionPublicKeySpki: encryption.publicKey.export({ format: "pem", type: "spki" }).toString() }),
    signRequest(payload: unknown) {
      const issuedAt = new Date(now).toISOString();
      const canonical = JSON.stringify({ instanceId, issuedAt, payload });
      return { schemaVersion: "multivibe-team-instance-envelope-v1" as const, instanceId, issuedAt, payload,
        signature: sign(null, Buffer.from(canonical), keys.privateKey).toString("base64url") };
    },
  };
}

test("managed profiles are exact, employee-bound, short lived and use trusted Cloud origins", () => {
  assert.equal(validateManagedTeamEnrollmentProfile(profile(), now).membershipId, membershipId);
  for (const value of [
    { ...profile(), employeeEmail: "alice@example.test" },
    { ...profile(), managementChannel: "device", deviceClaim: null },
    { ...profile(), cloudApiOrigin: "https://evil.test" },
    { ...profile(), expiresAt: now + 24 * 60 * 60 * 1000 + 1 },
    { ...profile(), bootstrapToken: `mvt_${"a".repeat(43)}` },
  ]) assert.throws(() => validateManagedTeamEnrollmentProfile(value, now));
  assert.equal(validateManagedTeamEnrollmentProfile({ ...profile(), managementChannel: "user", deviceClaim: null }, now).managementChannel, "user");
});

test("zero-touch enrollment proves the local identity, installs returned keys and consumes the bootstrap file", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".managed-enrollment-test-"));
  const profilePath = path.join(directory, "profile.json");
  const statePath = path.join(directory, "state.json");
  await fs.writeFile(profilePath, JSON.stringify(profile("http://127.0.0.1:9494")), { mode: 0o600 });
  const installed: ManagedTeamEnrollmentResult[] = [];
  let authorization = "";
  let requestBody: any;
  const service = new ManagedTeamEnrollmentService({ profilePath, statePath, identity: identity(), appVersion: "1.2.3", now: () => now,
    installer: { install: async value => { installed.push(value); } },
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(result()), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const status = await service.enrollIfPresent();
    assert.equal(status.state, "enrolled");
    assert.equal(status.teamKeyPrefix, result().teamPersonalKey.prefix);
    assert.equal("instanceAccessToken" in status, false);
    assert.equal("secret" in status, false);
    assert.equal(authorization, `Bearer ${profile().bootstrapToken}`);
    assert.equal(requestBody.payload.membershipId, membershipId);
    assert.equal(requestBody.payload.instance.id, instanceId);
    assert.equal(requestBody.payload.instance.version, "1.2.3");
    assert.equal(installed.length, 1);
    await assert.rejects(fs.access(profilePath));
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("failed or mismatched enrollment remains pending and keeps the bootstrap for retry", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".managed-enrollment-test-"));
  const profilePath = path.join(directory, "profile.json");
  const statePath = path.join(directory, "state.json");
  await fs.writeFile(profilePath, JSON.stringify(profile("http://127.0.0.1:9494")), { mode: 0o600 });
  const service = new ManagedTeamEnrollmentService({ profilePath, statePath, identity: identity(), appVersion: "1.2.3", now: () => now,
    installer: { install: async () => assert.fail("mismatched result must not be installed") },
    fetch: async () => new Response(JSON.stringify({ ...result(), membershipId: randomUUID() }), { status: 200 }),
  });
  try {
    await assert.rejects(service.enrollIfPresent(), /mismatched/);
    assert.equal((await service.status()).state, "pending");
    await fs.access(profilePath);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("the AccountStore installer links the member, local key and renewable Cloud connection idempotently", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".managed-enrollment-test-"));
  const store = new AccountStore(path.join(directory, "accounts.json"));
  try {
    await store.init();
    const installer = new AccountStoreManagedEnrollmentInstaller(store, () => now);
    await installer.install(result(), profile());
    await installer.install(result(), profile());
    const keys = await store.listProxyApiKeys();
    assert.equal(keys.length, 1);
    assert.deepEqual(keys[0].principal, { type: "member", id: membershipId });
    const settings = await store.getSettings();
    assert.equal(settings.multivibeCloud?.accessToken, result().instanceAccessToken);
    assert.equal(settings.multivibeCloud?.refreshToken, result().instanceRefreshToken);
    assert.equal(settings.multivibeTeam?.membershipId, membershipId);
    assert.equal(settings.multivibeTeam?.managementChannel, "device");
    assert.equal(settings.multivibeTeam?.managedEnrollmentId, result().enrollmentId);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("world-readable and symlinked bootstrap files are rejected on POSIX", { skip: process.platform === "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".managed-enrollment-test-"));
  const target = path.join(directory, "target.json");
  const link = path.join(directory, "link.json");
  const statePath = path.join(directory, "state.json");
  await fs.writeFile(target, JSON.stringify(profile("http://127.0.0.1:9494")), { mode: 0o644 });
  await fs.symlink(target, link);
  const options = { statePath, identity: identity(), appVersion: "1.2.3", now: () => now,
    installer: { install: async () => undefined }, fetch: async () => new Response(JSON.stringify(result())) };
  try {
    await assert.rejects(new ManagedTeamEnrollmentService({ ...options, profilePath: target }).enrollIfPresent(), /private regular file/);
    await fs.chmod(target, 0o600);
    await assert.rejects(new ManagedTeamEnrollmentService({ ...options, profilePath: link }).enrollIfPresent(), /private regular file/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
