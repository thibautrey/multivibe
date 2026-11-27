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
  /** Owning dashboard user. Absent means the admin-managed shared pool. */
  ownerId?: string;
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

/** Operator-set price billed to users for one model, in USD per 1M tokens. */
export type OffPeakDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Local wall-clock range, `HH:MM` in the schedule timezone. */
export type OffPeakWindow = {
  start: string;
  /** An end before the start continues into the next day. */
  end: string;
};

export type OffPeakSchedule = {
  enabled: boolean;
  /** IANA zone, e.g. `UTC` or `Europe/Paris`. */
  timezone: string;
  days: Partial<Record<OffPeakDay, OffPeakWindow[]>>;
};

export type ModelBillingRate = {
  inputPer1M: number;
  outputPer1M: number;
  /** Cached input is usually cheaper; absent falls back to the input rate. */
  cachedInputPer1M?: number;
  /** Discounted rates used while the off-peak schedule is active. */
  offPeak?: {
    inputPer1M: number;
    outputPer1M: number;
    cachedInputPer1M?: number;
  };
};

export type StoreSettings = {
  /** Billed model rates override the upstream estimate for usage and dashboards. */
  modelBilling?: Record<string, ModelBillingRate>;
  /** Optional weekly off-peak calendar, evaluated in its own timezone. */
  offPeak?: OffPeakSchedule;
  /** Self-hosted marketplace billing: Stripe Connect through the broker. */
  payments?: PaymentsSettings;
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
  /** Owning dashboard user. Absent means an admin/global key. */
  ownerId?: string;
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

export type UserRole = "admin" | "member";
export type UserStatus = "active" | "suspended";
export type UserQuotaPeriod = "day" | "month" | "total";

export type UserPassword = {
  algo: "scrypt";
  salt: string;
  hash: string;
  updatedAt: number;
};

export type UserPasskey = {
  /** Base64url WebAuthn credential id. */
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  name?: string;
  createdAt: number;
  lastUsedAt?: number;
};

export type UserQuota = {
  /** Granted credit for the current period, in USD. Absent means unlimited. */
  creditUsd?: number;
  /** Maximum total tokens for the current period. Absent means unlimited. */
  maxTokens?: number;
  /** Maximum requests for the current period. Absent means unlimited. */
  maxRequests?: number;
  period: UserQuotaPeriod;
};

/** Rolling subscription windows. `5h` and `week` mirror the usual plan shape. */
export type UserQuotaWindowPeriod = "5h" | "day" | "week" | "month";

export type UserQuotaWindow = {
  /** Stable id used to keep per-window counters across edits. */
  id: string;
  label?: string;
  period: UserQuotaWindowPeriod;
  /** Spend cap for the window, in USD. Absent means unlimited. */
  creditUsd?: number;
  maxTokens?: number;
  maxRequests?: number;
};

export type UserPlanMode = "usage" | "subscription";

/**
 * Billing shape for one user. `usage` keeps the pay-as-you-go `quota` above;
 * `subscription` adds rolling windows that are enforced in addition to it.
 */
export type UserPlan = {
  mode: UserPlanMode;
  name?: string;
  /** Display-only monthly price of the plan, in USD. */
  priceUsd?: number;
  windows?: UserQuotaWindow[];
};

/** Counters for one subscription window, anchored at `startedAt`. */
export type UserWindowUsage = {
  /** Epoch ms when the current window opened; an older window is treated as empty. */
  startedAt: number;
  requests: number;
  tokens: number;
  costUsd: number;
  updatedAt?: number;
};

/** A subscription window with its current counters, for the dashboard. */
export type PublicUserQuotaWindow = UserQuotaWindow & {
  startedAt: number;
  /** Epoch ms when the window rolls over, when it is known. */
  resetsAt?: number;
  usage: { requests: number; tokens: number; costUsd: number };
  remaining: { creditUsd?: number; tokens?: number; requests?: number };
  blocked: boolean;
};

export type UserUsage = {
  /** Start of the accounting period the counters below belong to. */
  periodStart?: string;
  updatedAt?: number;
  requests: number;
  tokens: number;
  costUsd: number;
  /**
   * Part of `costUsd` covered by the period allowance. Undefined on records
   * written before prepaid credit existed; it is then derived from `costUsd`.
   */
  grantedCostUsd?: number;
};

export type CreditEntryKind =
  /** Admin changed the period allowance (`quota.creditUsd`). */
  | "allowance"
  /** Purchased or manually credited balance. */
  | "topup"
  /** Signed manual correction of the prepaid balance. */
  | "adjust"
  /** Balance returned after a refund or a dispute. */
  | "refund"
  /** Explicit debit that is not request usage (usage is traced separately). */
  | "debit";

/**
 * Append-only audit trail for balance movements. Per-request spending is not
 * logged here: traces already record it, and logging every request would bloat
 * `accounts.json`.
 */
export type CreditEntry = {
  id: string;
  kind: CreditEntryKind;
  /** Signed USD amount. */
  amountUsd: number;
  /** Prepaid balance after the entry. */
  balanceAfterUsd: number;
  at: number;
  actor?: string;
  note?: string;
  /** Broker payment reference, when the entry came from a top-up. */
  paymentId?: string;
};

/** How much of one broker payment has been applied to a wallet. */
export type AppliedPayment = {
  /** Credit granted by the payment, in USD. */
  creditUsd: number;
  /** Part already returned to the platform by refunds or disputes, in USD. */
  refundedUsd: number;
};

export type PaymentPack = {
  id: string;
  /** Display label; falls back to the credit amount. */
  label?: string;
  amountCents: number;
  currency: string;
  creditUsd: number;
  bonusUsd?: number;
  enabled?: boolean;
};

export type PaymentsSettings = {
  /** Master switch. Absent means disabled. */
  enabled: boolean;
  /** Broker base URL, also stored with the instance credentials. */
  brokerUrl?: string;
  /** Broker-side instance id, informational. */
  instanceId?: string;
  /** Commission fixed by the broker (informational, snapshotted per payment). */
  commissionBps?: number;
  chargeMode?: "direct" | "destination";
  currency: string;
  packs: PaymentPack[];
  /** Last broker outbox sequence applied to the local ledger. */
  lastEventCursor?: number;
  /** Last successful event sync. */
  lastSyncAt?: number;
  connect?: {
    status: "not_connected" | "pending" | "restricted" | "active";
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirementsDue: string[];
    accountId?: string;
    updatedAt?: number;
  };
};

export type UserInvite = {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
};

export type User = {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
  status: UserStatus;
  password?: UserPassword;
  passkeys?: UserPasskey[];
  quota: UserQuota;
  usage: UserUsage;
  /**
   * Prepaid balance in USD. Once defined, the member is on prepaid billing:
   * requests consume the period allowance first, then this balance, and the
   * account is blocked when both are exhausted. It never resets with the
   * quota period.
   */
  walletUsd?: number;
  /** Bounded audit trail of balance movements. */
  creditLedger?: CreditEntry[];
  /**
   * Stripe payments already applied to this balance, keyed by broker payment
   * id. Keeps webhook replays and event re-delivery idempotent even after the
   * bounded ledger has rotated.
   */
  paymentAwards?: Record<string, AppliedPayment>;
  plan?: UserPlan;
  /** Model ids this member may call. Absent or empty means every exposed model. */
  allowedModels?: string[];
  windowUsage?: Record<string, UserWindowUsage>;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
  invite?: UserInvite | null;
};

export type PublicUser = {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
  hasPassword: boolean;
  passkeys: Array<Pick<UserPasskey, "id" | "name" | "createdAt" | "lastUsedAt">>;
  quota: UserQuota;
  usage: Omit<UserUsage, "grantedCostUsd"> & { remainingCreditUsd?: number };
  /** Prepaid balance, when the member has one. */
  walletUsd?: number;
  plan?: UserPlan;
  allowedModels?: string[];
  quotaWindows?: PublicUserQuotaWindow[];
  invitePending?: boolean;
  inviteExpiresAt?: number;
};

export type StoreFile = {
  accounts: Account[];
  modelAliases?: ModelAlias[];
  proxyApiKeys?: StoredProxyApiKey[];
  applicationPolicies?: ApplicationPolicy[];
  users?: User[];
  settings?: StoreSettings;
};

export type OAuthFlowState = {
  id: string;
  email: string;
  codeVerifier: string;
  /** Exact callback used by a user-hosted MultiVibe Cloud authorization flow. */
  redirectUri?: string;
  createdAt: number;
  /** Dashboard user that started the flow. Absent for legacy/admin flows. */
  ownerId?: string;
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
