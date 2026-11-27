import { installModelsDevPricing, setModelBillingOverrides } from "./model-pricing.js";
import { setOffPeakSchedule } from "./off-peak.js";
import { COMMUNITY_BENCHMARKS_API_BASE_URL, COMMUNITY_BENCHMARKS_ENABLED, COMMUNITY_BENCHMARKS_STATE_PATH } from "./config.js";
import { createCommunityReportSharingWorker } from "./community-report-sharing.js";
import { detectCommunityHost } from "./community-host-profile.js";
import { takeDeviceSignIn } from "./host/device-signin.js";
import { getHostMenuProviderActivity, recordHostMenuTraceUsage } from "./host/menu-bar.js";
import { automaticRouterManifest, createAutomaticRouter } from "./automatic-router.js";
import { audioPluginManifest, createAudioPlugin } from "./audio-plugin.js";
import { headroomPluginManifest, createHeadroomPlugin, HEADROOM_PLUGIN } from "./headroom-plugin.js";
import { HeadroomEdgeClient } from "./headroom-edge-client.js";
import { HeadroomProvisioner } from "./headroom-provisioner.js";
import { codingEconomyManifest, createCodingEconomy } from "./coding-economy.js";
import { syncVirtualModelAliases } from "./virtual-model-registry.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { getAuth, requireAdmin, scopedUserId, type AuthIdentity } from "./auth-context.js";
import {
  hashInviteToken,
  hashPassword,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  publicUser,
  signSession,
  verifyPassword,
  verifySession,
} from "./users.js";
import {
  authenticationOptions,
  finishAuthentication,
  finishRegistration,
  findPasskeyOwner,
  PasskeyError,
  registrationOptions,
} from "./passkeys.js";
import { createSdkAdapterRouter } from "./ai-sdk/routes.js";
import { SDK_INTERNAL_TOKEN } from "./ai-sdk/connection.js";
import { LiveModelCatalog } from "./ai-sdk/live-model-catalog.js";
import { UnifiedModelCatalog } from "./model-metadata/catalog.js";
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
import { createAdminUsersRouter } from "./routes/admin/users.js";
import { createAdminModelBillingRouter } from "./routes/admin/model-billing.js";
import { createAdminPaymentsRouter } from "./routes/admin/payments.js";
import { createBillingRouter } from "./routes/billing.js";
import { PaymentsService, startPaymentsPoller } from "./payments/service.js";
import { HostHarnessIntegrationManager } from "./host/harness-integrations.js";
import { HostConversationHarnessManager } from "./host/conversation-harnesses.js";
import { HostHarnessRuntime } from "./host/harness-runtime/runtime.js";
import { InstanceRelay } from "./host/instance-relay.js";
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
  SDK_MODELS_DEV_CACHE_PATH,
  SDK_LIVE_MODEL_CACHE_PATH,
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
  MULTIVIBE_HOST_APPLICATION,
  MULTIVIBE_HOST_UPDATER_BINARY,
  HOST_HARNESS_INTEGRATIONS_STATE_PATH,
  HOST_HARNESS_HOME_DIRECTORY,
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
  CLOUDFLARE_ACCESS_APPS,
  CLOUDFLARE_ACCESS_APPS_ERROR,
  CLOUDFLARE_ACCESS_PROVISIONING,
  CLOUDFLARE_ACCESS_TOKEN_DURATION,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN,
  MARKETPLACE_URL,
  MARKETPLACE_SECRET_PATH,
  MARKETPLACE_POLL_INTERVAL_MS,
} from "./config.js";
import { createCloudflareAccessProvisioner } from "./cloudflare-access.js";
import { ModuleManager } from "./module-manager.js";
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
import { createRequestTracingMiddleware } from "./request-tracing.js";
import { createInternalV1EdgeRouter } from "./internal-v1-edge-routes.js";
import {
  buildHostMenuBarAccountsSummary,
  buildHostMenuBarExtensionWidgets,
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

const paymentsService = new PaymentsService({
  store,
  credentialsPath: MARKETPLACE_SECRET_PATH,
  brokerUrl: MARKETPLACE_URL,
});

const teamSync = new MultivibeTeamSyncService(store, `${STORE_PATH}.team-instance.json`);
const appVersion = process.env.APP_VERSION ?? "unknown";
const managedTeamEnrollment = new ManagedTeamEnrollmentService({
  profilePath: path.join(dataDir, "managed-team-enrollment.json"),
  statePath: path.join(dataDir, "managed-team-enrollment-state.json"),
  identity: teamSync,
  installer: { install: (result, profile) => multivibeCloud.installManagedConnection(() => new AccountStoreManagedEnrollmentInstaller(store).install(result, profile)) },
  appVersion,
});
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
const hostConversationHarnesses = hostHarnessIntegrations
  ? new HostConversationHarnessManager(hostHarnessIntegrations, path.join(dataDir, "conversation-harness-sessions"))
  : undefined;
const hostHarnessRuntime = hostHarnessIntegrations
  ? new HostHarnessRuntime(path.join(dataDir, "harness-runtime-v1"), hostHarnessIntegrations, undefined, PROXY_API_KEY ? {modelConnection:()=>({baseUrl:MULTIVIBE_CONTROL_PLANE?V1_EDGE_BASE_URL:`http://127.0.0.1:${nodePort}`,apiKey:PROXY_API_KEY})} : {})
  : undefined;
const instanceRelay = hostHarnessRuntime ? new InstanceRelay(hostHarnessRuntime, path.join(dataDir, 'instance-relay-v1.json')) : undefined;
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
moduleManager.registerBuiltin(audioPluginManifest, createAudioPlugin());
moduleManager.registerBuiltin(headroomPluginManifest, createHeadroomPlugin());
const headroomEdge = new HeadroomEdgeClient({
  baseUrl: V1_EDGE_BASE_URL,
  token: V1_EDGE_INTERNAL_JOB_TOKEN,
});
const headroomProvisioner = new HeadroomProvisioner({
  statePath: path.join(dataDir, "headroom-provision.json"),
  edge: headroomEdge,
  moduleState: () => {
    const module = moduleManager.list().find((entry) => entry.id === HEADROOM_PLUGIN);
    return module ? { enabled: module.enabled, settings: module.settings } : null;
  },
  network: process.env.MULTIVIBE_EXTENSION_NETWORK?.trim() || undefined,
});
moduleManager.registerBuiltin(codingEconomyManifest, createCodingEconomy());
const modelsDevCatalog = new UnifiedModelCatalog({ cachePath: SDK_MODELS_DEV_CACHE_PATH, onUpdate: installModelsDevPricing });
await modelsDevCatalog.ensure();
const pricingRefreshTimer = setInterval(() => { void modelsDevCatalog.ensure(); }, 60_000);
pricingRefreshTimer.unref();
const traceManager = createTraceManager({
  pricingCachePath: SDK_MODELS_DEV_CACHE_PATH,
  onCompleted: async (trace) => {
    recordHostMenuTraceUsage(trace, store.getCachedAccounts());
    if (trace.userId) {
      // Quota accounting: one client request, and the provider attempt's tokens
      // and priced cost. Attempts carry the usage; client traces carry the count.
      const isAttempt = !trace.traceKind || trace.traceKind === "upstream-attempt";
      store.recordUserUsage(trace.userId, {
        requests: trace.traceKind === "client-request" ? 1 : 0,
        tokens: isAttempt ? trace.tokensTotal ?? 0 : 0,
        costUsd: isAttempt ? trace.costUsd ?? 0 : 0,
      });
    }
    const principal = trace.application
      ? store.getCachedProxyApiKeys().find((entry) => entry.application === trace.application)?.principal
        ?? { type: "service" as const, id: trace.application, name: trace.application }
      : { type: "unassigned" as const };
    await teamSync.recordTrace(trace, principal);
    if (!trace.clientRequestId) return;
    // Never expose trace bodies, credentials, account details, or headers to analytics hooks.
    // `requestedModel` is the model the client named (for example a virtual model id);
    // `model` is the model that actually served the attempt.
    const value = { traceId: trace.id, traceKind: trace.traceKind, requestedModel: trace.model, model: trace.resolvedModel ?? trace.model,
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
  indexedHistoryPath: process.env.TRACE_ANALYTICS_DB_PATH ?? `${TRACE_STATS_HISTORY_PATH}.sqlite`,
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
// Admin-set billed rates are independent of the upstream catalog and must be
// live before the first trace is priced.
setModelBillingOverrides(store.getCachedSettings().modelBilling);
setOffPeakSchedule(store.getCachedSettings().offPeak);
// Reconcile virtual models declared by bundled modules once the store and the
// module locks are loaded, so a restart can never leave a stale managed alias
// behind or publish an alias for a disabled module.
if (!MULTIVIBE_CONTROL_PLANE) {
  try { await syncVirtualModelAliases(store, moduleManager); }
  catch (error) { console.warn("Virtual model synchronization failed", error instanceof Error ? error.message : String(error)); }
}
// The extension owns the container and the saved endpoint; reconcile it after
// the module locks are loaded so a restart resumes compression without an
// operator click. Failures are logged and never block startup.
void headroomProvisioner.reconcile();
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
const hostUpdateController = MULTIVIBE_HOST_APPLICATION
  ? new HostUpdateController(
      MULTIVIBE_HOST_UPDATER_BINARY,
      MULTIVIBE_CONTROL_PLANE && V1_EDGE_INTERNAL_JOB_TOKEN
        ? {
            baseUrl: V1_EDGE_BASE_URL,
            internalToken: V1_EDGE_INTERNAL_JOB_TOKEN,
          }
        : undefined,
    )
  : undefined;
if (hostUpdateController) {
  app.use("/v1", hostUpdateController.inferenceMiddleware);
}

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
const multivibeCloud = new MultivibeCloudService(store, oauthStore, {
  authBaseUrl: MULTIVIBE_CLOUD_AUTH_BASE_URL,
  apiBaseUrl: MULTIVIBE_CLOUD_API_BASE_URL,
  inferenceBaseUrl: MULTIVIBE_CLOUD_INFERENCE_BASE_URL,
  redirectUri: MULTIVIBE_CLOUD_REDIRECT_URI,
  topupUrl: `${MULTIVIBE_CLOUD_API_BASE_URL}/billing`,
  privacyMode: MULTIVIBE_CLOUD_PRIVACY_MODE,
  managedTeamIdentity: teamSync,
});
multivibeCloud.start();
instanceRelay?.start();

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
  revision: number;
} | undefined;
let hostCloudStatusInFlight: ReturnType<MultivibeCloudService["getStatus"]> | undefined;

async function hostCloudStatus() {
  const revision = multivibeCloud.sessionRevision;
  if (hostCloudStatusCache?.revision === revision && Date.now() < hostCloudStatusCache.expiresAt) {
    return hostCloudStatusCache.value;
  }
  if (hostCloudStatusInFlight) return hostCloudStatusInFlight;
  hostCloudStatusInFlight = multivibeCloud.getStatus().then((value) => {
    hostCloudStatusCache = { value, revision, expiresAt: Date.now() + HOST_CLOUD_STATUS_CACHE_MS };
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
// Opt-in community benchmarks report. The machine descriptor prefers the
// supervised Provider Agent capability and falls back to bounded local
// detection; nothing is ever sent while the operator setting is off.
const communityReportSharing = COMMUNITY_BENCHMARKS_ENABLED
  ? createCommunityReportSharingWorker({
      settingsStore: store,
      traceSource: traceManager,
      hostProvider: detectCommunityHost,
      statePath: COMMUNITY_BENCHMARKS_STATE_PATH,
      apiBaseUrl: COMMUNITY_BENCHMARKS_API_BASE_URL,
    })
  : undefined;
void communityReportSharing?.start();
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

const liveModelCatalog = new LiveModelCatalog({ cachePath: SDK_LIVE_MODEL_CACHE_PATH });

// Minting service tokens delegates real access to the Cloudflare API, so it is
// opt-in, requires an admin boundary, and never runs implicitly for a key.
const cloudflareAccess = CLOUDFLARE_ACCESS_PROVISIONING
  ? createCloudflareAccessProvisioner({
      enabled: true,
      apiToken: CLOUDFLARE_API_TOKEN,
      defaultAccountId: CLOUDFLARE_ACCOUNT_ID,
      tokenDuration: CLOUDFLARE_ACCESS_TOKEN_DURATION,
      applications: CLOUDFLARE_ACCESS_APPS,
      error:
        CLOUDFLARE_ACCESS_APPS_ERROR ??
        (!ADMIN_TOKEN || ADMIN_TOKEN === "change-me"
          ? "ADMIN_TOKEN must be set to a non-placeholder value before Cloudflare Access provisioning can be enabled."
          : undefined),
    })
  : undefined;

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
  communityBenchmarks: communityReportSharing,
  hostApplication: MULTIVIBE_HOST_APPLICATION,
  hostHarnessIntegrations,
  hostConversationHarnesses,
  hostHarnessRuntime,
  instanceRelay,
  moduleManager,
  headroomProvisioner,
  hostUpdateController,
  multivibeCloud,
  teamSync,
  managedTeamEnrollment,
  appVersion,
  liveModelCatalog,
  modelsDevCatalog,
  cloudflareAccess,
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
const USER_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
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

function shouldUseSecureCookie(req: express.Request): boolean {
  return req.secure || req.header("x-forwarded-proto") === "https";
}

/**
 * Resolve the caller once per request. The cookie is the only source of user
 * identity, and the store is re-read so a suspended or demoted user loses
 * access immediately instead of when their 30-day cookie expires.
 */
function resolveAuth(req: express.Request): AuthIdentity | null {
  if (!ADMIN_TOKEN) return { role: "admin", via: "token" };
  const token =
    req.header("x-admin-token") ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (token && safeEqual(token, ADMIN_TOKEN)) return { role: "admin", via: "token" };
  const claims = verifySession(readCookie(req, ADMIN_SESSION_COOKIE), ADMIN_TOKEN);
  if (!claims) return null;
  // Legacy admin cookie (HMAC of a constant) carries no user id.
  if (!claims.userId) return { role: "admin", via: "session" };
  const user = store.getCachedUsers().find((candidate) => candidate.id === claims.userId);
  if (!user || user.status !== "active") return null;
  return { role: user.role, userId: user.id, via: "session" };
}

function setSessionCookie(
  req: express.Request,
  res: express.Response,
  claims: { userId?: string; role: "admin" | "member"; expiresAt: number },
) {
  res.cookie(ADMIN_SESSION_COOKIE, signSession(claims, ADMIN_TOKEN), {
    httpOnly: true,
    sameSite: "strict",
    secure: shouldUseSecureCookie(req),
    maxAge: Math.max(0, claims.expiresAt - Date.now()),
    path: "/",
  });
}

function clearSessionCookie(req: express.Request, res: express.Response) {
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
  const auth = resolveAuth(req);
  if (!auth) return res.status(401).json({ error: "unauthorized" });
  req.auth = auth;
  next();
}

app.use("/internal/ai-sdk", createSdkAdapterRouter({ store, internalToken: SDK_INTERNAL_TOKEN, liveModelCatalog, modelsDevCatalog }));

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
    res.json({ authenticated: Boolean(resolveAuth(req)) });
  });
}

app.get("/admin/host/menu-bar/activity", adminGuard, (_req, res) => {
  res.setHeader("cache-control", "no-store");
  const eligibleIds = buildHostMenuBarAccountsSummary(store.getCachedAccounts()).providers
    .filter((provider) => provider.windows.length > 0 || provider.balance !== undefined)
    .map((provider) => provider.id);
  res.json({ activity: getHostMenuProviderActivity(Date.now(), eligibleIds) ?? null, ...(MULTIVIBE_HOST_APPLICATION ? { deviceSignIn: takeDeviceSignIn() ?? null } : {}) });
});

app.get("/admin/host/menu-bar", adminGuard, async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const [accounts, traceStats, forecast, cloud] = await Promise.all([
    store.listAccounts(),
    traceManager.getTraceStats(),
    quotaResetForecastCache.get().catch(() => undefined),
    hostCloudStatus().catch(() => undefined),
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
    extensionWidgets: buildHostMenuBarExtensionWidgets(),
    githubStarPrompt: buildHostMenuBarGitHubStarPrompt(generatedOutputTokens),
    ...(forecast ? { forecast } : {}),
    ...(cloud ? { cloud } : {}),
    notifications: buildHostNotifications({
      accounts,
      resetCreditIncreases,
      ...(forecast ? { forecast } : {}),
      ...(previousForecastScore === undefined ? {} : { previousForecastScore }),
      ...(cloud ? { cloud } : {}),
      workerConfigured: false,
      generatedOutputTokens,
    }),
    earnings: {
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
    setSessionCookie(req, res, { role: "admin", expiresAt: Date.now() + ADMIN_SESSION_MAX_AGE_MS });
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
    setSessionCookie(req, res, { role: "admin", expiresAt: Date.now() + ADMIN_SESSION_MAX_AGE_MS });
    res.json({ authenticated: true });
  });

  app.delete("/admin/session", (req, res) => {
    clearSessionCookie(req, res);
    res.json({ authenticated: false });
  });
}

// --- Dashboard authentication (users) -------------------------------------
// These routes run before the admin guard: login and invite acceptance are the
// only unauthenticated dashboard entry points.

function inviteForToken(token: string) {
  const hash = hashInviteToken(token);
  return store
    .getCachedUsers()
    .find((candidate) => candidate.invite?.tokenHash === hash);
}

app.get("/admin/auth/invite", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const user = token ? inviteForToken(token) : undefined;
  if (!user?.invite || user.invite.expiresAt <= Date.now()) {
    return res.status(404).json({ error: "invite_invalid" });
  }
  res.setHeader("cache-control", "no-store");
  res.json({ email: user.email, ...(user.name ? { name: user.name } : {}) });
});

app.post(
  "/admin/auth/invite/accept",
  createAuthRateLimiter({ limit: 20 }),
  async (req, res) => {
    const token = String(req.body?.token ?? "");
    const password = String(req.body?.password ?? "");
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
    if (!token || !isValidPassword(password)) {
      return res.status(400).json({ error: "invalid_request" });
    }
    const user = inviteForToken(token);
    if (!user?.invite || user.invite.expiresAt <= Date.now()) {
      return res.status(410).json({ error: "invite_invalid" });
    }
    const updated = await store.patchUser(user.id, {
      password: await hashPassword(password),
      invite: null,
      status: "active",
      lastLoginAt: Date.now(),
      ...(name ? { name } : {}),
    });
    if (!updated) return res.status(410).json({ error: "invite_invalid" });
    setSessionCookie(req, res, {
      userId: updated.id,
      role: updated.role,
      expiresAt: Date.now() + USER_SESSION_MAX_AGE_MS,
    });
    res.setHeader("cache-control", "no-store");
    res.json({ authenticated: true, user: publicUser(updated) });
  },
);

app.post(
  "/admin/auth/login",
  createAuthRateLimiter({ limit: 20 }),
  async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    const user = email ? await store.findUserByEmail(email) : undefined;
    const valid = user ? await verifyPassword(password, user.password) : false;
    if (!user || !valid) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    if (user.status !== "active") {
      return res.status(403).json({ error: "user_suspended" });
    }
    const updated = await store.patchUser(user.id, { lastLoginAt: Date.now() });
    setSessionCookie(req, res, {
      userId: user.id,
      role: user.role,
      expiresAt: Date.now() + USER_SESSION_MAX_AGE_MS,
    });
    res.setHeader("cache-control", "no-store");
    res.json({ authenticated: true, user: publicUser(updated ?? user) });
  },
);

app.post("/admin/auth/logout", (req, res) => {
  clearSessionCookie(req, res);
  res.setHeader("cache-control", "no-store");
  res.json({ authenticated: false });
});

function passkeyFailure(res: express.Response, error: unknown) {
  if (error instanceof PasskeyError) {
    return res.status(error.status).json({ error: error.code });
  }
  return res.status(400).json({ error: "passkey_failed" });
}

// Passkey ceremonies are unauthenticated entry points, like the password login.
app.post(
  "/admin/auth/passkey/options",
  createAuthRateLimiter({ limit: 30 }),
  async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const user = email ? await store.findUserByEmail(email) : undefined;
      if (user && user.status !== "active") {
        return res.status(403).json({ error: "user_suspended" });
      }
      // With an email the browser is restricted to that account's credentials;
      // without one it may offer any discoverable passkey for this site.
      const { flowId, options } = await authenticationOptions(req, user);
      res.setHeader("cache-control", "no-store");
      res.json({ flowId, options });
    } catch (error) {
      passkeyFailure(res, error);
    }
  },
);

app.post(
  "/admin/auth/passkey/login",
  createAuthRateLimiter({ limit: 20 }),
  async (req, res) => {
    try {
      const result = await finishAuthentication(
        req,
        req.body?.flowId,
        req.body?.response,
        (credentialId) => findPasskeyOwner(store.getCachedUsers(), credentialId),
      );
      if (result.user.status !== "active") {
        return res.status(403).json({ error: "user_suspended" });
      }
      const updated = await store.patchUser(result.user.id, {
        passkeys: (result.user.passkeys ?? []).map((passkey) =>
          passkey.id === result.passkeyId
            ? { ...passkey, counter: result.counter, lastUsedAt: Date.now() }
            : passkey,
        ),
        lastLoginAt: Date.now(),
      });
      setSessionCookie(req, res, {
        userId: result.user.id,
        role: result.user.role,
        expiresAt: Date.now() + USER_SESSION_MAX_AGE_MS,
      });
      res.setHeader("cache-control", "no-store");
      res.json({ authenticated: true, user: publicUser(updated ?? result.user) });
    } catch (error) {
      passkeyFailure(res, error);
    }
  },
);

app.post("/admin/auth/passkey/register/options", adminGuard, async (req, res) => {
  const auth = getAuth(req);
  if (!auth?.userId) {
    return res.status(400).json({ error: "passkey_requires_account" });
  }
  const user = await store.findUser(auth.userId);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  try {
    const { flowId, options } = await registrationOptions(user, req);
    res.setHeader("cache-control", "no-store");
    res.json({ flowId, options });
  } catch (error) {
    passkeyFailure(res, error);
  }
});

app.post("/admin/auth/passkey/register", adminGuard, async (req, res) => {
  const auth = getAuth(req);
  if (!auth?.userId) {
    return res.status(400).json({ error: "passkey_requires_account" });
  }
  const user = await store.findUser(auth.userId);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  try {
    const passkey = await finishRegistration(
      req,
      user,
      req.body?.flowId,
      req.body?.response,
      req.body?.name,
    );
    const updated = await store.patchUser(user.id, {
      passkeys: [...(user.passkeys ?? []).filter((entry) => entry.id !== passkey.id), passkey],
    });
    res.json({ user: publicUser(updated ?? user) });
  } catch (error) {
    passkeyFailure(res, error);
  }
});

app.delete("/admin/auth/passkey/:id", adminGuard, async (req, res) => {
  const auth = getAuth(req);
  if (!auth?.userId) {
    return res.status(400).json({ error: "passkey_requires_account" });
  }
  const user = await store.findUser(auth.userId);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const remaining = (user.passkeys ?? []).filter((passkey) => passkey.id !== req.params.id);
  const updated = await store.patchUser(user.id, { passkeys: remaining });
  res.json({ user: publicUser(updated ?? user) });
});

app.post(
  "/admin/auth/password",
  adminGuard,
  createAuthRateLimiter({ limit: 20 }),
  async (req, res) => {
    const auth = getAuth(req);
    if (!auth?.userId) return res.status(400).json({ error: "password_managed_by_token" });
    const user = await store.findUser(auth.userId);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const next = String(req.body?.newPassword ?? "");
    if (!isValidPassword(next)) return res.status(400).json({ error: "weak_password" });
    if (user.password) {
      const current = String(req.body?.currentPassword ?? "");
      if (!(await verifyPassword(current, user.password))) {
        return res.status(403).json({ error: "invalid_password" });
      }
    }
    await store.patchUser(user.id, { password: await hashPassword(next) });
    res.json({ ok: true });
  },
);

app.get("/admin/me", adminGuard, async (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: "unauthorized" });
  if (!auth.userId) {
    return res.json({
      role: "admin",
      via: auth.via,
      adminToken: true,
      ...(ADMIN_TOKEN ? {} : { authDisabled: true }),
    });
  }
  const user = await store.findUser(auth.userId);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  res.setHeader("cache-control", "no-store");
  res.json({ role: user.role, via: auth.via, user: publicUser(user) });
});

app.use("/admin/users", adminGuard, createAdminUsersRouter({ store }));
app.use("/admin/model-billing", adminGuard, createAdminModelBillingRouter({ store }));
app.use("/admin/billing", adminGuard, createBillingRouter({ store, payments: paymentsService }));
app.use("/admin/payments", adminGuard, createAdminPaymentsRouter({ store, payments: paymentsService }));

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
// The shipped Compose default is a well-known placeholder. Serving the admin
// boundary with it would let anyone on the reachable network authenticate.
const INSECURE_ADMIN_TOKENS = new Set(["change-me"]);
if (ADMIN_TOKEN && INSECURE_ADMIN_TOKENS.has(ADMIN_TOKEN)) {
  console.warn(
    "multivibe admin token is a well-known placeholder value; set ADMIN_TOKEN before exposing this instance",
  );
}

const paymentsPoller = startPaymentsPoller(paymentsService, {
  intervalMs: MARKETPLACE_POLL_INTERVAL_MS,
});
void paymentsPoller.tick();

server.listen(nodeHost ? { port: nodePort, host: nodeHost } : { port: nodePort }, () => {
  smartRouting.startHealthMonitoring();
  hostHarnessIntegrations?.startCatalogSynchronization();
  console.log(
    `multivibe control plane listening on ${nodeHost ?? "all interfaces"}:${nodePort}`,
  );
  console.log(
    `store=${STORE_PATH} oauth=${OAUTH_STATE_PATH} trace=${TRACE_FILE_PATH} traceStats=${TRACE_STATS_HISTORY_PATH} codexProjects=${CODEX_PROJECTS_PATH} redirect=${oauthConfig.redirectUri} openaiUpstream=${CHATGPT_BASE_URL}${UPSTREAM_PATH} mistralUpstream=${MISTRAL_BASE_URL}${MISTRAL_UPSTREAM_PATH} zaiUpstream=${ZAI_BASE_URL}${ZAI_UPSTREAM_PATH} xaiUpstream=${XAI_BASE_URL}${XAI_RESPONSES_PATH}`,
  );
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  paymentsPoller.stop();
  multivibeCloud.stop();
  instanceRelay?.stop();
  if (shuttingDown) return;
  shuttingDown = true;
  smartRouting.stopHealthMonitoring();
  hostHarnessIntegrations?.stopCatalogSynchronization();
  await hostHarnessRuntime?.close();
  usageRefreshMonitor.stop();
  anonymousUsageSharing.stop();
  communityReportSharing?.stop();
  console.log(`received ${signal}, flushing persistent state`);
  server.close(async (error) => {
    try {
      await Promise.all([
        store.flushIfDirty(),
        codexProjectRegistry.flushPendingWrites(),
        traceManager.flushPendingWrites(),
      ]);
      clearInterval(pricingRefreshTimer);
      await traceManager.close();
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
