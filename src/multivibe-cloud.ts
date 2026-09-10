import type { TeamMachineDirectory } from "./team-machine-directory.js";
import type { TeamMachineSharing } from "./team-machine-sharing.js";
import type { SignedMachinePolicy } from "./team-machine-protocol.js";
import { readCloudModelCatalog } from "./cloud-model-catalog.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { AccountStore, OAuthStateStore } from "./store.js";
import type { Account, OAuthFlowState, PrivacyMode, StoreSettings } from "./types.js";
import type { MultivibeTeamSyncService, TeamSyncManifest } from "./team-sync.js";
import type { ManagedEnrollmentIdentity } from "./managed-team-enrollment.js";

const CLIENT_ID = "multivibe-core";
const ACCOUNT_ID = "multivibe-cloud";
const SCOPES = [
  "openid",
  "profile",
  "billing:read",
  "projects:read",
  "projects:write",
  "core:credential:create",
  "provider:read",
  "team:read",
  "team:instances",
  "team:providers",
  "team:analytics:write",
  "team:keys",
].join(" ");
const FLOW_LIFETIME_MS = 10 * 60_000;
const API_KEY_LIFETIME_MS = 365 * 24 * 60 * 60_000;
const API_KEY_RENEWAL_MARGIN_MS = 24 * 60 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORE_CALLBACK_PATH = "/admin/cloud/oauth/callback";

type CloudConnection = NonNullable<StoreSettings["multivibeCloud"]>;

class CloudHttpError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super("MultiVibe Cloud request failed");
    this.name = "CloudHttpError";
  }
}

export type MultivibeCloudStatus = {
  status: "disconnected" | "connected" | "unavailable";
  quota?: { status: "available" | "no_plan" | "unavailable"; name?: string; remainingPercent?: number; usedPercent?: number; resetsAt?: string };
  dollarCreditsUsd?: string;
  balanceUsd?: string;
  subscription?: string;
  apiKeyExpiresAt?: string;
  topupUrl: string;
  autoTopup?: {
    enabled: true;
    thresholdUsd: string;
    rechargeUsd: string;
  };
  workerEarnings?: {
    currency: "USD";
    lifetimeNetUsd: string;
    monthNetUsd: string;
    averageMonthlyNetUsd: string;
  };
};

export type MultivibeCloudServiceOptions = {
  authBaseUrl: string;
  apiBaseUrl: string;
  inferenceBaseUrl: string;
  redirectUri: string;
  topupUrl: string;
  privacyMode?: PrivacyMode;
  fetchImpl?: typeof fetch;
  managedTeamIdentity?: ManagedEnrollmentIdentity;
};

function normalizedOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new Error(`${label} must be an HTTP(S) origin`);
  }
  return parsed.origin;
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function usdValue(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text || !/^(?:0|[1-9]\d{0,12})(?:\.\d{1,6})?$/.test(text)) return undefined;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? text : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function autoTopupValue(value: unknown): MultivibeCloudStatus["autoTopup"] {
  const root = recordValue(value);
  if (root?.monetaryEffectsApplied !== true) return undefined;
  const data = recordValue(root?.current) ?? recordValue(root?.data) ?? root;
  if (!data || data.state !== "active") return undefined;
  const thresholdUsd = usdValue(data.thresholdUsd);
  const rechargeUsd = usdValue(data.rechargeUsd);
  return thresholdUsd && rechargeUsd
    ? { enabled: true, thresholdUsd, rechargeUsd }
    : undefined;
}

function workerEarningsValue(value: unknown): MultivibeCloudStatus["workerEarnings"] {
  const data = recordValue(value);
  if (data?.monetaryEffectsApplied !== true) return undefined;
  const lifetimeNetUsd = usdValue(data?.lifetimeNetUsd);
  const monthNetUsd = usdValue(data?.monthNetUsd);
  const averageMonthlyNetUsd = usdValue(data?.averageMonthlyNetUsd);
  return data?.currency === "USD" && lifetimeNetUsd && monthNetUsd && averageMonthlyNetUsd
    ? { currency: "USD", lifetimeNetUsd, monthNetUsd, averageMonthlyNetUsd }
    : undefined;
}

function expiresAtFromToken(value: unknown): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined;
}

function expiresAtFromApiKey(value: unknown, fallback: number): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > Date.now() ? parsed : fallback;
}

function validAccessToken(value: unknown): string {
  const token = stringValue(value);
  if (!token || token.length > 8192 || /\s/.test(token)) throw new Error("MultiVibe Cloud token response is invalid");
  return token;
}

function validRefreshToken(value: unknown): string | undefined {
  const token = stringValue(value);
  if (token && (token.length > 8192 || /\s/.test(token))) throw new Error("MultiVibe Cloud refresh token response is invalid");
  return token;
}

function currentCloudConnection(settings: StoreSettings): CloudConnection | undefined {
  const value = settings.multivibeCloud;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const accessToken = stringValue(value.accessToken);
  if (!accessToken || accessToken.length > 8192 || /\s/.test(accessToken)) return undefined;
  const rawRefreshToken = stringValue(value.refreshToken);
  if (rawRefreshToken && (rawRefreshToken.length > 8192 || /\s/.test(rawRefreshToken))) return undefined;
  const refreshToken = rawRefreshToken;
  const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
    ? value.expiresAt : undefined;
  const projectId = stringValue(value.projectId);
  const apiKeyExpiresAt = typeof value.apiKeyExpiresAt === "number" && Number.isFinite(value.apiKeyExpiresAt)
    ? value.apiKeyExpiresAt : undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(projectId ? { projectId } : {}),
    ...(apiKeyExpiresAt ? { apiKeyExpiresAt } : {}),
  };
}

function existingCloudAccount(accounts: Account[]): Account | undefined {
  return accounts.find((account) => account.id === ACCOUNT_ID && account.multivibeCloud);
}

function subscriptionLabel(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const plan = stringValue(record.planCode) ?? stringValue(record.plan_code) ?? stringValue(record.name);
  if (!plan) return undefined;
  return plan.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export class MultivibeCloudService {
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly inferenceBaseUrl: string;
  private readonly redirectUri: string;
  private readonly topupUrl: string;
  private readonly privacyMode: PrivacyMode;
  private readonly fetchImpl: typeof fetch;
  private readonly managedTeamIdentity?: ManagedEnrollmentIdentity;

  constructor(
    private readonly store: AccountStore,
    private readonly oauthStore: OAuthStateStore,
    options: MultivibeCloudServiceOptions,
  ) {
    this.authBaseUrl = normalizedOrigin(options.authBaseUrl, "MultiVibe Cloud auth base URL");
    this.apiBaseUrl = normalizedOrigin(options.apiBaseUrl, "MultiVibe Cloud API base URL");
    this.inferenceBaseUrl = normalizedOrigin(options.inferenceBaseUrl, "MultiVibe Cloud inference base URL");
    this.redirectUri = this.validRedirectUri(options.redirectUri);
    this.topupUrl = this.validHttpUrl(options.topupUrl, "MultiVibe Cloud top-up URL");
    this.privacyMode = options.privacyMode ?? "standard";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.managedTeamIdentity = options.managedTeamIdentity;
  }

  async getModelCatalog() {
    return { models: await readCloudModelCatalog(this.apiBaseUrl, this.fetchImpl) };
  }

  async syncTeam(teamSync:MultivibeTeamSyncService):Promise<void>{
    const settings=await this.store.getSettings();let connection=currentCloudConnection(settings);if(!connection)return;connection=await this.refreshConnectionIfNeeded(connection);const identity=teamSync.getIdentity();
    if(!settings.multivibeTeam?.enabled){await this.requestJson('/team/v1/instances/enroll',connection.accessToken,{method:'POST',body:teamSync.enrollmentDocument(settings.multivibeTeam?.instanceName??'Multivibe instance','core-0.2')});}
    const cursor=settings.multivibeTeam?.syncCursor??0;const manifest=await this.requestJson(`/team/v1/sync?cursor=${cursor}&instanceId=${encodeURIComponent(identity.instanceId)}`,connection.accessToken) as TeamSyncManifest;const applied=await teamSync.applyManifest(manifest);
    if(applied.applied.length||applied.removed.length){const revisions=new Map(manifest.providers.map(provider=>[provider.id,provider.revision]));await this.requestJson('/team/v1/acknowledgements',connection.accessToken,{method:'POST',body:teamSync.signRequest({schemaVersion:'multivibe-team-acknowledgements-v1',cursor:manifest.cursor,acknowledgements:[...applied.applied.map(providerId=>({providerId,revision:revisions.get(providerId)??manifest.cursor,status:'applied'})),...applied.removed.map(providerId=>({providerId,revision:manifest.cursor,status:'removed'}))]})});}
    const batch=teamSync.analyticsBatch();if(batch.buckets.length){const result=await this.requestJson('/team/v1/analytics/batches',connection.accessToken,{method:'POST',body:teamSync.signRequest(batch)}) as Record<string,unknown>;const accepted=Array.isArray(result.acceptedBucketIds)?result.acceptedBucketIds.filter(value=>typeof value==='string') as string[]:[];await teamSync.acknowledgeAnalytics(accepted);}
  }

  private validRedirectUri(value: string): string {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error("MultiVibe Cloud redirect URI must be an absolute URL"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || !parsed.pathname) {
      throw new Error("MultiVibe Cloud redirect URI is invalid");
    }
    return parsed.toString();
  }

  private validCoreCallbackOrigin(value: string): string {
    const origin = normalizedOrigin(value, "MultiVibe Core callback origin");
    const parsed = new URL(origin);
    const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1) : parsed.hostname;
    if (hostname !== "localhost" && isIP(hostname) === 0) {
      throw new Error("MultiVibe Core callback origin must use an IP address or localhost");
    }
    return new URL(CORE_CALLBACK_PATH, `${origin}/`).toString();
  }

  private validHttpUrl(value: string, label: string): string {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error(`${label} must be an absolute URL`); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`${label} is invalid`);
    }
    return parsed.toString();
  }

  async startConnection(callbackOrigin?: string): Promise<{ flowId: string; authorizeUrl: string }> {
    const redirectUri = callbackOrigin === undefined
      ? this.redirectUri : this.validCoreCallbackOrigin(callbackOrigin);
    const flow: OAuthFlowState = {
      id: randomUUID(),
      email: "",
      codeVerifier: randomBytes(32).toString("base64url"),
      redirectUri,
      createdAt: Date.now(),
      method: "browser",
      status: "pending",
    };
    await this.oauthStore.create(flow);
    const authorizeUrl = new URL(`${this.authBaseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", SCOPES);
    authorizeUrl.searchParams.set("state", flow.id);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge(flow.codeVerifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    return { flowId: flow.id, authorizeUrl: authorizeUrl.toString() };
  }

  async failConnection(flowId: string, message: string): Promise<void> {
    if (!UUID_PATTERN.test(flowId)) return;
    await this.oauthStore.update(flowId, {
      status: "error",
      error: message.slice(0, 300),
      completedAt: Date.now(),
    });
  }

  async completeConnection(flowId: string, code: string): Promise<void> {
    const flow = await this.oauthStore.get(flowId);
    if (!flow || flow.status !== "pending") throw new Error("Cloud connection flow is invalid or expired");
    if (flow.createdAt + FLOW_LIFETIME_MS <= Date.now()) throw new Error("Cloud connection flow is expired");
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(code)) throw new Error("Cloud authorization code is invalid");
    const redirectUri = flow.redirectUri ?? this.redirectUri;

    const response = await this.fetchImpl(`${this.authBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: flow.codeVerifier,
      }),
    });
    const tokenData = await this.readJson(response);
    if (!response.ok) throw new CloudHttpError(response.status);
    const accessToken = validAccessToken(tokenData.access_token);
    const refreshToken = validRefreshToken(tokenData.refresh_token);
    const expiresAt = expiresAtFromToken(tokenData.expires_in);
    const connection: CloudConnection = {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    await this.store.patchSettings({ multivibeCloud: connection });
    await this.ensureCloudAccount(connection);
    await this.oauthStore.update(flowId, { status: "success", completedAt: Date.now(), accountId: ACCOUNT_ID });
  }

  async disconnect(): Promise<void> {
    await this.store.patchSettings({ multivibeCloud: undefined });
    const account = existingCloudAccount(await this.store.listAccounts());
    if (account) await this.store.deleteAccount(account.id);
    await this.store.flushIfDirty();
  }

  async getStatus(): Promise<MultivibeCloudStatus> {
    const settings = await this.store.getSettings();
    let connection = currentCloudConnection(settings);
    if (!connection) return { status: "disconnected", topupUrl: this.topupUrl };

    try {
      connection = await this.refreshConnectionIfNeeded(connection);
      await this.ensureCloudAccount(connection);
      const account = existingCloudAccount(await this.store.listAccounts());
      if (!account) return { status: "disconnected", topupUrl: this.topupUrl };
      const [creditsResult, subscriptionResult, autoTopupResult, earningsResult] = await Promise.allSettled([
        this.requestJson("/client/v1/credits", connection.accessToken),
        this.requestJson("/client/v1/billing/subscription", connection.accessToken),
        this.requestJson("/client/v1/auto-recharge", connection.accessToken),
        this.requestJson("/provider/v1/earnings", connection.accessToken),
      ]);
      if (creditsResult.status !== "fulfilled") throw creditsResult.reason;
      const credits = creditsResult.value as Record<string, unknown>;
      const balance = usdValue(credits.totalAvailableUsd) ?? usdValue(credits.availableUsd);
      if (balance === undefined) throw new Error("MultiVibe Cloud balance response is invalid");
      const subscription = subscriptionResult.status === "fulfilled"
        ? subscriptionResult.value as Record<string, unknown> : undefined;
      const subscriptionName = subscriptionLabel(subscription?.data);
      const autoTopup = autoTopupResult.status === "fulfilled"
        ? autoTopupValue(autoTopupResult.value) : undefined;
      const workerEarnings = earningsResult.status === "fulfilled"
        ? workerEarningsValue(earningsResult.value) : undefined;
      return {
        status: "connected",
        balanceUsd: balance,
        ...(usdValue(credits.topUpAvailableUsd) !== undefined ? { dollarCreditsUsd: usdValue(credits.topUpAvailableUsd)! } : {}),
        ...(subscriptionName ? { subscription: subscriptionName } : {}),
        ...(account.expiresAt ? { apiKeyExpiresAt: new Date(account.expiresAt).toISOString() } : {}),
        topupUrl: this.topupUrl,
        ...(autoTopup ? { autoTopup } : {}),
        ...(workerEarnings ? { workerEarnings } : {}),
      };
    } catch (error) {
      if (error instanceof CloudHttpError && (error.status === 400 || error.status === 401
        || (error.status === 403 && error.code === "fresh_authentication_required"))) {
        return { status: "disconnected", topupUrl: this.topupUrl };
      }
      return { status: "unavailable", topupUrl: this.topupUrl };
    }
  }

  private async refreshConnectionIfNeeded(connection: CloudConnection): Promise<CloudConnection> {
    if (!connection.refreshToken || !connection.expiresAt || connection.expiresAt > Date.now() + 60_000) {
      return connection;
    }
    if (connection.refreshToken.startsWith("mvir_")) {
      if (!/^mvir_[A-Za-z0-9_-]{43}$/.test(connection.refreshToken) || !this.managedTeamIdentity) {
        throw new Error("Managed Team refresh state is invalid");
      }
      const settings = await this.store.getSettings();
      const enrollmentId = settings.multivibeTeam?.managedEnrollmentId;
      const identity = this.managedTeamIdentity.getIdentity();
      if (!enrollmentId || !UUID_PATTERN.test(enrollmentId)
        || settings.multivibeTeam?.instanceId !== identity.instanceId) {
        throw new Error("Managed Team refresh state is invalid");
      }
      const response = await this.fetchImpl(`${this.apiBaseUrl}/team/v1/instances/managed-refresh`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.refreshToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(this.managedTeamIdentity.signRequest({
          schemaVersion: "multivibe-team-managed-refresh-v1",
          enrollmentId,
        })),
      });
      const tokenData = await this.readJson(response);
      if (!response.ok) throw new CloudHttpError(response.status);
      const expiresIn = Number(tokenData.expiresIn);
      if (tokenData.schemaVersion !== "multivibe-managed-refresh-result-v1"
        || typeof tokenData.accessToken !== "string" || !/^mvmi_[A-Za-z0-9_-]{43}$/.test(tokenData.accessToken)
        || typeof tokenData.refreshToken !== "string" || !/^mvir_[A-Za-z0-9_-]{43}$/.test(tokenData.refreshToken)
        || !Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 86_400) {
        throw new Error("Managed Team refresh response is invalid");
      }
      const next: CloudConnection = {
        ...connection,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
      };
      await this.store.patchSettings({ multivibeCloud: next });
      return next;
    }
    const response = await this.fetchImpl(`${this.authBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: connection.refreshToken,
      }),
    });
    const tokenData = await this.readJson(response);
    if (!response.ok) throw new CloudHttpError(response.status);
    const expiresAt = expiresAtFromToken(tokenData.expires_in);
    const refreshToken = validRefreshToken(tokenData.refresh_token);
    const next: CloudConnection = {
      ...connection,
      accessToken: validAccessToken(tokenData.access_token),
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    await this.store.patchSettings({ multivibeCloud: next });
    return next;
  }

  private async ensureCloudAccount(connection: CloudConnection): Promise<void> {
    const accounts = await this.store.listAccounts();
    const current = existingCloudAccount(accounts);
    if (current && current.expiresAt && current.expiresAt > Date.now() + API_KEY_RENEWAL_MARGIN_MS) {
      if ((current.privacyMode ?? "standard") !== this.privacyMode) {
        await this.store.patchAccount(current.id, { privacyMode: this.privacyMode });
        await this.store.flushIfDirty();
      }
      return;
    }

    const project = await this.ensureProject(connection.accessToken, connection.projectId);
    const key = await this.createApiKey(connection.accessToken, project.id);
    const account: Account = {
      id: ACCOUNT_ID,
      provider: "openai-compatible",
      upstreamMode: "responses",
      compatibilityMode: "responses",
      accessToken: key.secret,
      baseUrl: this.inferenceBaseUrl,
      enabled: true,
      priority: 0,
      location: "cloud",
      multivibeCloud: true,
      privacyMode: this.privacyMode,
      expiresAt: key.expiresAt,
      state: {},
    };
    await this.store.upsertAccount(account);
    await this.store.patchSettings({
      multivibeCloud: {
        ...connection,
        projectId: project.id,
        apiKeyExpiresAt: key.expiresAt,
      },
    });
    await this.store.flushIfDirty();
  }

  private async ensureProject(accessToken: string, projectId?: string): Promise<{ id: string }> {
    if (projectId && UUID_PATTERN.test(projectId)) return { id: projectId };
    const projects = await this.requestJson("/client/v1/projects?limit=50", accessToken);
    const items = Array.isArray((projects as Record<string, unknown>).data)
      ? (projects as Record<string, unknown>).data as Array<Record<string, unknown>> : [];
    const existing = items.find((project) => project.slug === "multivibe-core");
    if (stringValue(existing?.id) && UUID_PATTERN.test(String(existing?.id))) return { id: String(existing?.id) };
    const created = await this.requestJson("/client/v1/projects", accessToken, {
      method: "POST",
      body: { name: "MultiVibe Core", slug: "multivibe-core" },
      idempotencyKey: `multivibe-core-project-${randomUUID()}`,
    });
    if (!UUID_PATTERN.test(String((created as Record<string, unknown>).id ?? ""))) {
      throw new Error("MultiVibe Cloud project response is invalid");
    }
    return { id: String((created as Record<string, unknown>).id) };
  }

  private async createApiKey(accessToken: string, projectId: string): Promise<{ secret: string; expiresAt: number }> {
    const expiresAt = Date.now() + API_KEY_LIFETIME_MS;
    const created = await this.requestJson(
      `/client/v1/projects/${encodeURIComponent(projectId)}/integrations/multivibe-core/credential`,
      accessToken,
      {
        method: "POST",
        body: {},
        idempotencyKey: `multivibe-core-key-${randomUUID()}`,
      },
    );
    const secret = stringValue((created as Record<string, unknown>).secret);
    if (!secret) throw new Error("MultiVibe Cloud API key response is missing its secret");
    const apiKey = (created as Record<string, unknown>).apiKey;
    const actualExpiresAt = apiKey && typeof apiKey === "object" && !Array.isArray(apiKey)
      ? expiresAtFromApiKey((apiKey as Record<string, unknown>).expiresAt, expiresAt)
      : expiresAt;
    return { secret, expiresAt: actualExpiresAt };
  }

  async syncMachineDirectory(directory:TeamMachineDirectory){
    let connection=currentCloudConnection(await this.store.getSettings());if(!connection)return;
    try{connection=await this.refreshConnectionIfNeeded(connection);const result=recordValue(await this.requestJson('/client/v1/team-machines/directory',connection.accessToken))??{};await directory.apply(result.envelopes as SignedMachinePolicy[]);}
    catch(error){if(error instanceof CloudHttpError&&error.status===403)await directory.apply([]);throw error;}
  }
  private machineRefreshAt = 0;
  private machineSyncRunning = false;
  private machineRelayRunning = 0;
  /** UI context comes from Cloud; local enrollment alone never grants an admin role. */
  async teamWorkspace(): Promise<{ state: "personal" | "team" | "unavailable"; role: "owner" | "admin" | "billing" | "member" | null }> {
    const settings = await this.store.getSettings();
    let connection = currentCloudConnection(settings);
    const enrolled = settings.multivibeTeam?.enabled === true;
    if (!connection) return { state: enrolled ? "team" : "personal", role: null };
    try {
      connection = await this.refreshConnectionIfNeeded(connection);
      const overview = recordValue(await this.requestJson("/client/v1/team", connection.accessToken));
      const role = overview?.role;
      if (role !== "owner" && role !== "admin" && role !== "billing" && role !== "member") throw new Error("team_role_unavailable");
      const subscription = recordValue(overview?.subscription);
      if (!enrolled && role === "owner" && subscription?.state === "inactive") return { state: "personal", role: null };
      return { state: "team", role };
    } catch {
      return { state: enrolled ? "team" : "unavailable", role: null };
    }
  }

  async machineConnection():Promise<{organizationId:string}> {
    let connection=currentCloudConnection(await this.store.getSettings());
    if(!connection)throw new Error('team_connection_required');
    connection=await this.refreshConnectionIfNeeded(connection);
    const context=recordValue(await this.requestJson('/client/v1/team-machines/context',connection.accessToken))??{};
    if(typeof context.organizationId!=='string')throw new Error('team_context_invalid');
    return {organizationId:context.organizationId};
  }
  async syncMachine(sharing:TeamMachineSharing):Promise<void> {
    if(this.machineSyncRunning)return;
    const state=sharing.status();const reportIdentity=sharing.reportIdentity();if(!reportIdentity)return;
    this.machineSyncRunning=true;
    try {
      let connection=currentCloudConnection(await this.store.getSettings());if(!connection)return;
      connection=await this.refreshConnectionIfNeeded(connection);
      const base='/client/v1/team-machines/'+encodeURIComponent(reportIdentity.instanceId);
      if(!state.consent){await this.requestJson(base+'/report',connection.accessToken,{method:'POST',body:{consentId:null,inventory:[]}});await sharing.acknowledgeRevocation();return;}
      if(Date.now()-this.machineRefreshAt>=30000){
        await this.requestJson(base+'/report',connection.accessToken,{method:'POST',body:{consentId:state.consent.id,inventory:await sharing.inventory()}});
        const result=recordValue(await this.requestJson(base+'/policy',connection.accessToken))??{};
        if(result.envelope){const ack=await sharing.apply(result.envelope as SignedMachinePolicy);await this.requestJson(base+'/acknowledgement',connection.accessToken,{method:'POST',body:ack});}
        this.machineRefreshAt=Date.now();
      }
      if(sharing.status().sharing?.transport!=='cloud_relay'||this.machineRelayRunning>=2)return;
      const response=recordValue(await this.requestJson(base+'/relay/poll',connection.accessToken))??{};
      const job=response.job as {id:string;token:string;path:string;body:unknown}|null;if(!job)return;
      this.machineRelayRunning++;
      const accessToken=connection.accessToken;
      void (async()=>{
        let release=()=>{};const controller=new AbortController();
        try {
          const run=await sharing.execute(job.token,'cloud_relay',job.path,job.body,AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]));release=run.release;
          const uploaded=await this.fetchImpl(this.apiBaseUrl+base+'/relay/results/'+encodeURIComponent(job.id),{method:'POST',headers:{authorization:'Bearer '+accessToken,'content-type':run.response.headers.get('content-type')??'application/json','x-team-response-status':String(run.response.status)},body:run.response.body,duplex:'half',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(300000)])} as RequestInit);
          if(!uploaded.ok)throw new Error('team_relay_upload_rejected');
        }catch {
          controller.abort();
          await this.fetchImpl(this.apiBaseUrl+base+'/relay/results/'+encodeURIComponent(job.id),{method:'POST',headers:{authorization:'Bearer '+accessToken,'content-type':'application/json','x-team-response-status':'503'},body:'{"error":"team_machine_unavailable"}',signal:AbortSignal.timeout(10000)}).catch(()=>undefined);
        }finally{release();controller.abort();this.machineRelayRunning--;}
      })();
    }catch(error){if(error instanceof CloudHttpError && error.status===403)await sharing.revokeConsent();throw error;}finally{this.machineSyncRunning=false;}
  }

  private async requestJson(path: string, accessToken: string, options: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    }
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const data = await this.readJson(response);
    const error = recordValue(data.error);
    if (!response.ok) {
      throw new CloudHttpError(response.status, stringValue(error?.code) ?? stringValue(data.code));
    }
    return data;
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = undefined;
    }
    return data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown> : {};
  }
}
