import { createServer as createTeamHttpsServer } from "node:https";
import { TeamMachineDirectory } from "./team-machine-directory.js";
import { readFile as readTeamIdentity } from "node:fs/promises";
import { TeamMachineSharing } from "./team-machine-sharing.js";
import { getHostMenuProviderActivity } from "./host/menu-bar.js";
import { automaticRouterManifest, createAutomaticRouter } from "./automatic-router.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { createSdkAdapterRouter } from "./ai-sdk/routes.js";
import { SDK_INTERNAL_TOKEN } from "./ai-sdk/connection.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/node";
import crypto from "node:crypto";
import { AccountStore, OAuthStateStore, cleanupOrphanedTmpFiles } from "./store.js";
import { createAnonymousUsageSharingWorker } from "./anonymous-usage-sharing.js";
import { createTraceManager } from "./traces.js";
import { MultivibeTeamSyncService } from "./team-sync.js";
import { AccountStoreManagedEnrollmentInstaller, ManagedTeamEnrollmentService } from "./managed-team-enrollment.js";
import { createAdminRouter } from "./routes/admin/index.js";
import { HostHarnessIntegrationManager } from "./host/harness-integrations.js";
import { oauthConfig } from "./oauth-config.js";
import {
  ADMIN_TOKEN,
  CONTROL_PLANE_PORT,
  CODEX_PROJECT_REGISTRATION_TOKEN,
  CODEX_PROJECTS_PATH,
  INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS,
  INFERENCE_IDEMPOTENCY_MAX_BYTES,
  INFERENCE_IDEMPOTENCY_MAX_ENTRIES,
  INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES,
  INFERENCE_IDEMPOTENCY_TTL_MS,
  JOBS_DB_PATH,
  JOB_WORKER_CONCURRENCY,
  HOST,
  MODULES_PATH,
  MULTIVIBE_CONTROL_PLANE,
  BUNDLED_SECURITY_MODULE_PATH,
  CHATGPT_BASE_URL,
  MISTRAL_BASE_URL,
  MISTRAL_UPSTREAM_PATH,
  OPENCODE_BASE_URL,
  MISTRAL_COMPACT_UPSTREAM_PATH,
  ZAI_BASE_URL,
  ZAI_UPSTREAM_PATH,
  ZAI_COMPACT_UPSTREAM_PATH,
  XAI_BASE_URL,
  XAI_RESPONSES_PATH,
  STORE_PATH,
  TRACE_FILE_PATH,
  TRACE_STATS_HISTORY_PATH,
  ANONYMOUS_USAGE_STATE_PATH,
  ANONYMOUS_USAGE_API_BASE_URL,
  TRACE_RETENTION_MAX,
  TRACE_INCLUDE_BODY,
  TRACE_INCLUDE_HEADERS,
  UPSTREAM_PATH,
  OAUTH_STATE_PATH,
  PORT,
  V1_EDGE_BASE_URL,
  V1_EDGE_INTERNAL_JOB_TOKEN,
  PROVIDER_AGENT_BINARY,
  PROVIDER_AGENT_DEVICE_KEY_PATH,
  PROVIDER_AGENT_ENROLLMENT_STATE_PATH,
  PROVIDER_AGENT_CAPACITY_POLICY_PATH,
  PROVIDER_AGENT_CLOUD_API_URL,
  PROVIDER_AGENT_DEMAND_PLAN_PATH,
  PROVIDER_AGENT_MODEL_CATALOG_PATH,
  PROVIDER_AGENT_DEMAND_TRUSTED_KEYS,
  PROVIDER_AGENT_MANAGED_ROOT,
  PROVIDER_AGENT_BUNDLED_OLLAMA_ROOT,
  PROVIDER_AGENT_DEPENDENCY_MANIFEST_PATH,
  PROVIDER_AGENT_MANAGED_PLANNER_STATE_PATH,
  PROVIDER_AGENT_OLLAMA_LISTEN,
  PROVIDER_AGENT_CUDA_VISIBLE_DEVICES,
  PROVIDER_AGENT_ENABLED,
  MULTIVIBE_HOST_APPLICATION,
  MULTIVIBE_HOST_UPDATER_BINARY,
  HOST_HARNESS_INTEGRATIONS_STATE_PATH,
  HOST_HARNESS_HOME_DIRECTORY,
  PROVIDER_AGENT_RUNTIME_STATE_PATH,
  PROVIDER_AGENT_STATE_PATH,
  PROXY_API_KEY,
  PROXY_API_KEYS,
  REQUEST_BODY_LIMIT,
  REALTIME_PROVIDER,
  REALTIME_REQUEST_TIMEOUT_MS,
  REALTIME_WEBRTC_CALL_URL,
  MULTIVIBE_CLOUD_AUTH_BASE_URL,
  MULTIVIBE_CLOUD_API_BASE_URL,
  MULTIVIBE_CLOUD_INFERENCE_BASE_URL,
  MULTIVIBE_CLOUD_REDIRECT_URI,
  MULTIVIBE_CLOUD_PRIVACY_MODE,
  MULTIVIBE_CONFIDENTIAL_INFERENCE_TRUST_POLICY,
} from "./config.js";
import { ModuleManager } from "./module-manager.js";
import { createProviderWorkerEstimateClient } from "./provider-worker-estimate.js";
import { createBodyParserMiddleware } from "./middleware/decompression.js";
import http from "node:http";
import {
  findAvailableResetCreditCount,
  rateLimitResetCreditRequest,
  ResetCreditIncreaseMonitor,
  scheduleWeeklyReset,
  startScheduledWeeklyResetMonitor,
} from "./rate-limit-reset.js";
import {
  startUsageRefreshMonitor,
} from "./usage-refresh-monitor.js";
import { UsageRefreshCoordinator } from "./usage-refresh.js";
import {
  identifyProxyApplication,
  parseProxyApiKeys,
} from "./proxy-api-keys.js";
import { CodexProjectRegistry } from "./codex-projects.js";
import { anthropicErrorEnvelope } from "./anthropic-compat.js";
import { CapacityTracker } from "./smart-routing.js";
import { JobStore } from "./jobs.js";
import {
  SmartRoutingCoordinator,
  createAdmissionMiddleware,
  createSmartRoutingRouter,
} from "./smart-routing-routes.js";
import { startEmbeddedProviderAgent } from "./provider-agent-supervisor.js";
import { createRequestTracingMiddleware } from "./request-tracing.js";
import { createInternalV1EdgeRouter } from "./internal-v1-edge-routes.js";
import {
  buildHostMenuBarAccountsSummary,
  buildHostMenuBarGitHubStarPrompt,
} from "./host/menu-bar.js";
import {
  buildHostNotifications,
  selectWeeklyAutoResetAccount,
} from "./host/notifications.js";
import { CodexQuotaResetForecastCache } from "./quota-reset-forecast.js";
import { HostUpdateController } from "./host/update-controller.js";
import { MultivibeCloudService } from "./multivibe-cloud.js";
import {
  ConfidentialInferenceClient,
  parseConfidentialTrustPolicy,
} from "./confidential-inference.js";

const app = express();
app.use(createBodyParserMiddleware());
app.use((req, res, next) => {
  if (
    MULTIVIBE_CLOUD_PRIVACY_MODE === "confidential_verified"
    && req.method === "POST"
  ) {
    const confidentialPath = /\/(?:responses|chat\/completions)$/.test(req.path);
    const unsupportedSensitivePath = req.path.startsWith("/v1/")
      || /\/(?:messages|responses\/compact|realtime)$/.test(req.path);
    if (!confidentialPath && unsupportedSensitivePath) {
      return res.status(409).json({
        error: {
          message: "This request is not yet supported by verified confidential computing.",
          type: "invalid_request_error",
          code: "confidential_surface_not_supported",
        },
      });
    }
    if (!confidentialPath) return next();
    const requested = req.header("x-multivibe-privacy");
    if (requested && requested !== "confidential_verified") {
      return res.status(409).json({
        error: {
          message: "This Core instance requires verified confidential computing.",
          type: "invalid_request_error",
          code: "privacy_policy_downgrade_rejected",
        },
      });
    }
    req.headers["x-multivibe-privacy"] = "confidential_verified";
  }
  next();
});
const nodePort = MULTIVIBE_CONTROL_PLANE ? CONTROL_PLANE_PORT : PORT;
const nodeHost = MULTIVIBE_CONTROL_PLANE ? "127.0.0.1" : HOST;
if (MULTIVIBE_CONTROL_PLANE && !V1_EDGE_INTERNAL_JOB_TOKEN) {
  throw new Error(
    "V1_EDGE_INTERNAL_JOB_TOKEN is required when MULTIVIBE_CONTROL_PLANE=true",
  );
}


app.use(
  (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.too.large") {
      if (/(?:^|\/)messages$/.test(_req.path)) {
        return res.status(413).json(
          anthropicErrorEnvelope(413, {
            message: `Request body is too large. Limit is ${REQUEST_BODY_LIMIT}.`,
          }),
        );
      }
      return res.status(413).json({
        error: {
          message: `Request body is too large. Limit is ${REQUEST_BODY_LIMIT}.`,
          type: "invalid_request_error",
          code: "payload_too_large",
        },
      });
    }
    next(err);
  },
);

const dataDir = path.dirname(STORE_PATH);
await cleanupOrphanedTmpFiles(dataDir);

const store = new AccountStore(STORE_PATH);
const teamMachineSharing = new TeamMachineSharing(store, path.join(dataDir, "team-machine-sharing.json"), JSON.parse(process.env.MULTIVIBE_TEAM_MACHINE_TRUSTED_KEYS ?? "{}"));
await teamMachineSharing.initialize();
const teamMachineDirectory=new TeamMachineDirectory(path.join(dataDir,"team-machine-directory.json"),JSON.parse(process.env.MULTIVIBE_TEAM_MACHINE_TRUSTED_KEYS ?? "{}"));
await teamMachineDirectory.initialize();
app.use("/v1",teamMachineDirectory.router());
app.use("/team-machine", teamMachineSharing.inferenceRouter());
// Optional dedicated private-network TLS listener. No listener is exposed without operator-provided certificates.
if(process.env.MULTIVIBE_TEAM_MACHINE_TLS_CERT_PATH && process.env.MULTIVIBE_TEAM_MACHINE_TLS_KEY_PATH){
  const privateApp=express();privateApp.use(express.json({limit:REQUEST_BODY_LIMIT}));privateApp.use("/team-machine",teamMachineSharing.inferenceRouter());
  const tlsServer=createTeamHttpsServer({cert:await readTeamIdentity(process.env.MULTIVIBE_TEAM_MACHINE_TLS_CERT_PATH),key:await readTeamIdentity(process.env.MULTIVIBE_TEAM_MACHINE_TLS_KEY_PATH)},privateApp);
  tlsServer.listen(Number(process.env.MULTIVIBE_TEAM_MACHINE_TLS_PORT ?? "1456"),process.env.MULTIVIBE_TEAM_MACHINE_BIND ?? "127.0.0.1");
}

const teamSync = new MultivibeTeamSyncService(store, `${STORE_PATH}.team-instance.json`);
const appVersion = process.env.APP_VERSION ?? "unknown";
const managedTeamEnrollment = new ManagedTeamEnrollmentService({
  profilePath: path.join(dataDir, "managed-team-enrollment.json"),
  statePath: path.join(dataDir, "managed-team-enrollment-state.json"),
  identity: teamSync,
  installer: new AccountStoreManagedEnrollmentInstaller(store),
  appVersion,
});
teamMachineSharing.setUsageRecorder((trace,memberId)=>teamSync.recordTrace(trace,{type:"member",id:memberId}));
const hostHarnessIntegrations = MULTIVIBE_HOST_APPLICATION
  ? new HostHarnessIntegrationManager({
      homeDirectory: HOST_HARNESS_HOME_DIRECTORY,
      projectRegistrationToken: CODEX_PROJECT_REGISTRATION_TOKEN,
      statePath: HOST_HARNESS_INTEGRATIONS_STATE_PATH,
      apiKeyForId: (id) => store.getCachedProxyApiKeys().find((entry) => entry.id === id)?.key,
      baseUrl: MULTIVIBE_CONTROL_PLANE
        ? V1_EDGE_BASE_URL
        : `http://127.0.0.1:${nodePort}`,
    })
  : undefined;
const capacityTracker = new CapacityTracker();
const jobStore = new JobStore(
  JOBS_DB_PATH,
  (application) => store.getApplicationPolicy(application).fairnessWeight,
);
const smartRouting = new SmartRoutingCoordinator(store, jobStore, capacityTracker);
const oauthStore = new OAuthStateStore(OAUTH_STATE_PATH);
const codexProjectRegistry = new CodexProjectRegistry(CODEX_PROJECTS_PATH);
const moduleManager = new ModuleManager(
  MODULES_PATH,
  BUNDLED_SECURITY_MODULE_PATH,
  !MULTIVIBE_CONTROL_PLANE,
);
moduleManager.registerBuiltin(automaticRouterManifest, createAutomaticRouter());
const traceManager = createTraceManager({
  onCompleted: async (trace) => {
    const principal = trace.application
      ? store.getCachedProxyApiKeys().find((entry) => entry.application === trace.application)?.principal
        ?? { type: "service" as const, id: trace.application, name: trace.application }
      : { type: "unassigned" as const };
    await teamSync.recordTrace(trace, principal);
    if (!trace.clientRequestId) return;
    // Never expose trace bodies, credentials, account details, or headers to analytics hooks.
    const value = { traceId: trace.id, traceKind: trace.traceKind, model: trace.resolvedModel ?? trace.model,
      status: trace.status, usageStatus: trace.usageStatus, costUsd: trace.costUsd,
      tokensInput: trace.tokensInput, tokensOutput: trace.tokensOutput,
      tokensInputCached: trace.tokensInputCached, tokensInputCacheWrite: trace.tokensInputCacheWrite,
      latencyMs: trace.latencyMs, pricingVersion: trace.pricingVersion };
    await moduleManager.runHook("request.completed", value, { requestId: trace.clientRequestId,
      application: trace.application, route: trace.route, model: value.model,
      transport: trace.stream ? "sse" : "http", signal: AbortSignal.timeout(5000) });
  },
  filePath: TRACE_FILE_PATH,
  externalWriter: MULTIVIBE_CONTROL_PLANE,
  historyFilePath: TRACE_STATS_HISTORY_PATH,
  retentionMax: TRACE_RETENTION_MAX,
  resolveCodexProject: (sessionId, projectRoot, projectHost) =>
    codexProjectRegistry.resolve(sessionId, projectRoot, projectHost),
});
const configuredProxyApiKeys = parseProxyApiKeys(PROXY_API_KEY, PROXY_API_KEYS);
await Promise.all([
  store.init(),
  teamSync.initialize(),
  oauthStore.init(),
  codexProjectRegistry.init(),
  traceManager.initialize(),
  moduleManager.initialize(),
]);
const attemptManagedTeamEnrollment = async () => {
  try { await managedTeamEnrollment.enrollIfPresent(); }
  catch (error) { Sentry.captureException(error, { tags: { subsystem: "managed-team-enrollment" } }); }
};
void attemptManagedTeamEnrollment();
const managedTeamEnrollmentTimer = setInterval(() => { void attemptManagedTeamEnrollment(); }, 60_000);
managedTeamEnrollmentTimer.unref();
if (MULTIVIBE_CONTROL_PLANE) {
  const incompatibleInferenceModules = moduleManager
    .list()
    .filter(
      (entry) =>
        entry.enabled &&
        entry.loaded &&
        Boolean(entry.manifest?.hooks?.length),
    )
    .map((entry) => entry.id);
  if (incompatibleInferenceModules.length) {
    throw new Error(
      `Native Rust inference cannot start while JavaScript inference modules are enabled: ${incompatibleInferenceModules.join(
        ", ",
      )}`,
    );
  }
}
const providerAgent = startEmbeddedProviderAgent({
  enabled: PROVIDER_AGENT_ENABLED,
  binaryPath: PROVIDER_AGENT_BINARY,
  statePath: PROVIDER_AGENT_STATE_PATH,
  runtimeStatePath: PROVIDER_AGENT_RUNTIME_STATE_PATH,
  deviceKeyPath: PROVIDER_AGENT_DEVICE_KEY_PATH,
  enrollmentStatePath: PROVIDER_AGENT_ENROLLMENT_STATE_PATH,
  capacityPolicyPath: PROVIDER_AGENT_CAPACITY_POLICY_PATH,
  cloudApiUrl: PROVIDER_AGENT_CLOUD_API_URL,
  demandPlanPath: PROVIDER_AGENT_DEMAND_PLAN_PATH,
  modelCatalogPath: PROVIDER_AGENT_MODEL_CATALOG_PATH,
  trustedDemandKeys: PROVIDER_AGENT_DEMAND_TRUSTED_KEYS,
  managedRoot: PROVIDER_AGENT_MANAGED_ROOT,
  bundledOllamaRoot: PROVIDER_AGENT_BUNDLED_OLLAMA_ROOT,
  dependencyManifestPath: PROVIDER_AGENT_DEPENDENCY_MANIFEST_PATH,
  managedPlannerStatePath: PROVIDER_AGENT_MANAGED_PLANNER_STATE_PATH,
  ollamaListen: PROVIDER_AGENT_OLLAMA_LISTEN,
  cudaVisibleDevices: PROVIDER_AGENT_CUDA_VISIBLE_DEVICES,
});
const hostUpdateController = MULTIVIBE_HOST_APPLICATION
  ? new HostUpdateController(
      MULTIVIBE_HOST_UPDATER_BINARY,
      providerAgent,
      MULTIVIBE_CONTROL_PLANE && V1_EDGE_INTERNAL_JOB_TOKEN
        ? {
            baseUrl: V1_EDGE_BASE_URL,
            internalToken: V1_EDGE_INTERNAL_JOB_TOKEN,
          }
        : undefined,
    )
  : undefined;
const confidentialTrustPolicy = parseConfidentialTrustPolicy(
  MULTIVIBE_CONFIDENTIAL_INFERENCE_TRUST_POLICY,
);
if (MULTIVIBE_CLOUD_PRIVACY_MODE === "confidential_verified" && !confidentialTrustPolicy) {
  throw new Error(
    "MULTIVIBE_CONFIDENTIAL_INFERENCE_TRUST_POLICY is required for confidential_verified mode",
  );
}
const confidentialInference = confidentialTrustPolicy
  ? new ConfidentialInferenceClient(confidentialTrustPolicy)
  : undefined;
const providerWorkerEstimateClient = createProviderWorkerEstimateClient(ANONYMOUS_USAGE_API_BASE_URL);
const multivibeCloud = new MultivibeCloudService(store, oauthStore, {
  authBaseUrl: MULTIVIBE_CLOUD_AUTH_BASE_URL,
  apiBaseUrl: MULTIVIBE_CLOUD_API_BASE_URL,
  inferenceBaseUrl: MULTIVIBE_CLOUD_INFERENCE_BASE_URL,
  redirectUri: MULTIVIBE_CLOUD_REDIRECT_URI,
  topupUrl: `${MULTIVIBE_CLOUD_API_BASE_URL}/billing`,
  privacyMode: MULTIVIBE_CLOUD_PRIVACY_MODE,
  managedTeamIdentity: teamSync,
});
const teamMachineTimer=setInterval(()=>{void multivibeCloud.syncMachine(teamMachineSharing).catch(()=>undefined);},2000);
teamMachineTimer.unref();
const teamMachineDirectoryTimer=setInterval(()=>{void multivibeCloud.syncMachineDirectory(teamMachineDirectory).catch(()=>undefined);},30000);
teamMachineDirectoryTimer.unref();

const teamSyncTimer=setInterval(()=>{void multivibeCloud.syncTeam(teamSync).catch(()=>undefined);},60_000);
teamSyncTimer.unref();
const quotaResetForecastCache = new CodexQuotaResetForecastCache();
const resetCreditIncreaseMonitor = new ResetCreditIncreaseMonitor({
  listAccounts: () => store.listAccounts(),
  readAvailableCount: async (account) => {
    const response = await rateLimitResetCreditRequest(
      account,
      CHATGPT_BASE_URL,
      false,
    );
    return findAvailableResetCreditCount(response);
  },
});
const HOST_CLOUD_STATUS_CACHE_MS = 60_000;
let hostCloudStatusCache: {
  value: Awaited<ReturnType<MultivibeCloudService["getStatus"]>>;
  expiresAt: number;
} | undefined;
let hostCloudStatusInFlight: ReturnType<MultivibeCloudService["getStatus"]> | undefined;

async function hostCloudStatus() {
  if (hostCloudStatusCache && Date.now() < hostCloudStatusCache.expiresAt) {
    return hostCloudStatusCache.value;
  }
  if (hostCloudStatusInFlight) return hostCloudStatusInFlight;
  hostCloudStatusInFlight = multivibeCloud.getStatus().then((value) => {
    hostCloudStatusCache = { value, expiresAt: Date.now() + HOST_CLOUD_STATUS_CACHE_MS };
    return value;
  }).finally(() => {
    hostCloudStatusInFlight = undefined;
  });
  return hostCloudStatusInFlight;
}
await traceManager.seedStatsHistoryIfMissing();
const anonymousUsageSharing = createAnonymousUsageSharingWorker({
  settingsStore: store,
  traceSource: traceManager,
  statePath: ANONYMOUS_USAGE_STATE_PATH,
  apiBaseUrl: ANONYMOUS_USAGE_API_BASE_URL,
});
void anonymousUsageSharing.start();
startScheduledWeeklyResetMonitor({
  store,
  oauthConfig,
  openaiBaseUrl: CHATGPT_BASE_URL,
});
if (MULTIVIBE_HOST_APPLICATION) resetCreditIncreaseMonitor.start();
const usageRefreshCoordinator = new UsageRefreshCoordinator();
const usageRefreshMonitor = startUsageRefreshMonitor({
  store,
  oauthConfig,
  openaiBaseUrl: CHATGPT_BASE_URL,
  mistralBaseUrl: MISTRAL_BASE_URL,
  zaiBaseUrl: ZAI_BASE_URL,
  opencodeBaseUrl: OPENCODE_BASE_URL,
  xaiBaseUrl: XAI_BASE_URL,
  coordinator: usageRefreshCoordinator,
});

app.use(
  createRequestTracingMiddleware({
    traceManager,
    includeBody: TRACE_INCLUDE_BODY,
    includeHeaders: TRACE_INCLUDE_HEADERS,
  }),
);

const adminRouter = createAdminRouter({
  store,
  oauthStore,
  traceManager,
  codexProjectRegistry,
  oauthConfig,
  openaiBaseUrl: CHATGPT_BASE_URL,
  mistralBaseUrl: MISTRAL_BASE_URL,
  zaiBaseUrl: ZAI_BASE_URL,
  codexProjectRegistrationToken: CODEX_PROJECT_REGISTRATION_TOKEN,
  configuredProxyApiKeys,
  smartRouting,
  usageRefreshCoordinator,
  anonymousUsageSharing,
  providerAgent,
  hostApplication: MULTIVIBE_HOST_APPLICATION,
  hostHarnessIntegrations,
  providerWorkerEstimateClient,
  moduleManager,
  hostUpdateController,
  multivibeCloud,
  teamSync,
  managedTeamEnrollment,
  appVersion,
  storagePaths: {
    accountsPath: STORE_PATH,
    oauthStatePath: OAUTH_STATE_PATH,
    tracePath: TRACE_FILE_PATH,
    traceStatsHistoryPath: TRACE_STATS_HISTORY_PATH,
    codexProjectsPath: CODEX_PROJECTS_PATH,
  },
});

const ADMIN_SESSION_COOKIE = "multivibe_admin_session";
const ADMIN_SESSION_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const DESKTOP_SESSION_MAX_AGE_MS = 60 * 1000;
const desktopSessionCodes = new Map<string, number>();
const INTERNAL_JOB_TOKEN =
  V1_EDGE_INTERNAL_JOB_TOKEN || crypto.randomBytes(32).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readCookie(req: express.Request, name: string): string | undefined {
  const cookieHeader = req.header("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) continue;
    return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function adminSessionValue(): string {
  return crypto
    .createHmac("sha256", ADMIN_TOKEN)
    .update("multivibe-admin-session-v1")
    .digest("base64url");
}

function hasAdminSession(req: express.Request): boolean {
  const sessionId = readCookie(req, ADMIN_SESSION_COOKIE);
  if (!sessionId) return false;
  return safeEqual(sessionId, adminSessionValue());
}

function shouldUseSecureCookie(req: express.Request): boolean {
  return req.secure || req.header("x-forwarded-proto") === "https";
}

function setAdminSession(req: express.Request, res: express.Response) {
  const sessionId = adminSessionValue();
  res.cookie(ADMIN_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "strict",
    secure: shouldUseSecureCookie(req),
    maxAge: ADMIN_SESSION_MAX_AGE_MS,
    path: "/",
  });
}

function clearAdminSession(req: express.Request, res: express.Response) {
  res.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: shouldUseSecureCookie(req),
    path: "/",
  });
}

function adminGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  // OAuth returns via a cross-site top-level navigation. The Strict admin
  // cookie is intentionally unavailable on that request; the callback route
  // still requires the flow's unpredictable state and PKCE-bound code.
  if (req.path === "/cloud/oauth/callback") return next();
  if (!ADMIN_TOKEN) return next();
  if (hasAdminSession(req)) return next();
  const token =
    req.header("x-admin-token") ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !safeEqual(token, ADMIN_TOKEN))
    return res.status(401).json({ error: "unauthorized" });
  next();
}

app.use("/internal/ai-sdk", createSdkAdapterRouter({ store, internalToken: SDK_INTERNAL_TOKEN }));

if (MULTIVIBE_CONTROL_PLANE) {
  app.use(
    "/internal/v1-edge",
    createInternalV1EdgeRouter({ store, internalToken: INTERNAL_JOB_TOKEN }),
  );
}

function projectRegistrationGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!CODEX_PROJECT_REGISTRATION_TOKEN) {
    return res.status(503).json({ error: "Codex project registration is disabled" });
  }
  const token =
    req.header("x-codex-project-token") ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !safeEqual(token, CODEX_PROJECT_REGISTRATION_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../web-dist");
const scriptsDirectory = path.resolve(__dirname, "../scripts");

function sendHookInstallerFile(
  res: express.Response,
  fileName: string,
  contentType: string,
) {
  res.setHeader("cache-control", "no-cache");
  res.type(contentType);
  res.sendFile(path.join(scriptsDirectory, fileName));
}

app.get("/install-codex-project-hook.sh", (_req, res) =>
  sendHookInstallerFile(res, "install-codex-project-hook.sh", "text/x-shellscript"),
);
app.get("/install-codex-project-hook.mjs", (_req, res) =>
  sendHookInstallerFile(res, "install-codex-project-hook.mjs", "text/javascript"),
);
app.get("/codex-project-hook.mjs", (_req, res) =>
  sendHookInstallerFile(res, "codex-project-hook.mjs", "text/javascript"),
);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    version: process.env.APP_VERSION ?? "unknown",
    gitSha: process.env.APP_GIT_SHA ?? "unknown",
    buildId: process.env.APP_BUILD_ID ?? "unknown",
  }),
);

app.head("/api/hello", (_req, res) => res.sendStatus(200));

if (!MULTIVIBE_CONTROL_PLANE) {
  app.get("/admin/session", (req, res) => {
    res.json({ authenticated: !ADMIN_TOKEN || hasAdminSession(req) });
  });
}

app.get("/admin/host/menu-bar/activity", adminGuard, (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.json({ activity: getHostMenuProviderActivity() ?? null });
});

app.get("/admin/host/menu-bar", adminGuard, async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const [accounts, traceStats, forecast, cloud, workerResult] = await Promise.all([
    store.listAccounts(),
    traceManager.getTraceStats(),
    quotaResetForecastCache.get().catch(() => undefined),
    hostCloudStatus().catch(() => undefined),
    providerAgent.enabled
      ? providerAgent.getCloudEnrollment().then(() => true).catch(() => false)
      : Promise.resolve(false),
  ]);
  const accountSummary = buildHostMenuBarAccountsSummary(accounts);
  const previousForecastScoreValue = Number(req.query.previous_forecast_score);
  const previousForecastScore = Number.isFinite(previousForecastScoreValue)
    && previousForecastScoreValue >= 0 && previousForecastScoreValue <= 100
    ? previousForecastScoreValue
    : undefined;
  const generatedOutputTokens = traceStats.stats.totals.tokensOutput;
  const resetCreditIncreases = req.query.consume_notifications === "1"
    ? resetCreditIncreaseMonitor.drainIncreases()
    : [];
  res.json({
    operational: true,
    ...accountSummary,
    githubStarPrompt: buildHostMenuBarGitHubStarPrompt(generatedOutputTokens),
    ...(forecast ? { forecast } : {}),
    ...(cloud ? { cloud } : {}),
    notifications: buildHostNotifications({
      accounts,
      resetCreditIncreases,
      ...(forecast ? { forecast } : {}),
      ...(previousForecastScore === undefined ? {} : { previousForecastScore }),
      ...(cloud ? { cloud } : {}),
      workerConfigured: workerResult,
      generatedOutputTokens,
    }),
    earnings: cloud?.workerEarnings && workerResult ? {
      available: true,
      currency: cloud.workerEarnings.currency,
      today: null,
      week: null,
      month: Number(cloud.workerEarnings.monthNetUsd),
      lifetime: Number(cloud.workerEarnings.lifetimeNetUsd),
    } : {
      available: false,
      currency: null,
      today: null,
      week: null,
      month: null,
      reason: "provider_earnings_not_active",
    },
  });
});

app.post("/admin/host/weekly-auto-reset", adminGuard, async (_req, res) => {
  const account = selectWeeklyAutoResetAccount(
    await store.listAccounts(),
    10,
  );
  if (!account) {
    return res.status(409).json({ error: "weekly_auto_reset_not_available" });
  }
  await scheduleWeeklyReset(account, store);
  return res.json({ ok: true });
});

if (!MULTIVIBE_CONTROL_PLANE) {
  app.post("/admin/desktop-session", adminGuard, (_req, res) => {
    const now = Date.now();
    for (const [code, expiresAt] of desktopSessionCodes) {
      if (expiresAt <= now) desktopSessionCodes.delete(code);
    }
    if (desktopSessionCodes.size >= 16) {
      const oldest = desktopSessionCodes.keys().next().value;
      if (oldest) desktopSessionCodes.delete(oldest);
    }
    const code = crypto.randomBytes(32).toString("base64url");
    desktopSessionCodes.set(code, now + DESKTOP_SESSION_MAX_AGE_MS);
    res.setHeader("cache-control", "no-store");
    res.json({ path: `/desktop/session?code=${encodeURIComponent(code)}` });
  });

  app.get("/desktop/session", (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const expiresAt = desktopSessionCodes.get(code);
    if (!code || !expiresAt || expiresAt <= Date.now()) {
      if (code) desktopSessionCodes.delete(code);
      return res.status(401).type("text/plain").send("This desktop session link is invalid or expired.");
    }
    desktopSessionCodes.delete(code);
    setAdminSession(req, res);
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    return res.redirect(303, "/");
  });
}

app.post(
  "/admin/codex-sessions",
  projectRegistrationGuard,
  async (req, res) => {
    try {
      const registration = await codexProjectRegistry.register(req.body);
      res.status(201).json({ ok: true, ...registration });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  },
);

if (!MULTIVIBE_CONTROL_PLANE) {
  app.post("/admin/session", createAuthRateLimiter({ limit: 20 }), (req, res) => {
    if (!ADMIN_TOKEN) return res.json({ authenticated: true });
    const token = String(req.body?.token ?? "");
    if (!safeEqual(token, ADMIN_TOKEN))
      return res.status(401).json({ error: "unauthorized" });
    setAdminSession(req, res);
    res.json({ authenticated: true });
  });

  app.delete("/admin/session", (req, res) => {
    clearAdminSession(req, res);
    res.json({ authenticated: false });
  });
}

app.use("/admin/team-machine", adminGuard, teamMachineSharing.adminRouter(async () => {
  const context=await multivibeCloud.machineConnection();
  const identity=JSON.parse(await readTeamIdentity(`${STORE_PATH}.team-instance.json`, "utf8"));
  return {...context,instanceId:identity.instanceId};
}));
app.use("/admin", adminGuard, adminRouter);

// Public inference, realtime, and WebSocket routes are owned by the Rust edge.
app.use(express.static(webDist));
app.get("/{*path}", (req, res, next) => {
  if (
    req.path.startsWith("/admin/") ||
    req.path.startsWith("/v1/") ||
    req.path === "/health" ||
    req.path === "/chat/completions" ||
    req.path === "/responses" ||
    req.path === "/responses/compact" ||
    req.path === "/messages" ||
    req.path === "/models" ||
    /^\/models\//.test(req.path)
  )
    return next();
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) next();
  });
});

// Sentry error handler must be registered after all routes and before listen().
Sentry.setupExpressErrorHandler(app);

const server = http.createServer(app);
server.listen(nodeHost ? { port: nodePort, host: nodeHost } : { port: nodePort }, () => {
  smartRouting.startHealthMonitoring();
  console.log(
    `multivibe control plane listening on ${nodeHost ?? "all interfaces"}:${nodePort}`,
  );
  console.log(
    `store=${STORE_PATH} oauth=${OAUTH_STATE_PATH} trace=${TRACE_FILE_PATH} traceStats=${TRACE_STATS_HISTORY_PATH} codexProjects=${CODEX_PROJECTS_PATH} redirect=${oauthConfig.redirectUri} openaiUpstream=${CHATGPT_BASE_URL}${UPSTREAM_PATH} mistralUpstream=${MISTRAL_BASE_URL}${MISTRAL_UPSTREAM_PATH} zaiUpstream=${ZAI_BASE_URL}${ZAI_UPSTREAM_PATH} xaiUpstream=${XAI_BASE_URL}${XAI_RESPONSES_PATH}`,
  );
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  smartRouting.stopHealthMonitoring();
  usageRefreshMonitor.stop();
  anonymousUsageSharing.stop();
  await providerAgent.stop();
  console.log(`received ${signal}, flushing persistent state`);
  server.close(async (error) => {
    try {
      await Promise.all([
        store.flushIfDirty(),
        codexProjectRegistry.flushPendingWrites(),
        traceManager.flushPendingWrites(),
      ]);
      moduleManager.close();
      jobStore.close();
      if (error) throw error;
      process.exitCode = 0;
    } catch (shutdownError) {
      console.error("graceful shutdown failed", shutdownError);
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
