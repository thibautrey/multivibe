import { createVirtualModelMiddleware } from "./module-virtual-models.js";
import { estimateCostUsd } from "./model-pricing.js";
import type { ModuleServices } from "./module-sdk.js";
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
import { createAdminRouter } from "./routes/admin/index.js";
import { createProxyRouter, discoverModels } from "./routes/proxy/index.js";
import { createRealtimeRouter } from "./realtime-proxy.js";
import { HostHarnessIntegrationManager } from "./host/harness-integrations.js";
import { installResponsesWebsocketProxy } from "./websocket-responses.js";
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
import { scheduleWeeklyReset, startScheduledWeeklyResetMonitor } from "./rate-limit-reset.js";
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
import { JobRunner, JobStore } from "./jobs.js";
import {
  SmartRoutingCoordinator,
  createAdmissionMiddleware,
  createSmartRoutingRouter,
} from "./smart-routing-routes.js";
import { startEmbeddedProviderAgent } from "./provider-agent-supervisor.js";
import { createInferenceIdempotencyMiddleware } from "./inference-idempotency.js";
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
const hostHarnessIntegrations = MULTIVIBE_HOST_APPLICATION
  ? new HostHarnessIntegrationManager({
      homeDirectory: HOST_HARNESS_HOME_DIRECTORY,
      statePath: HOST_HARNESS_INTEGRATIONS_STATE_PATH,
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
  historyFilePath: TRACE_STATS_HISTORY_PATH,
  retentionMax: TRACE_RETENTION_MAX,
  resolveCodexProject: (sessionId, projectRoot, projectHost) =>
    codexProjectRegistry.resolve(sessionId, projectRoot, projectHost),
});
const configuredProxyApiKeys = parseProxyApiKeys(PROXY_API_KEY, PROXY_API_KEYS);
await Promise.all([
  store.init(),
  oauthStore.init(),
  codexProjectRegistry.init(),
  traceManager.initialize(),
  moduleManager.initialize(),
]);
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
});
const quotaResetForecastCache = new CodexQuotaResetForecastCache();
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
  appVersion: process.env.APP_VERSION ?? "unknown",
  storagePaths: {
    accountsPath: STORE_PATH,
    oauthStatePath: OAUTH_STATE_PATH,
    tracePath: TRACE_FILE_PATH,
    traceStatsHistoryPath: TRACE_STATS_HISTORY_PATH,
    codexProjectsPath: CODEX_PROJECTS_PATH,
  },
});

const MODULE_INFERENCE_TOKEN = crypto.randomBytes(32).toString("base64url");
const moduleServices = (application?: string): ModuleServices => {
  const completeWithUsage: NonNullable<ModuleServices["completeWithUsage"]> = async (input, signal) => {
    if (MULTIVIBE_CONTROL_PLANE) throw new Error("JavaScript inference plugins require the JavaScript inference profile");
    const models = await discoverModels(store, CHATGPT_BASE_URL, MISTRAL_BASE_URL, ZAI_BASE_URL);
    if (!models.some((model) => model.id === input.model)) throw new Error("Classifier model is not configured");
    const response = await fetch(`http://127.0.0.1:${nodePort}/v1/chat/completions`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-multivibe-module-token": MODULE_INFERENCE_TOKEN,
        "x-multivibe-internal-application": application ?? "default" },
      body: JSON.stringify({ ...input, max_tokens: Math.max(1, Math.min(512, input.max_tokens)), stream: false }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Classifier HTTP ${response.status}`); }
    const result = await response.json() as any;
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Classifier did not return text");
    const model = typeof result.model === "string" ? result.model : input.model;
    const usage = result.usage;
    const tokensInput = usage?.prompt_tokens ?? usage?.input_tokens;
    const tokensOutput = usage?.completion_tokens ?? usage?.output_tokens;
    const costUsd = typeof tokensInput === "number" && typeof tokensOutput === "number"
      ? estimateCostUsd(model, tokensInput, tokensOutput, usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? 0)
      : undefined;
    return { text: content, model, costUsd };
  };
  return {
    listModels: () => discoverModels(store, CHATGPT_BASE_URL, MISTRAL_BASE_URL, ZAI_BASE_URL),
    completeWithUsage,
    complete: async (input, signal) => (await completeWithUsage(input, signal)).text,
  };
};

const proxyRouter = createProxyRouter({
  store,
  traceManager,
  openaiBaseUrl: CHATGPT_BASE_URL,
  mistralBaseUrl: MISTRAL_BASE_URL,
  mistralUpstreamPath: MISTRAL_UPSTREAM_PATH,
  mistralCompactUpstreamPath: MISTRAL_COMPACT_UPSTREAM_PATH,
  zaiBaseUrl: ZAI_BASE_URL,
  zaiUpstreamPath: ZAI_UPSTREAM_PATH,
  zaiCompactUpstreamPath: ZAI_COMPACT_UPSTREAM_PATH,
  oauthConfig,
  capacityTracker,
  smartRoutingCoordinator: smartRouting,
  usageRefreshCoordinator,
  moduleManager,
  moduleServices,
  ...(confidentialInference ? { confidentialInference } : {}),
});

const realtimeRouter = createRealtimeRouter({
  store,
  oauthConfig,
  traceManager,
  chatgptBaseUrl: CHATGPT_BASE_URL,
  provider: REALTIME_PROVIDER,
  webrtcCallUrl: REALTIME_WEBRTC_CALL_URL || undefined,
  requestTimeoutMs: REALTIME_REQUEST_TIMEOUT_MS,
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

function hasProxyApiKey(headers: http.IncomingHttpHeaders): boolean {
  const proxyApiKeys = [
    ...configuredProxyApiKeys,
    ...store.getCachedProxyApiKeys(),
  ];
  if (!proxyApiKeys.length) return true;
  return Boolean(identifyProxyApplication(headers, proxyApiKeys));
}

function proxyGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const moduleToken = req.header("x-multivibe-module-token");
  if (moduleToken && safeEqual(moduleToken, MODULE_INFERENCE_TOKEN)) {
    res.locals.proxyApplication = req.header("x-multivibe-internal-application") || "default";
    delete req.headers["x-multivibe-module-token"];
    res.locals.multivibeModuleInternal = true;
    return next();
  }
  const internalToken = req.header("x-multivibe-internal-token");
  if (internalToken && safeEqual(internalToken, INTERNAL_JOB_TOKEN)) {
    res.locals.proxyApplication =
      req.header("x-multivibe-internal-application") || "internal-job";
    return next();
  }
  const proxyApiKeys = [
    ...configuredProxyApiKeys,
    ...store.getCachedProxyApiKeys(),
  ];
  if (!proxyApiKeys.length || hasAdminSession(req)) {
    return next();
  }
  const application = identifyProxyApplication(req.headers, proxyApiKeys);
  if (application) {
    res.locals.proxyApplication = application;
    return next();
  }
  if (/\/(?:v1\/)?messages(?:\?|$)/.test(req.originalUrl)) {
    return res
      .status(401)
      .json(anthropicErrorEnvelope(401, "Invalid or missing proxy API key"));
  }
  return res.status(401).json({
    error: {
      message: "Invalid or missing proxy API key",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  });
}

function rootProxyGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const pathOrUrl = req.path || "/";
  const accepts = String(req.header("accept") ?? "").toLowerCase();
  const isKnownProxyEndpoint =
    pathOrUrl === "/chat/completions" ||
    pathOrUrl === "/responses" ||
    pathOrUrl === "/responses/compact" ||
    pathOrUrl === "/messages" ||
    pathOrUrl === "/models" ||
    pathOrUrl.startsWith("/models/") ||
    pathOrUrl === "/api/v1/models" ||
    pathOrUrl.startsWith("/api/v1/models/") ||
    pathOrUrl === "/api/tags" ||
    pathOrUrl === "/version" ||
    pathOrUrl === "/props" ||
    pathOrUrl === "/v1/props";
  if (
    pathOrUrl === "/" ||
    pathOrUrl === "/health" ||
    pathOrUrl === "/favicon.ico" ||
    pathOrUrl.startsWith("/admin") ||
    pathOrUrl.startsWith("/assets") ||
    (req.method === "GET" &&
      accepts.includes("text/html") &&
      !isKnownProxyEndpoint)
  ) {
    return next();
  }
  return proxyGuard(req, res, next);
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
  res.json({
    operational: true,
    ...accountSummary,
    githubStarPrompt: buildHostMenuBarGitHubStarPrompt(generatedOutputTokens),
    ...(forecast ? { forecast } : {}),
    ...(cloud ? { cloud } : {}),
    notifications: buildHostNotifications({
      accounts,
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

app.use("/admin", adminGuard, adminRouter);

// These middleware instances remain available to the single-process profile.
// The native profile does not mount them on `/v1`: that surface terminates in
// the Rust edge. SDK-backed providers use the separate internal SDK adapter.
const inferenceIdempotencyMiddleware = createInferenceIdempotencyMiddleware({
  ttlMs: INFERENCE_IDEMPOTENCY_TTL_MS,
  inFlightTimeoutMs: INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS,
  maxEntries: INFERENCE_IDEMPOTENCY_MAX_ENTRIES,
  maxBytes: INFERENCE_IDEMPOTENCY_MAX_BYTES,
  maxResponseBytes: INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES,
});
const virtualModelMiddleware = createVirtualModelMiddleware(moduleManager, moduleServices);
const admissionMiddleware = createAdmissionMiddleware(smartRouting);
const smartRoutingRouter = createSmartRoutingRouter(smartRouting);
// In the native profile Rust owns the complete `/v1` surface. Keep the
// historical Express stack only for the single-process development profile;
// the control-plane listener must not become a second `/v1` implementation.
if (!MULTIVIBE_CONTROL_PLANE) {
  app.use(
    "/v1",
    proxyGuard,
    hostUpdateController?.inferenceMiddleware ?? ((_req, _res, next) => next()),
    inferenceIdempotencyMiddleware,
    virtualModelMiddleware,
    admissionMiddleware,
    smartRoutingRouter,
  );
  app.use("/v1", realtimeRouter);
  app.use("/v1", proxyRouter);
  app.use(
    "/",
    rootProxyGuard,
    hostUpdateController?.inferenceMiddleware ?? ((_req, _res, next) => next()),
    inferenceIdempotencyMiddleware,
    virtualModelMiddleware,
    admissionMiddleware,
    realtimeRouter,
  );
  app.use("/", proxyRouter);
}

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
const jobRunner = new JobRunner(
  jobStore,
  async (job) => {
    const executionTimeoutMs = Math.max(
      1,
      Math.min(
        30 * 60_000,
        job.deadlineAt ? job.deadlineAt - Date.now() : Number.POSITIVE_INFINITY,
      ),
    );
    const response = await fetch(
      `${MULTIVIBE_CONTROL_PLANE ? V1_EDGE_BASE_URL : `http://127.0.0.1:${nodePort}`}${job.route}`,
      {
      method: job.method,
      headers: {
        ...job.requestHeaders,
        "content-type": "application/json",
        "x-multivibe-internal-token":
          V1_EDGE_INTERNAL_JOB_TOKEN || INTERNAL_JOB_TOKEN,
        "x-multivibe-internal-application": job.application,
        "x-multivibe-internal-job": "1",
        "x-multivibe-priority": job.priority,
        "x-multivibe-execution": "sync",
      },
      body: JSON.stringify(job.requestBody),
      signal: AbortSignal.timeout(executionTimeoutMs),
      },
    );
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // Keep non-JSON upstream output as text.
    }
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "request-id", "openai-request-id", "anthropic-request-id"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    return {
      status: response.status,
      headers,
      body,
      capacityUnavailable:
        response.status === 429 &&
        typeof body === "object" &&
        body !== null &&
        (body as any).error?.code === "capacity_unavailable",
    };
  },
  (application, id) =>
    store.getApplicationPolicy(application).webhooks.find((webhook) => webhook.id === id),
  JOB_WORKER_CONCURRENCY,
);
if (!MULTIVIBE_CONTROL_PLANE) {
  hostUpdateController?.attachJobRunner(jobRunner);
}

if (!MULTIVIBE_CONTROL_PLANE && MULTIVIBE_CLOUD_PRIVACY_MODE !== "confidential_verified") {
  installResponsesWebsocketProxy({
    server,
    port: nodePort,
    authorize: (req) => hasProxyApiKey(req.headers),
    admit: hostUpdateController?.admitWebsocket,
    onTurnStarted: hostUpdateController?.websocketTurnStarted,
    onTurnFinished: hostUpdateController?.websocketTurnFinished,
  });
}

server.listen(nodeHost ? { port: nodePort, host: nodeHost } : { port: nodePort }, () => {
  if (!MULTIVIBE_CONTROL_PLANE) {
    jobRunner.start();
  }
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
  jobRunner.stop();
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
