import { randomUUID } from "node:crypto";
import { promises as fs, type FileHandle } from "node:fs";
import path from "node:path";
import type { AccountStore } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOTSTRAP_TOKEN = /^mvmb_[A-Za-z0-9_-]{43}$/;
const INSTANCE_TOKEN = /^mvmi_[A-Za-z0-9_-]{43,128}$/;
const INSTANCE_REFRESH_TOKEN = /^mvir_[A-Za-z0-9_-]{43,128}$/;
const TEAM_KEY = /^mvt_[A-Za-z0-9_-]{32,128}$/;
const CLAIM_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CLAIM_NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_PROFILE_BYTES = 16 * 1024;
const MAX_BOOTSTRAP_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type ManagedEnrollmentChannel = "device" | "user";
export type ManagedEnrollmentDeviceClaim = Readonly<{ issuer: string; subject: string; nonce: string }>;

export type ManagedTeamEnrollmentProfile = Readonly<{
  schemaVersion: "multivibe-managed-enrollment-v1";
  profileId: string;
  managementChannel: ManagedEnrollmentChannel;
  organizationId: string;
  membershipId: string;
  deviceClaim: ManagedEnrollmentDeviceClaim | null;
  instanceName: string;
  bootstrapToken: string;
  cloudApiOrigin: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type TeamInstanceIdentity = Readonly<{
  instanceId: string;
  publicKeySpki: string;
  encryptionPublicKeySpki: string;
}>;

export type TeamInstanceEnvelope = Readonly<{
  schemaVersion: "multivibe-team-instance-envelope-v1";
  instanceId: string;
  issuedAt: string;
  payload: unknown;
  signature: string;
}>;

export type ManagedTeamEnrollmentResult = Readonly<{
  schemaVersion: "multivibe-managed-enrollment-result-v1";
  enrollmentId: string;
  organizationId: string;
  membershipId: string;
  instanceId: string;
  managementChannel: ManagedEnrollmentChannel;
  deviceClaim: ManagedEnrollmentDeviceClaim | null;
  instanceAccessToken: string;
  instanceRefreshToken: string;
  instanceAccessTokenExpiresAt: number;
  teamPersonalKey: Readonly<{
    id: string;
    secret: string;
    prefix: string;
    expiresAt: number;
  }>;
}>;

export type ManagedTeamEnrollmentStatus = Readonly<{
  schemaVersion: "multivibe-managed-enrollment-status-v1";
  state: "unmanaged" | "pending" | "enrolled";
  profileId?: string;
  organizationId?: string;
  membershipId?: string;
  instanceId?: string;
  managementChannel?: ManagedEnrollmentChannel;
  deviceClaim?: ManagedEnrollmentDeviceClaim | null;
  enrollmentId?: string;
  teamKeyPrefix?: string;
  enrolledAt?: number;
}>;

type EnrollmentState = Readonly<{
  schemaVersion: "multivibe-managed-enrollment-state-v1";
  state: "pending" | "enrolled";
  profileId: string;
  organizationId: string;
  membershipId: string;
  instanceId: string;
  managementChannel: ManagedEnrollmentChannel;
  deviceClaim: ManagedEnrollmentDeviceClaim | null;
  enrollmentId?: string;
  teamKeyPrefix?: string;
  enrolledAt?: number;
}>;

export interface ManagedEnrollmentIdentity {
  getIdentity(): TeamInstanceIdentity;
  signRequest(payload: unknown): TeamInstanceEnvelope;
}

export interface ManagedEnrollmentInstaller {
  install(result: ManagedTeamEnrollmentResult, profile: ManagedTeamEnrollmentProfile): Promise<void>;
}

export class AccountStoreManagedEnrollmentInstaller implements ManagedEnrollmentInstaller {
  constructor(private readonly store: AccountStore, private readonly now = Date.now) {}

  async install(result: ManagedTeamEnrollmentResult, profile: ManagedTeamEnrollmentProfile): Promise<void> {
    const settings = await this.store.getSettings();
    const connected = settings.multivibeTeam;
    if (connected && (connected.instanceId !== result.instanceId
      || connected.organizationId && connected.organizationId !== result.organizationId
      || connected.membershipId && connected.membershipId !== result.membershipId)) {
      throw new Error("Managed enrollment conflicts with the existing Team connection");
    }
    if (settings.multivibeCloud && !connected?.managedEnrollmentId) {
      throw new Error("Managed enrollment cannot replace an interactive Cloud connection");
    }
    const application = `managed-team-${result.membershipId.slice(0, 8)}`;
    const keys = this.store.getCachedProxyApiKeys();
    const byID = keys.find(entry => entry.id === result.teamPersonalKey.id);
    const byApplication = keys.find(entry => entry.application === application);
    if (byID && (byID.key !== result.teamPersonalKey.secret || byID.application !== application)
      || byApplication && (byApplication.id !== result.teamPersonalKey.id || byApplication.key !== result.teamPersonalKey.secret)) {
      throw new Error("Managed enrollment Team key conflicts with local state");
    }
    if (!byID) {
      await this.store.addProxyApiKey({
        id: result.teamPersonalKey.id, application, key: result.teamPersonalKey.secret, createdAt: this.now(),
        principal: { type: "member", id: result.membershipId },
      });
    }
    await this.store.patchSettings({
      multivibeCloud: { accessToken: result.instanceAccessToken, refreshToken: result.instanceRefreshToken, expiresAt: result.instanceAccessTokenExpiresAt },
      multivibeTeam: {
        enabled: true, instanceId: result.instanceId, instanceName: profile.instanceName,
        syncCursor: connected?.syncCursor ?? 0, lastSuccessfulSyncAt: connected?.lastSuccessfulSyncAt,
        lastSuccessfulAnalyticsUploadAt: connected?.lastSuccessfulAnalyticsUploadAt,
        organizationId: result.organizationId, membershipId: result.membershipId,
        managementChannel: result.managementChannel, deviceClaim: result.deviceClaim,
        managedEnrollmentId: result.enrollmentId, teamKeyId: result.teamPersonalKey.id,
      },
    });
  }
}

function exactObject(value: unknown, keys: readonly string[], error: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(error);
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(error);
  return value as Record<string, unknown>;
}

function productionOrLoopbackOrigin(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Managed enrollment Cloud origin is invalid");
  const parsed = new URL(raw);
  const production = parsed.protocol === "https:" && parsed.hostname === "app.multivibe.cloud" && parsed.port === "";
  const loopback = parsed.protocol === "http:" && ["127.0.0.1", "::1"].includes(parsed.hostname) && parsed.port !== "";
  if ((!production && !loopback) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Managed enrollment Cloud origin is invalid");
  }
  return parsed.origin;
}

function sameDeviceClaim(left: unknown, right: ManagedEnrollmentDeviceClaim | null): boolean {
  if (left === null || right === null) return left === right;
  try {
    const value = exactObject(left, ["issuer", "subject", "nonce"], "Managed enrollment device claim is invalid");
    return value.issuer === right.issuer && value.subject === right.subject && value.nonce === right.nonce;
  } catch { return false; }
}

export function validateManagedTeamEnrollmentProfile(value: unknown, now = Date.now()): ManagedTeamEnrollmentProfile {
  const profile = exactObject(value, [
    "schemaVersion", "profileId", "managementChannel", "organizationId", "membershipId", "deviceClaim",
    "instanceName", "bootstrapToken", "cloudApiOrigin", "issuedAt", "expiresAt",
  ], "Managed enrollment profile is invalid");
  const channel = profile.managementChannel;
  const claim = profile.deviceClaim === null ? null : exactObject(profile.deviceClaim, ["issuer", "subject", "nonce"], "Managed enrollment device claim is invalid");
  if (profile.schemaVersion !== "multivibe-managed-enrollment-v1"
    || typeof profile.profileId !== "string" || !UUID.test(profile.profileId)
    || (channel !== "device" && channel !== "user")
    || typeof profile.organizationId !== "string" || !UUID.test(profile.organizationId)
    || typeof profile.membershipId !== "string" || !UUID.test(profile.membershipId)
    || (claim !== null && (typeof claim.issuer !== "string" || !CLAIM_COMPONENT.test(claim.issuer)
      || typeof claim.subject !== "string" || !CLAIM_COMPONENT.test(claim.subject)
      || typeof claim.nonce !== "string" || !CLAIM_NONCE.test(claim.nonce)))
    || (channel === "device" && claim === null)
    || typeof profile.instanceName !== "string" || profile.instanceName.trim() !== profile.instanceName
    || profile.instanceName.length < 1 || profile.instanceName.length > 80
    || typeof profile.bootstrapToken !== "string" || !BOOTSTRAP_TOKEN.test(profile.bootstrapToken)
    || !Number.isSafeInteger(profile.issuedAt) || !Number.isSafeInteger(profile.expiresAt)
    || profile.expiresAt <= profile.issuedAt || profile.expiresAt - profile.issuedAt > MAX_BOOTSTRAP_LIFETIME_MS
    || profile.issuedAt > now + CLOCK_SKEW_MS || profile.expiresAt <= now) {
    throw new Error("Managed enrollment profile is invalid or expired");
  }
  return Object.freeze({
    schemaVersion: "multivibe-managed-enrollment-v1",
    profileId: profile.profileId,
    managementChannel: channel,
    organizationId: profile.organizationId,
    membershipId: profile.membershipId,
    deviceClaim: claim as ManagedEnrollmentDeviceClaim | null,
    instanceName: profile.instanceName,
    bootstrapToken: profile.bootstrapToken,
    cloudApiOrigin: productionOrLoopbackOrigin(profile.cloudApiOrigin),
    issuedAt: profile.issuedAt,
    expiresAt: profile.expiresAt,
  });
}

function validateIdentity(value: TeamInstanceIdentity): TeamInstanceIdentity {
  if (!value || !UUID.test(value.instanceId) || typeof value.publicKeySpki !== "string" || value.publicKeySpki.length < 80
    || value.publicKeySpki.length > 2048 || typeof value.encryptionPublicKeySpki !== "string"
    || value.encryptionPublicKeySpki.length < 80 || value.encryptionPublicKeySpki.length > 2048) {
    throw new Error("Managed enrollment instance identity is invalid");
  }
  return value;
}

function validateEnrollmentResult(value: unknown, profile: ManagedTeamEnrollmentProfile, identity: TeamInstanceIdentity, now: number): ManagedTeamEnrollmentResult {
  const result = exactObject(value, [
    "schemaVersion", "enrollmentId", "organizationId", "membershipId", "instanceId", "managementChannel",
    "deviceClaim", "instanceAccessToken", "instanceRefreshToken", "instanceAccessTokenExpiresAt", "teamPersonalKey",
  ], "Managed enrollment result is invalid");
  const key = exactObject(result.teamPersonalKey, ["id", "secret", "prefix", "expiresAt"], "Managed enrollment result is invalid");
  if (result.schemaVersion !== "multivibe-managed-enrollment-result-v1"
    || typeof result.enrollmentId !== "string" || !UUID.test(result.enrollmentId)
    || result.organizationId !== profile.organizationId || result.membershipId !== profile.membershipId
    || result.instanceId !== identity.instanceId || result.managementChannel !== profile.managementChannel
    || !sameDeviceClaim(result.deviceClaim, profile.deviceClaim) || typeof result.instanceAccessToken !== "string"
    || !INSTANCE_TOKEN.test(result.instanceAccessToken) || typeof result.instanceRefreshToken !== "string"
    || !INSTANCE_REFRESH_TOKEN.test(result.instanceRefreshToken) || !Number.isSafeInteger(result.instanceAccessTokenExpiresAt)
    || (result.instanceAccessTokenExpiresAt as number) <= now || typeof key.id !== "string" || !UUID.test(key.id)
    || typeof key.secret !== "string" || !TEAM_KEY.test(key.secret) || typeof key.prefix !== "string"
    || key.prefix !== key.secret.slice(0, 12) || !Number.isSafeInteger(key.expiresAt) || (key.expiresAt as number) <= now) {
    throw new Error("Managed enrollment result is invalid or mismatched");
  }
  return result as unknown as ManagedTeamEnrollmentResult;
}

async function readStablePrivateFile(filename: string, platform = process.platform): Promise<string> {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) throw new Error("Managed enrollment path must be a clean absolute path");
  let handle: FileHandle | undefined;
  try {
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > MAX_PROFILE_BYTES
      || (platform !== "win32" && (before.mode & 0o077) !== 0)) {
      throw new Error("Managed enrollment file must be a bounded private regular file");
    }
    handle = await fs.open(filename, "r");
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Managed enrollment file changed while opening");
    const raw = await handle.readFile("utf8");
    const after = await fs.lstat(filename);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) throw new Error("Managed enrollment file changed while reading");
    return raw;
  } finally {
    await handle?.close();
  }
}

async function readState(filename: string): Promise<EnrollmentState | undefined> {
  try {
    const parsed = JSON.parse(await readStablePrivateFile(filename)) as EnrollmentState;
    const value = exactObject(parsed, parsed.state === "enrolled"
      ? ["schemaVersion", "state", "profileId", "organizationId", "membershipId", "instanceId", "managementChannel", "deviceClaim", "enrollmentId", "teamKeyPrefix", "enrolledAt"]
      : ["schemaVersion", "state", "profileId", "organizationId", "membershipId", "instanceId", "managementChannel", "deviceClaim"], "Managed enrollment state is invalid");
    if (value.schemaVersion !== "multivibe-managed-enrollment-state-v1" || !["pending", "enrolled"].includes(String(value.state))
      || !UUID.test(String(value.profileId)) || !UUID.test(String(value.organizationId)) || !UUID.test(String(value.membershipId))
      || !UUID.test(String(value.instanceId)) || !["device", "user"].includes(String(value.managementChannel))) throw new Error("Managed enrollment state is invalid");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePrivateState(filename: string, state: EnrollmentState): Promise<void> {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) throw new Error("Managed enrollment state path must be a clean absolute path");
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.lstat(filename);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Managed enrollment state path is unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filename);
    if (process.platform !== "win32") await fs.chmod(filename, 0o600);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function publicStatus(state: EnrollmentState | undefined): ManagedTeamEnrollmentStatus {
  if (!state) return Object.freeze({ schemaVersion: "multivibe-managed-enrollment-status-v1", state: "unmanaged" });
  return Object.freeze({
    schemaVersion: "multivibe-managed-enrollment-status-v1", state: state.state,
    profileId: state.profileId, organizationId: state.organizationId, membershipId: state.membershipId,
    instanceId: state.instanceId, managementChannel: state.managementChannel, deviceClaim: state.deviceClaim,
    ...(state.state === "enrolled" ? { enrollmentId: state.enrollmentId, teamKeyPrefix: state.teamKeyPrefix, enrolledAt: state.enrolledAt } : {}),
  });
}

export class ManagedTeamEnrollmentService {
  private operation?: Promise<ManagedTeamEnrollmentStatus>;
  constructor(private readonly options: Readonly<{
    profilePath: string;
    statePath: string;
    identity: ManagedEnrollmentIdentity;
    installer: ManagedEnrollmentInstaller;
    appVersion: string;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
  }>) {}

  async status(): Promise<ManagedTeamEnrollmentStatus> {
    return publicStatus(await readState(this.options.statePath));
  }

  enrollIfPresent(): Promise<ManagedTeamEnrollmentStatus> {
    if (!this.operation) this.operation = this.enroll().finally(() => { this.operation = undefined; });
    return this.operation;
  }

  private async enroll(): Promise<ManagedTeamEnrollmentStatus> {
    const current = await readState(this.options.statePath);
    let raw: string;
    try { raw = await readStablePrivateFile(this.options.profilePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return publicStatus(current);
      throw error;
    }
    const now = this.options.now?.() ?? Date.now();
    const profile = validateManagedTeamEnrollmentProfile(JSON.parse(raw), now);
    const identity = validateIdentity(this.options.identity.getIdentity());
    if (current?.state === "enrolled" && current.profileId === profile.profileId && current.instanceId === identity.instanceId) {
      await fs.rm(this.options.profilePath, { force: true });
      return publicStatus(current);
    }
    if (current && (current.profileId !== profile.profileId || current.instanceId !== identity.instanceId)) {
      throw new Error("Managed enrollment profile conflicts with local state");
    }
    const pending: EnrollmentState = Object.freeze({
      schemaVersion: "multivibe-managed-enrollment-state-v1", state: "pending", profileId: profile.profileId,
      organizationId: profile.organizationId, membershipId: profile.membershipId, instanceId: identity.instanceId,
      managementChannel: profile.managementChannel, deviceClaim: profile.deviceClaim,
    });
    if (!current) await writePrivateState(this.options.statePath, pending);
    const payload = {
      schemaVersion: "multivibe-team-managed-enrollment-v1", profileId: profile.profileId,
      organizationId: profile.organizationId, membershipId: profile.membershipId,
      managementChannel: profile.managementChannel, deviceClaim: profile.deviceClaim,
      instance: { id: identity.instanceId, name: profile.instanceName, publicKeySpki: identity.publicKeySpki,
        encryptionPublicKeySpki: identity.encryptionPublicKeySpki, version: this.options.appVersion },
    } as const;
    const envelope = this.options.identity.signRequest(payload);
    if (envelope.instanceId !== identity.instanceId) throw new Error("Managed enrollment signature identity is inconsistent");
    const response = await (this.options.fetch ?? globalThis.fetch)(`${profile.cloudApiOrigin}/team/v1/instances/managed-enroll`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${profile.bootstrapToken}`, "content-type": "application/json", "idempotency-key": profile.profileId },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Managed enrollment was rejected (${response.status})`);
    }
    let decoded: unknown;
    try { decoded = JSON.parse(await response.text()); }
    catch { throw new Error("Managed enrollment returned an invalid response"); }
    const result = validateEnrollmentResult(decoded, profile, identity, this.options.now?.() ?? Date.now());
    await this.options.installer.install(result, profile);
    const enrolled: EnrollmentState = Object.freeze({
      ...pending, state: "enrolled", enrollmentId: result.enrollmentId,
      teamKeyPrefix: result.teamPersonalKey.prefix, enrolledAt: this.options.now?.() ?? Date.now(),
    });
    await writePrivateState(this.options.statePath, enrolled);
    await fs.rm(this.options.profilePath, { force: true });
    return publicStatus(enrolled);
  }
}
