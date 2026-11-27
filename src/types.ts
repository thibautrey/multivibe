export type ProviderId =
  | "ai-sdk"
  | "openai"
  | "openai-compatible"
  | "opencode"
  | "mistral"
  | "zai"
  | "github-copilot"
  | "xai";
export type UpstreamMode = "responses" | "chat/completions";
export type CompatibilityMode =
  | "auto"
  | "responses"
  | "chat-completions-bridge";

export const PRIORITY_CLASSES = [
  "critical",
  "interactive",
  "standard",
  "batch",
] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];
export type ExecutionMode = "sync" | "auto" | "defer";
export type ExecutionLocation = "local" | "personal-cluster" | "cloud";
export type PrivacyMode = "standard" | "confidential_verified";
export type CapacityState = "ready" | "degraded" | "queue_only" | "unavailable";

export type CapacityProfile = {
  maxConcurrent?: number;
  prefillTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  contextWindow?: number;
  healthUrl?: string;
  metricsUrl?: string;
};

export type UsageWindow = {
  label?: string;
  usedPercent?: number;
  resetAt?: number; // epoch ms
  windowSeconds?: number;
};

export type UsageSnapshot = {
  codexCredits?: { remaining?: number; hasCredits?: boolean; unlimited?: boolean; overageLimitReached?: boolean }; // additive Codex credits, independent of subscription windows
  balance?: { remaining: number; unit: string }; // absolute balance; never infer a percentage without a total
  spend?: { amount: number; unit: string };
  allowances?: Array<UsageWindow & { label: string }>; // informational allowances, not hard inference limits
  primary?: UsageWindow; // normalized ~5h window
  secondary?: UsageWindow; // normalized weekly window
  monthly?: UsageWindow; // normalized monthly window when exposed by a provider
  credits?: UsageWindow; // subscription credits; provider-defined billing period
  tools?: UsageWindow; // MCP/tool allowance; never used for model routing
  quotaStatus?: "available" | "unsupported" | "error";
  quotaMessage?: string;
  fetchedAt: number;
};

export type AccountSelectionReason =
  | "sticky"
  | "policy-preferred"
  | "quota-headroom";

export type AccountSelectionTelemetry = {
  reason: AccountSelectionReason;
  provider: ProviderId;
  candidateCount: number;
  eligibleCount: number;
  nearLimitCount: number;
  rotated: boolean;
  selectedHeadroomPercent?: number;
  selectedWeeklyRemainingPercent?: number;
  selectedFiveHourRemainingPercent?: number;
};

export type AccountSelectionSummary = {
  attempts: number;
  rotations: number;
  maxNearLimit: number;
  averageHeadroom?: number;
  reasonCounts: Record<AccountSelectionReason, number>;
};

export type AccountError = {
  at: number;
  message: string;
};

export type AccountState = {
  modelBlocks?: Record<string, { until: number; reason: string }>;
  lastError?: string;
  lastSelectedAt?: number;
  recentErrors?: AccountError[];
  recentEmptyResponses?: AccountError[];
  needsTokenRefresh?: boolean;
  authBlockedUntil?: number;
  lastUsageRefreshAt?: number;
  scheduledWeeklyReset?: {
    scheduledAt: number;
    idempotencyKey: string;
    thresholdRemainingPercent: number;
    lastAttemptAt?: number;
    lastError?: string;
  };
};

export type LocalRuntimeAdapterId =
  | "ollama" | "lm-studio" | "llama-cpp" | "vllm" | "sglang" | "localai"
  | "huggingface-tgi" | "transformers-serve" | "xinference" | "mlx-lm" | "omlx"
  | "mlc-llm" | "exo" | "jan" | "gpt4all" | "koboldcpp" | "text-generation-webui"
  | "aphrodite" | "tabbyapi" | "llama-box" | "mistral-rs" | "nvidia-nim"
  | "tensorrt-llm" | "triton" | "openllm" | "bentoml" | "mtplx" | "nvidia-pair"
  | "manual-openai-compatible";

export type LocalRuntimeMetadata = {
  source: "multivibe-local-discovery" | "multivibe-local-configuration";
  adapter: LocalRuntimeAdapterId;
  endpoint: string;
  confirmedModelIds: string[];
  authentication: "none";
};

export type Account = {
  id: string;
  provider?: ProviderId;
  sdkProvider?: string;
  sdkModels?: string[];
  upstreamMode?: UpstreamMode;
  compatibilityMode?: CompatibilityMode;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  chatgptAccountId?: string;
  opencodeAccountId?: string;
  opencodeOrgId?: string;
  opencodeOrgName?: string;
  opencodeConsoleUrl?: string;
  opencodeApiKey?: string;
  opencodeHeaders?: Record<string, string>;
  copilotModelEndpoints?: Record<string, UpstreamMode>;
  xaiUserId?: string;
  xaiAuthScope?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  baseUrl?: string;
  enabled: boolean;
  priority?: number;
  location?: ExecutionLocation;
  capacityProfile?: CapacityProfile;
  localRuntime?: LocalRuntimeMetadata;
  /** Internal account created by the automatic MultiVibe Cloud connection flow. */
  multivibeCloud?: boolean;
  /** Cloud-authoritative Team provider metadata. Synced accounts are immutable locally. */
  multivibeTeam?: {
    providerId: string;
    /** Exact upstream model IDs selected by the Team administrator. Missing means deny. */
    models?: string[];
    deliveryMode: "distributed" | "cloud_proxy";
    revision: number;
    readOnly: true;
  };
  /** Enforced transport for this account. Confidential accounts cannot use the ordinary provider path. */
  privacyMode?: PrivacyMode;
  usage?: UsageSnapshot;
  state?: AccountState;
};

export type TimeWindow = {
  days?: number[];
  start: string;
  end: string;
  timezone?: string;
};

export type RoutingRuleMatch = {
  applications?: string[];
  priorities?: PriorityClass[];
  efforts?: string[];
  modalities?: Array<"text" | "image" | "audio" | "video">;
  requiresTools?: boolean;
  executionModes?: ExecutionMode[];
  minInputTokens?: number;
  maxInputTokens?: number;
  timeWindows?: TimeWindow[];
};

export type RoutingRuleConstraints = {
  allowedLocations?: ExecutionLocation[];
  requiredPrivacy?: PrivacyMode;
  maxPredictedWaitMs?: number;
  minContextWindow?: number;
  minQuality?: number;
};

export type RoutingObjectives = {
  latency: number;
  cost: number;
  quality: number;
  locality: number;
};

export type RoutingCandidateConfig = {
  model: string;
  provider?: ProviderId;
  accountIds?: string[];
  location?: ExecutionLocation;
  quality?: number;
  inputCostPerMillionUsd?: number;
  outputCostPerMillionUsd?: number;
  capacityProfile?: CapacityProfile;
};

export type RoutingRule = {
  id: string;
  enabled?: boolean;
  match?: RoutingRuleMatch;
  constraints?: RoutingRuleConstraints;
  objectives?: RoutingObjectives;
  candidates: RoutingCandidateConfig[];
  onNoCapacity?: "next-rule" | "queue" | "reject";
  cloudBudget?: {
    amountUsd: number;
    period: "hour" | "day" | "month";
  };
};

export type ModelAlias = {
  schemaVersion: 2;
  id: string;
  rules: RoutingRule[];
  enabled: boolean;
  description?: string;
  defaults?: {
    priority?: PriorityClass;
    executionMode?: ExecutionMode;
    /**
     * Capability facts the alias publishes when its routing target does not.
     * A deployment may serve a model whose own catalog entry carries only an
     * id and a window; clients still need the window, modalities and reasoning
     * options to size compaction and build the effort selector. Declarations
     * only fill what the target left empty.
     */
    capabilities?: AliasCapabilities;
  };
};

/** Capability facts an alias may declare for a target that publishes none. */
export type AliasCapabilities = {
  context_window?: number;
  max_output_tokens?: number;
  supports_reasoning?: boolean;
  supports_tools?: boolean;
  supports_structured_output?: boolean;
  supports_temperature?: boolean;
  reasoning_options?: Array<Record<string, unknown>>;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_tool_types?: string[];
  display_name?: string;
  description?: string;
};

export type LegacyModelAlias = {
  id: string;
  targets: string[];
  enabled: boolean;
  description?: string;
};

export type StoreSettings = {
  defaultPassthroughAccountId?: string;
  imageRequestModelOverride?: string;
  /** Concrete local model behind multivibe/voice. */
  voiceLocalModel?: string;
  /** Stronger model used when a voice turn crosses the escalation threshold. */
  voiceAdvancedModel?: string;
  /** 0..1 heuristic threshold for escalating a voice turn. */
  voiceEscalationThreshold?: number;
  /** Defaults to true when a local or advanced voice model is configured. */
  voiceEscalationEnabled?: boolean;
  anonymousUsageSharingEnabled?: boolean;
  anonymousUsageSharingEnabledAt?: string;
  /** Opt-in community benchmarks report (schema v2). Absent means disabled. */
  communityBenchmarksSharingEnabled?: boolean;
  communityBenchmarksSharingEnabledAt?: string;
  multivibeCloudDisconnectedAt?: number;
  /** Private OAuth credentials for the local MultiVibe Cloud connection. */
  multivibeCloud?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    projectId?: string;
    apiKeyExpiresAt?: number;
    /** Durable key for one possibly committed refresh attempt, never a new key on retry. */
    refreshAttemptId?: string;
    authenticationRequired?: boolean;
  };
  multivibeTeam?: {
    enabled: boolean;
    instanceId: string;
    instanceName: string;
    syncCursor: number;
    lastSuccessfulSyncAt?: string;
    lastSuccessfulAnalyticsUploadAt?: string;
    organizationId?: string;
    membershipId?: string;
    managementChannel?: "device" | "user";
    deviceClaim?: { issuer: string; subject: string; nonce: string } | null;
    managedEnrollmentId?: string;
    teamKeyId?: string;
  };
};

export type StoredProxyApiKeyCloudflareAccess = {
  accountId: string;
  applicationId: string;
  policyId?: string;
  serviceTokenId: string;
  clientId: string;
  expiresAt?: string;
};

export type StoredProxyApiKey = {
  id: string;
  application: string;
  key: string;
  createdAt: number;
  principal?: {
    type: "member" | "service";
    id: string;
    name?: string;
  };
  /** Cloudflare Access service token provisioned with this key, if opted in. */
  cloudflareAccess?: StoredProxyApiKeyCloudflareAccess;
};

export type ApplicationWebhook = {
  id: string;
  url: string;
  secret: string;
  enabled: boolean;
  createdAt: number;
};

export type ShareWindow = {
  /** Inclusive local start hour, 0-23, in Europe/Paris. */
  startHour: number;
  /** Exclusive local end hour, 1-24. May wrap past midnight. */
  endHour: number;
  /** ISO weekdays, Monday = 1. Absent means every day. */
  days?: number[];
  multiplier: number;
};

export type ApplicationPolicy = {
  application: string;
  fairnessWeight: number;
  /** Fraction of an account's slots this application may hold. */
  maxConcurrentShare?: number;
  /** Extra slots, only while no other application uses the account. */
  burst?: number;
  /** Periods that widen the share. Absent keeps the night/weekend default. */
  shareWindows?: ShareWindow[];
  webhooks: ApplicationWebhook[];
};

export type StoreFile = {
  accounts: Account[];
  modelAliases?: ModelAlias[];
  proxyApiKeys?: StoredProxyApiKey[];
  applicationPolicies?: ApplicationPolicy[];
  settings?: StoreSettings;
};

export type OAuthFlowState = {
  id: string;
  email: string;
  codeVerifier: string;
  /** Exact callback used by a user-hosted MultiVibe Cloud authorization flow. */
  redirectUri?: string;
  createdAt: number;
  method?: "browser" | "device";
  provider?: "openai" | "opencode" | "xai" | "github-copilot";
  targetAccountId?: string;
  status: "pending" | "success" | "error";
  error?: string;
  completedAt?: number;
  accountId?: string;
  deviceAuthId?: string;
  userCode?: string;
  verificationUrl?: string;
  intervalSeconds?: number;
  expiresAt?: number;
};

export type OAuthStateFile = {
  states: OAuthFlowState[];
};
