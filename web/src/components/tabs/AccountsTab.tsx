import type { ModelRoute } from "../../lib/modelCatalog";
import { findAvailableCount } from "../../lib/resetCredits";
import ModalPortal from "../ModalPortal";
import type { Account, ProviderId, StoreSettings, TraceStats } from "../../types";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmt, maskEmail, maskId, usd } from "../../lib/ui";
import { ApiError, api } from "../../lib/api";
import {
  observeFloatingViewportChanges,
  placeFloatingMenu,
  type FloatingMenuAnchor,
  type FloatingMenuPlacement,
  type FloatingMenuViewport,
} from "../../lib/floatingMenu";
import {
  runtimeIdentityForAccount,
  runtimeIdentityForAdapter,
} from "../../lib/runtimeCatalog";

import { ProviderPicker, ProviderMark, SETUP_PROVIDERS, type SetupProvider } from "../ProviderPicker";
import { Metric } from "../Metric";
import { WidgetGrid } from "../WidgetGrid";
import { createPortal } from "react-dom";

const CODEX_QUOTA_RESET_FORECAST_URL = "https://www.willcodexquotareset.com/";

type Props = {
  traceStats: TraceStats;
  accounts: Account[];
  localWorker: LocalWorkerProvider | null;
  multivibeCloud: MultivibeCloudProvider;
  usageCacheTtlMs: number;
  settings: StoreSettings;
  sanitized: boolean;
  patch: (id: string, body: any) => Promise<void>;
  del: (id: string) => Promise<void>;
  unblock: (id: string) => Promise<void>;
  refreshUsage: (id: string) => Promise<void>;
  consumeRateLimitResetCredit: (id: string) => Promise<void>;
  scheduleRateLimitResetCredit: (id: string) => Promise<void>;
  cancelScheduledRateLimitResetCredit: (id: string) => Promise<void>;
  createAccount: (body: any) => Promise<void>;
  importGrokAuth: () => Promise<any>;
  patchSettings: (body: Partial<StoreSettings>) => Promise<void>;
  onConnectCloud: () => Promise<void>;
  onDisconnectCloud: () => Promise<void>;
  startOAuth: (
    email: string,
    accountId?: string,
    method?: OAuthMethod,
    provider?: "openai" | "opencode" | "xai",
  ) => Promise<any>;
  pollDeviceOAuth: (flowId: string) => Promise<any>;
  completeOAuth: (flowId: string, input: string) => Promise<any>;
  oauthRedirectUri: string;
  providerSetupRequest?: number;
  modelSetupTarget?: ModelRoute;
  onModelSetupConsumed?: () => void;
  onboardingProviderSetup?: boolean;
  onProviderSetupClosed?: () => void;
  onSkipOnboarding?: () => void;
};

export type LocalWorkerProvider = {
  id: "multivibe-worker-local";
  kind: "system-local-worker";
  name: "MultiVibe Worker";
  location: "local";
  enrollment_state: "not_enrolled" | "enrolled";
  capacity_state: "not_configured" | "disabled" | "paused" | "enabled";
  cloud_runtime: "managed-ollama";
  trust_tier: "community";
  removable: false;
  routing_eligible: false;
  compensation_eligible: false;
  capability: {
    profile: "apple-silicon" | "intel-mac" | "linux-nvidia" | "linux-cpu" | "windows-nvidia";
    accelerator: "metal" | "cuda" | "cpu";
    hardware: string;
    accelerator_memory_bytes: number;
  };
  estimated_monthly_earnings: {
    currency: "USD";
    period: "month";
    amount: string;
    basis: "same_chip" | "fleet_median" | "no_observations" | "catalog_unavailable";
    sample_count: number;
    as_of_date?: string;
    disclaimer: string;
  };
  connect_url: string;
};

export type MultivibeCloudProvider = {
  status: "disconnected" | "connected" | "unavailable";
  dollarCreditsUsd?: string;
  balanceUsd?: string;
  subscription?: string;
  topupUrl: string;
};

type AccountProvider = ProviderId | "nvidia-pair";
type OAuthMethod = "browser" | "device";

type QuotaResetForecast = {
  score: number;
  state: string;
  horizonHours?: number;
};

type QuotaResetForecastStatus = "idle" | "loading" | "ready" | "error";

type OpenAccountMenu = {
  accountId: string;
  anchor: FloatingMenuAnchor;
  placement: FloatingMenuPlacement;
};

function currentFloatingViewport(): FloatingMenuViewport {
  const viewport = window.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

type EditAccountState = {
  id: string;
  provider: AccountProvider;
  upstreamMode: "" | "responses" | "chat/completions";
  email: string;
  accessToken: string;
  refreshToken: string;
  chatgptAccountId: string;
  baseUrl: string;
  priority: string;
  enabled: boolean;
  location: "local" | "personal-cluster" | "cloud";
  maxConcurrent: string;
  prefillTokensPerSecond: string;
  decodeTokensPerSecond: string;
  contextWindow: string;
  healthUrl: string;
  metricsUrl: string;
};

type OAuthDialogState = {
  flowId: string;
  email: string;
  authorizeUrl: string;
  expectedRedirectUri: string;
  method: OAuthMethod;
  userCode?: string;
  verificationUrl?: string;
  intervalSeconds?: number;
  expiresAt?: number;
  callbackInput: string;
  isSubmitting: boolean;
  mode: "create" | "reauth";
  accountId?: string;
  pendingPriority?: number;
  pendingEnabled?: boolean;
  provider: "openai" | "opencode" | "xai";
};

type ProviderAgentSelection = {
  schema_version: "provider-selection-v1";
  revision: number;
  state: "detected" | "selected";
  selected_models: string[];
};

type ProviderAgentDetectedModels = {
  schema_version: "provider-detected-models-v2";
  observed_at: string;
  runtimes: Array<{ adapter_id: string; models: string[] }>;
  diagnostics: Array<{ adapter_id: string; status: "available" | "unavailable" | "degraded"; code: string }>;
};

type ProviderAgentAdapterRegistry = {
  schema_version: "provider-runtime-registry-v2";
  adapters: Array<{
    id: string;
    display_name: string;
    authentication: "none" | "optional-bearer" | "required-bearer";
    automatic_loopback_candidates: Array<{ endpoint: string }>;
  }>;
};

type ProviderAgentRuntimeEndpoints = {
  schema_version: "provider-runtime-endpoints-v1";
  revision: number;
  endpoints: Array<{
    adapter_id: string;
    endpoint: string;
    authentication: "none" | "bearer";
  }>;
};

type ProviderRuntimeEndpointDraft = {
  adapterId: string;
  endpoint: string;
  bearerToken: string;
  existingAuthentication: "none" | "bearer";
  clearBearer: boolean;
};

type ProviderCapacityPolicyState = {
  schema_version: "provider-capacity-policy-state-v1";
  revision: number;
  paused: boolean;
  automatic_downloads: boolean;
  allow_cloud_workloads: boolean;
  policy: {
    schema_version: "provider-capacity-policy-v1";
    gpu_utilization_percent: number;
    gpu_vram_percent: number;
    max_disk_bytes: number;
    model_storage_path: string;
    max_download_bytes_per_day: number;
    minimum_model_residency_seconds: number;
    max_model_changes_per_day: number;
    reserve_free_disk_bytes: number;
  };
};

type ProviderCapacityPolicyDraft = {
  paused: boolean;
  automaticDownloads: boolean;
  allowCloudWorkloads: boolean;
  gpuUtilizationPercent: string;
  gpuVramPercent: string;
  maxDiskGiB: string;
  modelStoragePath: string;
  maxDownloadGiBPerDay: string;
  minimumModelResidencySeconds: string;
  maxModelChangesPerDay: string;
  reserveFreeDiskGiB: string;
};

type ProviderPreviewStatus =
  | "idle"
  | "loading"
  | "ready"
  | "saving"
  | "unavailable"
  | "error";

type ProviderCapacityStatus =
  | "idle"
  | "loading"
  | "ready"
  | "saving"
  | "unavailable"
  | "error";

const BYTES_PER_GIB = 1024 ** 3;

function defaultProviderCapacityPolicyDraft(): ProviderCapacityPolicyDraft {
  return {
    paused: true,
    automaticDownloads: false,
    allowCloudWorkloads: false,
    gpuUtilizationPercent: "80",
    gpuVramPercent: "75",
    maxDiskGiB: "30",
    modelStoragePath: "/var/lib/multivibe/models",
    maxDownloadGiBPerDay: "20",
    minimumModelResidencySeconds: "21600",
    maxModelChangesPerDay: "4",
    reserveFreeDiskGiB: "5",
  };
}

function capacityPolicyDraftFromState(
  state: ProviderCapacityPolicyState,
): ProviderCapacityPolicyDraft {
  return {
    paused: state.paused,
    automaticDownloads: state.automatic_downloads,
    allowCloudWorkloads: state.allow_cloud_workloads,
    gpuUtilizationPercent: String(state.policy.gpu_utilization_percent),
    gpuVramPercent: String(state.policy.gpu_vram_percent),
    maxDiskGiB: String(state.policy.max_disk_bytes / BYTES_PER_GIB),
    modelStoragePath: state.policy.model_storage_path,
    maxDownloadGiBPerDay: String(
      state.policy.max_download_bytes_per_day / BYTES_PER_GIB,
    ),
    minimumModelResidencySeconds: String(
      state.policy.minimum_model_residency_seconds,
    ),
    maxModelChangesPerDay: String(state.policy.max_model_changes_per_day),
    reserveFreeDiskGiB: String(
      state.policy.reserve_free_disk_bytes / BYTES_PER_GIB,
    ),
  };
}

function boundedIntegerInput(
  input: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const value = Number(input);
  return /^\d+$/.test(input.trim()) && Number.isSafeInteger(value) &&
    value >= minimum && value <= maximum
    ? value
    : null;
}

function gibInputToBytes(input: string, minimum: number) {
  const gib = Number(input);
  if (input.trim() === "" || !Number.isFinite(gib) || gib < 0) return null;
  const bytes = Math.round(gib * BYTES_PER_GIB);
  return Number.isSafeInteger(bytes) && bytes >= minimum ? bytes : null;
}

function capacityPolicyStateFromDraft(
  draft: ProviderCapacityPolicyDraft,
  revision: number,
): ProviderCapacityPolicyState | null {
  const gpuUtilizationPercent = boundedIntegerInput(
    draft.gpuUtilizationPercent,
    1,
    100,
  );
  const gpuVramPercent = boundedIntegerInput(draft.gpuVramPercent, 1, 100);
  const maxDiskBytes = gibInputToBytes(draft.maxDiskGiB, 1);
  const maxDownloadBytesPerDay = gibInputToBytes(
    draft.maxDownloadGiBPerDay,
    0,
  );
  const minimumModelResidencySeconds = boundedIntegerInput(
    draft.minimumModelResidencySeconds,
    1,
  );
  const maxModelChangesPerDay = boundedIntegerInput(
    draft.maxModelChangesPerDay,
    0,
    4_294_967_295,
  );
  const reserveFreeDiskBytes = gibInputToBytes(draft.reserveFreeDiskGiB, 1);
  const modelStoragePath = draft.modelStoragePath.trim();
  if (
    gpuUtilizationPercent === null ||
    gpuVramPercent === null ||
    maxDiskBytes === null ||
    maxDownloadBytesPerDay === null ||
    minimumModelResidencySeconds === null ||
    maxModelChangesPerDay === null ||
    reserveFreeDiskBytes === null ||
    !modelStoragePath.startsWith("/") ||
    modelStoragePath === "/" ||
    /[\0\r\n]/u.test(modelStoragePath)
  ) {
    return null;
  }
  return {
    schema_version: "provider-capacity-policy-state-v1",
    revision,
    paused: draft.paused,
    automatic_downloads: draft.automaticDownloads,
    allow_cloud_workloads: draft.allowCloudWorkloads,
    policy: {
      schema_version: "provider-capacity-policy-v1",
      gpu_utilization_percent: gpuUtilizationPercent,
      gpu_vram_percent: gpuVramPercent,
      max_disk_bytes: maxDiskBytes,
      model_storage_path: modelStoragePath,
      max_download_bytes_per_day: maxDownloadBytesPerDay,
      minimum_model_residency_seconds: minimumModelResidencySeconds,
      max_model_changes_per_day: maxModelChangesPerDay,
      reserve_free_disk_bytes: reserveFreeDiskBytes,
    },
  };
}

function isOAuthProvider(provider: AccountProvider) {
  return provider === "openai" || provider === "xai";
}

function isManualTokenProvider(provider: AccountProvider) {
  return provider === "ai-sdk" || provider === "mistral" || provider === "openai-compatible" || provider === "opencode" || provider === "zai";
}

function oauthProviderLabel(provider: "openai" | "opencode" | "xai") {
  if (provider === "opencode") return "OpenCode";
  if (provider === "xai") return "Grok Build";
  return "OpenAI";
}

function isOpenAiAccount(account: Account) {
  // OpenAI was the only provider before provider was persisted, so legacy
  // account records correctly default to OpenAI on the server as well.
  return (account.provider ?? "openai") === "openai";
}

function shouldDisplayOptionalQuotaWindow(
  account: Account,
  window: "primary" | "secondary" | "monthly",
) {
  // Keep the placeholder visible before the first usage refresh and preserve
  // the N/A state when the provider does not expose quota details. Once a
  // supported snapshot exists, an absent window means it does not apply.
  return (
    !account.usage ||
    account.usage.quotaStatus === "unsupported" ||
    account.usage.quotaStatus === "error" ||
    Boolean(account.usage[window])
  );
}

function activeModelBlocks(account: Account) {
  return Object.entries(account.state?.modelBlocks ?? {}).filter(
    ([, block]) => block.until > Date.now(),
  );
}

const dialogFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function usageAgeLabel(fetchedAt: number) {
  const ageMs = Math.max(0, Date.now() - fetchedAt);
  if (ageMs < 60_000) return "just now";
  const ageMinutes = Math.floor(ageMs / 60_000);
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  return `${ageHours}h ago`;
}

function usageStatusLabel(account: Account, usageCacheTtlMs: number) {
  if (!account.usage) return "Usage not checked";
  if (account.usage.quotaStatus === "unsupported") return "Usage not exposed";
  if (account.usage.quotaStatus === "error") return "Usage refresh failed";
  if (
    typeof account.usage.fetchedAt === "number" &&
    Date.now() - account.usage.fetchedAt >= usageCacheTtlMs
  ) {
    return "Refresh pending";
  }
  const primary = account.usage.primary?.usedPercent;
  const secondary = account.usage.secondary?.usedPercent;
  if (primary === 0 && secondary === 0) return "No usage reported";
  return "Usage checked";
}

function usageSummaryLabel(account: Account, usageCacheTtlMs: number) {
  const status = usageStatusLabel(account, usageCacheTtlMs);
  const fetchedAt = account.usage?.fetchedAt;
  return typeof fetchedAt === "number" && Number.isFinite(fetchedAt)
    ? `${status} · ${usageAgeLabel(fetchedAt)}`
    : status;
}

export function AccountsTab(props: Props) {
  const {
    traceStats,
    accounts,
    localWorker,
    multivibeCloud,
    usageCacheTtlMs,
    settings,
    sanitized,
    patch,
    del,
    unblock,
    refreshUsage,
    consumeRateLimitResetCredit,
    scheduleRateLimitResetCredit,
    cancelScheduledRateLimitResetCredit,
    createAccount,
    importGrokAuth,
    patchSettings,
    onConnectCloud,
    onDisconnectCloud,
    startOAuth,
    pollDeviceOAuth,
    completeOAuth,
    oauthRedirectUri,
    providerSetupRequest,
    onboardingProviderSetup = false,
    onProviderSetupClosed,
    onSkipOnboarding,
  } = props;
  const [resetCredits, setResetCredits] = useState<Record<string, number | undefined>>({});
  const [resetCreditRefresh, setResetCreditRefresh] = useState(0);
  const resetCreditAccounts = JSON.stringify(
    accounts.filter(isOpenAiAccount).map((account) => [account.id, account.usage?.fetchedAt]),
  );

  useEffect(() => {
    const controller = new AbortController();
    const entries = JSON.parse(resetCreditAccounts) as [string, number | null][];
    for (const [id] of entries) {
      void api(`/admin/accounts/${encodeURIComponent(id)}/rate-limit-reset-credit`, {
        signal: controller.signal,
      }).then((result) => {
        if (!controller.signal.aborted) {
          const count = findAvailableCount(result?.credit);
          setResetCredits((current) => current[id] === count ? current : { ...current, [id]: count });
        }
      }).catch(() => {
        if (!controller.signal.aborted) {
          setResetCredits((current) => current[id] === undefined ? current : { ...current, [id]: undefined });
        }
      });
    }
    return () => controller.abort();
  }, [resetCreditAccounts, resetCreditRefresh]);

  const [showAddAccount, setShowAddAccount] = useState(false);
  const [providerStep, setProviderStep] = useState(0);
  const [providerError, setProviderError] = useState("");
  const providerModalRef = useRef<HTMLDivElement>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [quotaResetForecast, setQuotaResetForecast] =
    useState<QuotaResetForecast | null>(null);
  const [quotaResetForecastStatus, setQuotaResetForecastStatus] =
    useState<QuotaResetForecastStatus>("idle");

  const connectCloud = async () => {
    setCloudBusy(true);
    setCloudError("");
    try {
      await onConnectCloud();
    } catch (error: any) {
      setCloudError(error?.message ?? "Could not connect to MultiVibe Cloud.");
    } finally {
      setCloudBusy(false);
    }
  };
  const disconnectCloud = async () => {
    setCloudBusy(true);
    setCloudError("");
    try {
      await onDisconnectCloud();
    } catch (error: any) {
      setCloudError(error?.message ?? "Could not disconnect from MultiVibe Cloud.");
    } finally {
      setCloudBusy(false);
    }
  };
  const [provider, setProvider] = useState<AccountProvider>("openai");
  const [sdkProviders, setSdkProviders] = useState<Array<{id: string; name: string; models: Array<{id: string; name: string}>}>>([]);
  const [sdkProvider, setSdkProvider] = useState("anthropic");
  const [sdkModels, setSdkModels] = useState("");
  const [sdkCatalogError, setSdkCatalogError] = useState("");
  useEffect(() => {
    let active = true;
    void api("/admin/provider-catalog").then((catalog) => {
      if (active) setSdkProviders(catalog.providers);
    }).catch(() => { if (active) setSdkCatalogError("Provider list could not be loaded. Reload to try again."); });
    return () => { active = false; };
  }, []);
  const [manualEmail, setManualEmail] = useState("");
  const [manualAccessToken, setManualAccessToken] = useState("");
  const [manualRefreshToken, setManualRefreshToken] = useState("");
  const [manualChatgptAccountId, setManualChatgptAccountId] = useState("");
  const [manualBaseUrl, setManualBaseUrl] = useState("");
  const [manualUpstreamMode, setManualUpstreamMode] = useState<
    "" | "responses" | "chat/completions"
  >("");
  const [manualOAuthMethod, setManualOAuthMethod] =
    useState<OAuthMethod>("browser");
  const [editOAuthMethod, setEditOAuthMethod] =
    useState<OAuthMethod>("browser");
  const [manualPriority, setManualPriority] = useState("0");
  const [manualEnabled, setManualEnabled] = useState(true);
  const [manualLocation, setManualLocation] = useState<"" | "local" | "personal-cluster" | "cloud">("");
  const [manualMaxConcurrent, setManualMaxConcurrent] = useState("");
  const [manualPrefill, setManualPrefill] = useState("");
  const [manualDecode, setManualDecode] = useState("");
  const [manualContext, setManualContext] = useState("");
  const [manualHealthUrl, setManualHealthUrl] = useState("");
  const [manualMetricsUrl, setManualMetricsUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EditAccountState | null>(
    null,
  );
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);
  const [oauthDialog, setOauthDialog] = useState<OAuthDialogState | null>(null);
  const devicePollInFlight = useRef(false);
  const [openMenu, setOpenMenu] = useState<OpenAccountMenu | null>(null);
  const accountActionMenuRef = useRef<HTMLDivElement | null>(null);
  const accountActionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [workerSetupOpen, setWorkerSetupOpen] = useState(false);
  const [providerPreviewStatus, setProviderPreviewStatus] =
    useState<ProviderPreviewStatus>("idle");
  const [providerSelection, setProviderSelection] =
    useState<ProviderAgentSelection | null>(null);
  const [providerSelectionDraft, setProviderSelectionDraft] = useState<string[]>([]);
  const [providerDetectedModels, setProviderDetectedModels] =
    useState<ProviderAgentDetectedModels | null>(null);
  const [providerAdapterRegistry, setProviderAdapterRegistry] =
    useState<ProviderAgentAdapterRegistry | null>(null);
  const [providerRuntimeEndpoints, setProviderRuntimeEndpoints] =
    useState<ProviderAgentRuntimeEndpoints | null>(null);
  const [providerRuntimeDrafts, setProviderRuntimeDrafts] =
    useState<ProviderRuntimeEndpointDraft[]>([]);
  const [providerRuntimeAdapterToAdd, setProviderRuntimeAdapterToAdd] = useState("");
  const [providerRuntimeSaving, setProviderRuntimeSaving] = useState(false);
  const [providerRuntimeMessage, setProviderRuntimeMessage] = useState("");
  const [providerPreviewMessage, setProviderPreviewMessage] = useState("");
  const [providerCapacityPolicy, setProviderCapacityPolicy] =
    useState<ProviderCapacityPolicyState | null>(null);
  const [providerCapacityDraft, setProviderCapacityDraft] =
    useState<ProviderCapacityPolicyDraft>(defaultProviderCapacityPolicyDraft);
  const [providerCapacityStatus, setProviderCapacityStatus] =
    useState<ProviderCapacityStatus>("idle");
  const [providerCapacityMessage, setProviderCapacityMessage] = useState("");
  const workerSetupDialogRef = useRef<HTMLDivElement | null>(null);
  const workerSetupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workerSetupCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!providerSetupRequest) return;
    const target = props.modelSetupTarget;
    const existing = target?.accountId ? accounts.find(account => account.id === target.accountId) : undefined;
    if (existing) openEditModal(existing);
    else {
      if (target?.provider) {
        setProvider(target.provider);
        if (target.sdkProvider) {
          setSdkProvider(target.sdkProvider);
          setSdkModels(target.modelId.slice(target.sdkProvider.length + 1));
        }
        setProviderStep(1);
      }
      setShowAddAccount(true);
    }
    props.onModelSetupConsumed?.();
  }, [providerSetupRequest]);

  useEffect(() => {
    const closeMenu = () => setOpenMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        closeMenu();
        return;
      }
      if (target.closest(".icon-menu-btn")) return;
      if (target.closest(".account-action-menu")) return;
      closeMenu();
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".account-action-menu")
      ) {
        return;
      }
      closeMenu();
    };
    const onResize = () => closeMenu();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    const stopObservingVisualViewport = observeFloatingViewportChanges(
      window.visualViewport,
      closeMenu,
    );
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      stopObservingVisualViewport();
    };
  }, []);

  useLayoutEffect(() => {
    const menu = accountActionMenuRef.current;
    if (!openMenu || !menu) return;

    const placement = placeFloatingMenu(
      openMenu.anchor,
      { width: menu.offsetWidth, height: menu.scrollHeight },
      currentFloatingViewport(),
    );
    setOpenMenu((current) => {
      if (!current || current.accountId !== openMenu.accountId) return current;
      const previous = current.placement;
      if (
        previous.top === placement.top &&
        previous.left === placement.left &&
        previous.maxHeight === placement.maxHeight &&
        previous.maxWidth === placement.maxWidth &&
        previous.side === placement.side
      ) {
        return current;
      }
      return { ...current, placement };
    });
  }, [
    openMenu?.accountId,
    openMenu?.anchor.top,
    openMenu?.anchor.bottom,
    openMenu?.anchor.right,
  ]);

  useEffect(() => {
    if (!openMenu) return;
    const focusFrame = window.requestAnimationFrame(() => {
      accountActionMenuRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenMenu(null);
      accountActionTriggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu?.accountId]);

  useEffect(() => {
    if (!workerSetupOpen) return;

    let cancelled = false;
    setProviderPreviewStatus("loading");
    setProviderPreviewMessage("");
    setProviderSelection(null);
    setProviderDetectedModels(null);
    setProviderAdapterRegistry(null);
    setProviderRuntimeEndpoints(null);
    setProviderRuntimeDrafts([]);
    setProviderRuntimeMessage("");
    setProviderCapacityPolicy(null);
    setProviderCapacityDraft(defaultProviderCapacityPolicyDraft());
    setProviderCapacityStatus("loading");
    setProviderCapacityMessage("");

    void Promise.all([
      api("/admin/provider-agent/selection"),
      api("/admin/provider-agent/detected-models"),
      api("/admin/provider-agent/adapters"),
      api("/admin/provider-agent/runtime-endpoints"),
    ]).then(([selection, detected, adapters, runtimeEndpoints]) => {
      if (cancelled) return;
      const nextSelection = selection as ProviderAgentSelection;
      const nextRuntimeEndpoints = runtimeEndpoints as ProviderAgentRuntimeEndpoints;
      setProviderSelection(nextSelection);
      setProviderSelectionDraft([...nextSelection.selected_models].sort());
      setProviderDetectedModels(detected as ProviderAgentDetectedModels);
      setProviderAdapterRegistry(adapters as ProviderAgentAdapterRegistry);
      setProviderRuntimeEndpoints(nextRuntimeEndpoints);
      setProviderRuntimeDrafts(nextRuntimeEndpoints.endpoints.map((endpoint) => ({
        adapterId: endpoint.adapter_id,
        endpoint: endpoint.endpoint,
        bearerToken: "",
        existingAuthentication: endpoint.authentication,
        clearBearer: false,
      })));
      setProviderPreviewStatus("ready");
    }).catch((error: unknown) => {
      if (cancelled) return;
      setProviderPreviewStatus(error instanceof ApiError && error.status === 503 ? "unavailable" : "error");
      setProviderPreviewMessage(
        error instanceof ApiError && error.status === 503
          ? "The embedded provider agent is not available in this Core installation."
          : "The bounded local inventory could not be loaded.",
      );
    });

    void api("/admin/provider-agent/capacity-policy").then((policy) => {
      if (cancelled) return;
      const nextPolicy = policy as ProviderCapacityPolicyState;
      setProviderCapacityPolicy(nextPolicy);
      setProviderCapacityDraft(capacityPolicyDraftFromState(nextPolicy));
      setProviderCapacityStatus("ready");
    }).catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof ApiError && error.status === 404) {
        setProviderCapacityPolicy(null);
        setProviderCapacityDraft(defaultProviderCapacityPolicyDraft());
        setProviderCapacityStatus("ready");
        setProviderCapacityMessage(
          "Defaults are ready. Save them or customize Advanced settings.",
        );
        return;
      }
      setProviderCapacityStatus(
        error instanceof ApiError && error.status === 503
          ? "unavailable"
          : "error",
      );
      setProviderCapacityMessage(
        error instanceof ApiError && error.status === 503
          ? "The local capacity policy service is unavailable."
          : "The local capacity policy could not be loaded.",
      );
    });

    return () => {
      cancelled = true;
    };
  }, [workerSetupOpen]);

  useEffect(() => {
    if (!workerSetupOpen) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      workerSetupCloseRef.current?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setWorkerSetupOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = workerSetupDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector),
      );
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      window.requestAnimationFrame(() => {
        const focusTarget = workerSetupTriggerRef.current ?? previouslyFocused;
        if (focusTarget?.isConnected) focusTarget.focus();
      });
    };
  }, [workerSetupOpen]);

  const toggleProviderSelection = (model: string) => {
    setProviderSelectionDraft((current) =>
      current.includes(model)
        ? current.filter((value) => value !== model)
        : [...current, model].sort(),
    );
    setProviderPreviewMessage("");
  };

  const updateProviderCapacityDraft = <
    Key extends keyof ProviderCapacityPolicyDraft,
  >(
    key: Key,
    value: ProviderCapacityPolicyDraft[Key],
  ) => {
    setProviderCapacityDraft((current) => ({ ...current, [key]: value }));
    setProviderCapacityMessage("");
  };

  const saveProviderSelection = async () => {
    if (!providerSelection || providerPreviewStatus === "saving") return;
    setProviderPreviewStatus("saving");
    setProviderPreviewMessage("");
    try {
      const next = await api("/admin/provider-agent/selection", {
        method: "PUT",
        body: JSON.stringify({
          revision: providerSelection.revision,
          selected_models: providerSelectionDraft,
        }),
      }) as ProviderAgentSelection;
      setProviderSelection(next);
      setProviderSelectionDraft([...next.selected_models].sort());
      setProviderPreviewStatus("ready");
      setProviderPreviewMessage(
        next.selected_models.length
          ? "Local selection saved. Nothing was submitted to MultiVibe Cloud."
          : "Local selection cleared. Nothing was submitted to MultiVibe Cloud.",
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await api("/admin/provider-agent/selection") as ProviderAgentSelection;
          setProviderSelection(latest);
          setProviderSelectionDraft([...latest.selected_models].sort());
          setProviderPreviewStatus("ready");
          setProviderPreviewMessage("The selection changed in another session. The latest local revision is shown; review it before saving again.");
          return;
        } catch {
          // Fall through to the bounded unavailable state below.
        }
      }
      setProviderPreviewStatus(error instanceof ApiError && error.status === 503 ? "unavailable" : "error");
      setProviderPreviewMessage(
        error instanceof ApiError && error.status === 400
          ? "The local selection contains an invalid model identifier."
          : "The local selection could not be saved.",
      );
    }
  };

  const saveProviderRuntimeEndpoints = async () => {
    if (!providerRuntimeEndpoints || providerRuntimeSaving) return;
    setProviderRuntimeSaving(true);
    setProviderRuntimeMessage("");
    try {
      const next = await api("/admin/provider-agent/runtime-endpoints", {
        method: "PUT",
        body: JSON.stringify({
          revision: providerRuntimeEndpoints.revision,
          endpoints: providerRuntimeDrafts.map((draft) => ({
            adapter_id: draft.adapterId,
            endpoint: draft.endpoint,
            ...(draft.clearBearer
              ? { bearer_token: "" }
              : draft.bearerToken
                ? { bearer_token: draft.bearerToken }
                : {}),
          })),
        }),
      }) as ProviderAgentRuntimeEndpoints;
      const detected = await api("/admin/provider-agent/detected-models") as ProviderAgentDetectedModels;
      setProviderRuntimeEndpoints(next);
      setProviderRuntimeDrafts(next.endpoints.map((endpoint) => ({
        adapterId: endpoint.adapter_id,
        endpoint: endpoint.endpoint,
        bearerToken: "",
        existingAuthentication: endpoint.authentication,
        clearBearer: false,
      })));
      setProviderDetectedModels(detected);
      setProviderRuntimeMessage(
        "Local runtime endpoints saved and detection refreshed. Nothing was submitted to MultiVibe Cloud.",
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await api("/admin/provider-agent/runtime-endpoints") as ProviderAgentRuntimeEndpoints;
          setProviderRuntimeEndpoints(latest);
          setProviderRuntimeDrafts(latest.endpoints.map((endpoint) => ({
            adapterId: endpoint.adapter_id,
            endpoint: endpoint.endpoint,
            bearerToken: "",
            existingAuthentication: endpoint.authentication,
            clearBearer: false,
          })));
          setProviderRuntimeMessage(
            "Runtime endpoints changed in another session. The latest local revision is shown; review it before saving again.",
          );
          return;
        } catch {
          // Fall through to the local error state below.
        }
      }
      setProviderRuntimeMessage(
        error instanceof ApiError && error.status === 400
          ? "Use one unique adapter per entry and a literal http://127.0.0.1:port or http://[::1]:port endpoint."
          : "The local runtime endpoints could not be saved.",
      );
    } finally {
      setProviderRuntimeSaving(false);
    }
  };

  const saveProviderCapacityPolicy = async () => {
    if (providerCapacityStatus === "saving") return;
    const input = capacityPolicyStateFromDraft(
      providerCapacityDraft,
      providerCapacityPolicy?.revision ?? 0,
    );
    if (!input) {
      setProviderCapacityMessage(
        "Fill in every limit with valid values and an absolute model folder.",
      );
      return;
    }

    setProviderCapacityStatus("saving");
    setProviderCapacityMessage("");
    try {
      const next = await api("/admin/provider-agent/capacity-policy", {
        method: "PUT",
        body: JSON.stringify(input),
      }) as ProviderCapacityPolicyState;
      setProviderCapacityPolicy(next);
      setProviderCapacityDraft(capacityPolicyDraftFromState(next));
      setProviderCapacityStatus("ready");
      setProviderCapacityMessage(
        next.paused
          ? "Limits saved. Sharing is paused."
          : next.allow_cloud_workloads
            ? "Limits saved. Cloud jobs are allowed."
            : "Limits saved. Cloud jobs are off.",
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await api(
            "/admin/provider-agent/capacity-policy",
          ) as ProviderCapacityPolicyState;
          setProviderCapacityPolicy(latest);
          setProviderCapacityDraft(capacityPolicyDraftFromState(latest));
          setProviderCapacityStatus("ready");
          setProviderCapacityMessage(
            "These limits changed elsewhere. Review and save again.",
          );
          return;
        } catch {
          // Fall through to the local unavailable state below.
        }
      }
      setProviderCapacityStatus(
        error instanceof ApiError && error.status === 400
          ? "ready"
          : error instanceof ApiError && error.status === 503
            ? "unavailable"
            : "error",
      );
      setProviderCapacityMessage(
        error instanceof ApiError && error.status === 400
          ? "The agent rejected this policy. Check the percentages, integer limits and absolute storage path."
          : "The local capacity policy could not be saved.",
      );
    }
  };

  useEffect(() => {
    if (!oauthDialog) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if ((data as { type?: string }).type !== "multivibe-oauth-callback")
        return;
      const callbackUrl = (data as { callbackUrl?: string }).callbackUrl;
      if (typeof callbackUrl !== "string" || !callbackUrl.trim()) return;

      try {
        const received = new URL(callbackUrl);
        const expected = new URL(oauthDialog.expectedRedirectUri);
        if (
          received.origin !== expected.origin ||
          received.pathname !== expected.pathname
        ) {
          return;
        }
      } catch {
        return;
      }

      setOauthDialog((current) =>
        current ? { ...current, callbackInput: callbackUrl.trim() } : current,
      );
      void submitOauthCallback(callbackUrl.trim());
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [oauthDialog]);

  useEffect(() => {
    if (!oauthDialog || oauthDialog.method !== "device") return;

    let cancelled = false;
    const delayMs = Math.max(1, oauthDialog.intervalSeconds ?? 5) * 1000;
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      if (devicePollInFlight.current) return;
      devicePollInFlight.current = true;
      try {
        console.log("[oauth-device] polling approval", {
          flowId: oauthDialog.flowId,
          intervalSeconds: oauthDialog.intervalSeconds ?? 5,
        });
        const result = await pollDeviceOAuth(oauthDialog.flowId);
        console.log("[oauth-device] poll result", {
          flowId: oauthDialog.flowId,
          status: result?.status,
          hasAccount: Boolean(result?.account),
        });
        if (cancelled) return;
        if (result?.status === "success") {
          const accountId = String(
            result?.account?.id ?? oauthDialog.accountId ?? "",
          ).trim();
          if (
            oauthDialog.mode === "create" &&
            accountId &&
            (oauthDialog.pendingPriority !== 0 ||
              oauthDialog.pendingEnabled === false)
          ) {
            await patch(accountId, {
              priority: oauthDialog.pendingPriority ?? 0,
              enabled: oauthDialog.pendingEnabled ?? true,
            });
          }
          closeOauthDialog();
          closeModal();
        } else {
          setOauthDialog((current) =>
            current
              ? {
                  ...current,
                  isSubmitting: false,
                  intervalSeconds:
                    Number(result?.intervalSeconds) ||
                    current.intervalSeconds ||
                    5,
                }
              : current,
          );
        }
      } catch (err) {
        console.error("[oauth-device] poll failed", {
          flowId: oauthDialog.flowId,
          error: err,
        });
        if (!cancelled) {
          setOauthDialog((current) =>
            current ? { ...current, isSubmitting: false } : current,
          );
        }
      } finally {
        devicePollInFlight.current = false;
      }
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [oauthDialog, pollDeviceOAuth, patch]);

  const selectProvider = useCallback((next: SetupProvider, nextSdk?: string) => {
    if (next === provider && (next !== "ai-sdk" || nextSdk === sdkProvider)) return;
    setProvider(next);
    if (nextSdk) setSdkProvider(nextSdk);
    setSdkModels("");
    setManualAccessToken("");
    setManualRefreshToken("");
    setManualBaseUrl("");
    setManualOAuthMethod(next === "xai" ? "device" : "browser");
    setProviderError("");
  }, [provider, sdkProvider]);
  const selectedProviderName = provider === "ai-sdk"
    ? sdkProviders.find((item) => item.id === sdkProvider)?.name
    : SETUP_PROVIDERS.find((item) => item.id === provider)?.name;

  const providerConnectionReady = isOAuthProvider(provider)
    ? provider !== "openai" || Boolean(manualEmail.trim())
    : (provider === "nvidia-pair" || provider === "opencode" || Boolean(manualAccessToken.trim())) &&
      (!(provider === "openai-compatible" || provider === "nvidia-pair") || Boolean(manualBaseUrl.trim())) &&
      (provider !== "ai-sdk" || sdkProviders.some((entry) => entry.id === sdkProvider));

  useEffect(() => {
    if (!showAddAccount || oauthDialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    providerModalRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [showAddAccount, Boolean(oauthDialog)]);

  useEffect(() => {
    if (showAddAccount && !oauthDialog) providerModalRef.current?.focus();
  }, [providerStep]);

  const closeModal = () => {
    setShowAddAccount(false);
    setProviderStep(0);
    setProviderError("");
    setProvider("openai");
    setSdkProvider("anthropic");
    setSdkModels("");
    setManualEmail("");
    setManualAccessToken("");
    setManualRefreshToken("");
    setManualChatgptAccountId("");
    setManualBaseUrl("");
    setManualUpstreamMode("");
    setManualOAuthMethod("browser");
    setManualPriority("0");
    setManualEnabled(true);
    setManualLocation("");
    setManualMaxConcurrent("");
    setManualPrefill("");
    setManualDecode("");
    setManualContext("");
    setManualHealthUrl("");
    setManualMetricsUrl("");
    setIsSubmitting(false);
    sessionStorage.removeItem("multivibe-oauth-pending");
    onProviderSetupClosed?.();
  };

  const closeEditModal = () => {
    setEditingAccount(null);
    setEditOAuthMethod("browser");
    setIsSavingEdit(false);
  };

  const closeOauthDialog = () => {
    setOauthDialog(null);
    sessionStorage.removeItem("multivibe-oauth-pending");
  };

  const openOAuthDialog = async (options: {
    email: string;
    method: OAuthMethod;
    provider: "openai" | "opencode" | "xai";
    mode: "create" | "reauth";
    accountId?: string;
    pendingPriority?: number;
    pendingEnabled?: boolean;
  }) => {
    const result = await startOAuth(
      options.email,
      options.accountId,
      options.method,
      options.provider,
    );
    const flowId = result?.flowId as string | undefined;
    if (!flowId) throw new Error("Missing OAuth flow details from start response");

    const authorizeUrl = String(result?.authorizeUrl ?? "");
    const expectedRedirectUri =
      (result?.expectedRedirectUri as string | undefined) || oauthRedirectUri;
    const verificationUrl = String(result?.verificationUrl ?? "");
    const userCode = String(result?.userCode ?? "");

    if (options.method === "browser" && !authorizeUrl) {
      throw new Error("Missing browser OAuth authorize URL from start response");
    }
    if (options.method === "device" && (!verificationUrl || !userCode)) {
      throw new Error("Missing device code details from start response");
    }

    setOauthDialog({
      flowId,
      email: options.email,
      authorizeUrl,
      expectedRedirectUri,
      method: options.method,
      userCode,
      verificationUrl,
      intervalSeconds: Number(result?.intervalSeconds) || 5,
      expiresAt: Number(result?.expiresAt) || undefined,
      callbackInput: "",
      isSubmitting: false,
      mode: options.mode,
      accountId: options.accountId,
      pendingPriority: options.pendingPriority,
      pendingEnabled: options.pendingEnabled,
      provider: options.provider,
    });
    sessionStorage.setItem(
      "multivibe-oauth-pending",
      JSON.stringify({
        flowId,
        mode: options.mode,
        method: options.method,
        accountId: options.accountId,
        pendingPriority: options.pendingPriority,
        pendingEnabled: options.pendingEnabled,
        provider: options.provider,
        timestamp: Date.now(),
      }),
    );
    if (options.method === "browser") {
      window.open(authorizeUrl, "_blank", "noreferrer");
    } else {
      window.open(verificationUrl, "_blank", "noreferrer");
    }
  };

  const submitManualAccount = async () => {
    if (isOAuthProvider(provider)) {
      if (provider === "openai" && !manualEmail.trim()) return;
      setIsSubmitting(true);
      try {
        await openOAuthDialog({
          email: manualEmail.trim(),
          method: provider === "xai" ? "device" : manualOAuthMethod,
          provider,
          mode: "create",
          pendingPriority: Number(manualPriority) || 0,
          pendingEnabled: manualEnabled,
        });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (provider !== "nvidia-pair" && !manualAccessToken.trim()) return;
    if ((provider === "openai-compatible" || provider === "nvidia-pair") && !manualBaseUrl.trim()) return;
    setIsSubmitting(true);
    try {
      await createAccount({
        provider,
        sdkProvider: provider === "ai-sdk" ? sdkProvider : undefined,
        sdkModels: provider === "ai-sdk" ? sdkModels.split(/[\n,]+/).map((id) => id.trim()).filter(Boolean) : undefined,
        email: manualEmail.trim() || undefined,
        accessToken: provider === "nvidia-pair" ? undefined : manualAccessToken.trim(),
        refreshToken: manualRefreshToken.trim() || undefined,
        baseUrl:
          provider === "openai-compatible" || provider === "nvidia-pair" ? manualBaseUrl.trim() : undefined,
        upstreamMode: manualUpstreamMode || undefined,
        priority: Number(manualPriority) || 0,
        enabled: manualEnabled,
        location: manualLocation || undefined,
        capacityProfile: {
          maxConcurrent: manualMaxConcurrent ? Number(manualMaxConcurrent) : undefined,
          prefillTokensPerSecond: manualPrefill ? Number(manualPrefill) : undefined,
          decodeTokensPerSecond: manualDecode ? Number(manualDecode) : undefined,
          contextWindow: manualContext ? Number(manualContext) : undefined,
          healthUrl: manualHealthUrl.trim() || undefined,
          metricsUrl: manualMetricsUrl.trim() || undefined,
        },
      });
      closeModal();
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (account: Account) => {
    setOpenMenu(null);
    const nextProvider: AccountProvider =
      account.provider === "ai-sdk" ? "ai-sdk" :
      account.provider === "mistral"
        ? "mistral"
        : account.provider === "zai"
          ? "zai"
        : account.provider === "opencode"
          ? "opencode"
        : account.provider === "xai"
          ? "xai"
        : account.provider === "openai-compatible"
          ? "openai-compatible"
          : "openai";
    setEditingAccount({
      id: account.id,
      provider: nextProvider,
      upstreamMode: account.upstreamMode ?? "",
      email: account.email ?? "",
      accessToken: account.accessToken ?? "",
      refreshToken: account.refreshToken ?? "",
      chatgptAccountId: account.chatgptAccountId ?? "",
      baseUrl: account.baseUrl ?? "",
      priority: String(account.priority ?? 0),
      enabled: account.enabled,
      location: account.location ?? "cloud",
      maxConcurrent: String(account.capacityProfile?.maxConcurrent ?? ""),
      prefillTokensPerSecond: String(account.capacityProfile?.prefillTokensPerSecond ?? ""),
      decodeTokensPerSecond: String(account.capacityProfile?.decodeTokensPerSecond ?? ""),
      contextWindow: String(account.capacityProfile?.contextWindow ?? ""),
      healthUrl: account.capacityProfile?.healthUrl ?? "",
      metricsUrl: account.capacityProfile?.metricsUrl ?? "",
    });
    setEditOAuthMethod(nextProvider === "xai" ? "device" : "browser");
  };

  const saveEditedAccount = async () => {
    if (!editingAccount) return;
    if (isOAuthProvider(editingAccount.provider)) {
      if (
        editingAccount.provider === "openai" &&
        !editingAccount.email.trim()
      ) {
        return;
      }
      setIsSavingEdit(true);
      try {
        closeEditModal();
        await openOAuthDialog({
          email: editingAccount.email.trim(),
          method:
            editingAccount.provider === "xai" ? "device" : editOAuthMethod,
          provider: editingAccount.provider,
          mode: "reauth",
          accountId: editingAccount.id,
        });
      } finally {
        setIsSavingEdit(false);
      }
      return;
    }

    if (!editingAccount.accessToken.trim()) return;
    if (
      editingAccount.provider === "openai-compatible" &&
      !editingAccount.baseUrl.trim()
    )
      return;
    setIsSavingEdit(true);
    try {
      await patch(editingAccount.id, {
        email: editingAccount.email.trim() || undefined,
        accessToken: editingAccount.accessToken.trim(),
        refreshToken: editingAccount.refreshToken.trim() || undefined,
        baseUrl:
          editingAccount.provider === "openai-compatible"
            ? editingAccount.baseUrl.trim()
            : undefined,
        upstreamMode: editingAccount.upstreamMode || undefined,
        priority: Number(editingAccount.priority) || 0,
        enabled: editingAccount.enabled,
        location: editingAccount.location,
        capacityProfile: {
          maxConcurrent: editingAccount.maxConcurrent ? Number(editingAccount.maxConcurrent) : undefined,
          prefillTokensPerSecond: editingAccount.prefillTokensPerSecond ? Number(editingAccount.prefillTokensPerSecond) : undefined,
          decodeTokensPerSecond: editingAccount.decodeTokensPerSecond ? Number(editingAccount.decodeTokensPerSecond) : undefined,
          contextWindow: editingAccount.contextWindow ? Number(editingAccount.contextWindow) : undefined,
          healthUrl: editingAccount.healthUrl.trim() || undefined,
          metricsUrl: editingAccount.metricsUrl.trim() || undefined,
        },
      });
      closeEditModal();
    } finally {
      setIsSavingEdit(false);
    }
  };

  const submitOauthCallback = async (overrideUrl?: string) => {
    const input = overrideUrl?.trim() || oauthDialog?.callbackInput.trim();
    if (!input || !oauthDialog) return;
    setIsSavingEdit(true);
    try {
      setOauthDialog((current) =>
        current ? { ...current, isSubmitting: true } : current,
      );
      const result = await completeOAuth(oauthDialog.flowId, input);
      const accountId = String(
        result?.account?.id ?? oauthDialog.accountId ?? "",
      ).trim();
      if (
        oauthDialog.mode === "create" &&
        accountId &&
        (oauthDialog.pendingPriority !== 0 ||
          oauthDialog.pendingEnabled === false)
      ) {
        await patch(accountId, {
          priority: oauthDialog.pendingPriority ?? 0,
          enabled: oauthDialog.pendingEnabled ?? true,
        });
      }
      closeOauthDialog();
      closeModal();
    } finally {
      setIsSavingEdit(false);
      setOauthDialog((current) =>
        current ? { ...current, isSubmitting: false } : current,
      );
    }
  };

  const reauthAccount = async (account: Account) => {
    setOpenMenu(null);
    if ((account.provider ?? "openai") !== "openai") return;
    if (!account.email?.trim()) {
      window.alert(
        "This OpenAI account has no email, so reauth cannot be started.",
      );
      return;
    }
    setOauthBusyId(account.id);
    try {
        await openOAuthDialog({
          email: account.email.trim(),
          method: "browser",
          provider: "openai",
        mode: "reauth",
        accountId: account.id,
      });
    } finally {
      setOauthBusyId(null);
    }
  };

  const reauthAccountWithDeviceCode = async (account: Account) => {
    setOpenMenu(null);
    if ((account.provider ?? "openai") !== "openai") return;
    if (!account.email?.trim()) {
      window.alert(
        "This OpenAI account has no email, so reauth cannot be started.",
      );
      return;
    }
    setOauthBusyId(account.id);
    try {
        await openOAuthDialog({
          email: account.email.trim(),
          method: "device",
          provider: "openai",
        mode: "reauth",
        accountId: account.id,
      });
    } finally {
      setOauthBusyId(null);
    }
  };

  const reauthOpenCodeAccount = async (account: Account) => {
    setOpenMenu(null);
    if (account.provider !== "opencode") return;
    setOauthBusyId(account.id);
    try {
      await openOAuthDialog({
        email: account.email?.trim() ?? "",
        method: "device",
        provider: "opencode",
        mode: "reauth",
        accountId: account.id,
      });
    } finally {
      setOauthBusyId(null);
    }
  };

  const reauthOAuthAccount = async (account: Account) => {
    const provider = account.provider ?? "openai";
    if (provider === "openai") {
      await reauthAccount(account);
      return;
    }
    if (provider === "opencode") {
      await reauthOpenCodeAccount(account);
      return;
    }
    if (provider !== "xai") return;

    setOpenMenu(null);
    setOauthBusyId(account.id);
    try {
      await openOAuthDialog({
        email: account.email?.trim() ?? "",
        method: "device",
        provider: "xai",
        mode: "reauth",
        accountId: account.id,
      });
    } finally {
      setOauthBusyId(null);
    }
  };

  const openAiCount = accounts.filter(
    (account) => (account.provider ?? "openai") === "openai",
  ).length;

  useEffect(() => {
    let cancelled = false;
    if (openAiCount === 0) {
      setQuotaResetForecast(null);
      setQuotaResetForecastStatus("idle");
      return () => {
        cancelled = true;
      };
    }

    setQuotaResetForecastStatus("loading");
    void api("/admin/quota-reset-forecast")
      .then((result) => {
        if (cancelled) return;
        const rawForecast = result?.forecast;
        const score = Number(rawForecast?.score);
        if (!Number.isFinite(score) || score < 0 || score > 100) {
          throw new Error("Invalid quota reset forecast");
        }
        setQuotaResetForecast({
          score,
          state: typeof rawForecast?.state === "string" ? rawForecast.state : "forecast",
          ...(typeof rawForecast?.horizonHours === "number"
            ? { horizonHours: rawForecast.horizonHours }
            : {}),
        });
        setQuotaResetForecastStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setQuotaResetForecast(null);
        setQuotaResetForecastStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [openAiCount]);

  const openAiCompatibleCount = accounts.filter(
    (account) => account.provider === "openai-compatible" && !account.localRuntime,
  ).length;
  const detectedRuntimeCounts = Array.from(
    accounts.reduce((counts, account) => {
      if (!account.localRuntime?.adapter) return counts;
      counts.set(
        account.localRuntime.adapter,
        (counts.get(account.localRuntime.adapter) ?? 0) + 1,
      );
      return counts;
    }, new Map<string, number>()),
  );
  const openCodeCount = accounts.filter(
    (account) => account.provider === "opencode",
  ).length;
  const mistralCount = accounts.filter(
    (account) => account.provider === "mistral",
  ).length;
  const zaiCount = accounts.filter(
    (account) => account.provider === "zai",
  ).length;
  const xaiCount = accounts.filter(
    (account) => account.provider === "xai",
  ).length;
  const blockedCount = accounts.filter(
    (account) => activeModelBlocks(account).length > 0,
  ).length;
  const enabledCount = accounts.filter((account) => account.enabled).length;
  const usageCheckedCount = accounts.filter((account) => Boolean(account.usage)).length;
  const usageUnsupportedCount = accounts.filter(
    (account) => account.usage?.quotaStatus === "unsupported",
  ).length;
  const usageRefreshPendingCount = accounts.filter(
    (account) =>
      account.usage?.quotaStatus !== "unsupported" &&
      typeof account.usage?.fetchedAt === "number" &&
      Date.now() - account.usage.fetchedAt >= usageCacheTtlMs,
  ).length;
  const hasAnyProvider = accounts.length > 0 || localWorker !== null;

  const renderUsageCell = (
    value?: number,
    resetAt?: number,
    unsupported = false,
    stale = false,
  ) => {
    const safeValue =
      typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
    return (
      <div className="usage-cell">
        <div className="usage-value-row">
          <strong>
            {unsupported
              ? "N/A"
              : typeof value === "number"
                ? `${Math.round(value)}%`
                : "?"}
          </strong>
          <small>{unsupported ? "Not exposed" : `${stale ? "Stale · " : ""}${fmt(resetAt)}`}</small>
        </div>
        <div className="mini-progress">
          <span style={{ width: `${safeValue}%` }} />
        </div>
      </div>
    );
  };

  const detectedProviderModelIds = new Set(
    providerDetectedModels?.runtimes.flatMap((runtime) => runtime.models) ?? [],
  );
  const selectedButNotDetected = providerSelectionDraft.filter(
    (model) => !detectedProviderModelIds.has(model),
  );
  const providerSelectionChanged = Boolean(
    providerSelection &&
    (providerSelection.selected_models.length !== providerSelectionDraft.length ||
      providerSelection.selected_models.some((model, index) => model !== providerSelectionDraft[index])),
  );
  const manuallyConfigurableProviderAdapters =
    providerAdapterRegistry?.adapters.filter(
      (adapter) => adapter.automatic_loopback_candidates.length === 0,
    ) ?? [];
  const availableProviderRuntimeAdapters = manuallyConfigurableProviderAdapters.filter(
    (adapter) => !providerRuntimeDrafts.some((draft) => draft.adapterId === adapter.id),
  );
  const providerRuntimeChanged = Boolean(
    providerRuntimeEndpoints && (
      providerRuntimeEndpoints.endpoints.length !== providerRuntimeDrafts.length ||
      providerRuntimeDrafts.some((draft) => {
        const current = providerRuntimeEndpoints.endpoints.find(
          (endpoint) => endpoint.adapter_id === draft.adapterId,
        );
        return !current || current.endpoint !== draft.endpoint || draft.bearerToken !== "" || draft.clearBearer;
      })
    ),
  );
  const providerCapacityInput = capacityPolicyStateFromDraft(
    providerCapacityDraft,
    providerCapacityPolicy?.revision ?? 0,
  );
  const providerCapacityChanged = Boolean(
    providerCapacityInput &&
    (!providerCapacityPolicy ||
      JSON.stringify(providerCapacityInput) !==
        JSON.stringify(providerCapacityPolicy)),
  );

  return (
    <>
      {hasAnyProvider && (
        <>
      <WidgetGrid storageKey="providers" label="Provider metrics">
        <Metric widgetId="providers"
          title="Providers"
          value={`${accounts.length + (localWorker ? 1 : 0)}`}
          detail={localWorker ? "Configured accounts and local Host worker" : "Total configured providers"}
        />
        <Metric widgetId="enabled"
          title="Enabled"
          value={`${enabledCount}`}
          detail="Available for routing"
          tone="success"
        />
        <Metric widgetId="blocked" required
          title="Blocked"
          value={`${blockedCount}`}
          detail="Need manual review or quota reset"
          tone={blockedCount > 0 ? "warning" : "default"}
        />
        <Metric widgetId="top-model"
          title="Top model"
          value={traceStats.models[0]?.model ?? "-"}
          detail="Highest volume in the selected range"
        />
        {openAiCount > 0 && (
          <Metric widgetId="quota-reset-forecast"
            title="Will Codex reset?"
            value={quotaResetForecastStatus === "ready" && quotaResetForecast
              ? `${Math.round(quotaResetForecast.score)}%` : "—"}
            loading={quotaResetForecastStatus === "loading"}
            detail={quotaResetForecastStatus === "error"
              ? "Forecast unavailable"
              : `Chance of a reset · Unofficial forecast for the next ${quotaResetForecast?.horizonHours ?? 48} hours.`}
            action={{ href: CODEX_QUOTA_RESET_FORECAST_URL, label: "View forecast" }}
          />
        )}
      </WidgetGrid>
        </>
      )}

      <section className={hasAnyProvider ? "panel" : "panel providers-empty-state"}>
        <div className="section-split-header">
          <h2>{accounts.length ? "Connected providers" : "Providers"}</h2>
          <div className="inline wrap">
            {openAiCount > 0 && (
              <span className="badge">{openAiCount} OpenAI</span>
            )}
            {openAiCompatibleCount > 0 && (
              <span className="badge">
                {openAiCompatibleCount} OpenAI-compatible
              </span>
            )}
            {detectedRuntimeCounts.map(([adapter, count]) => (
              <span className="badge" key={adapter}>
                {count} {runtimeIdentityForAdapter(adapter).label}
              </span>
            ))}
            {openCodeCount > 0 && (
              <span className="badge">{openCodeCount} OpenCode</span>
            )}
            {mistralCount > 0 && (
              <span className="badge">{mistralCount} Mistral</span>
            )}
            {zaiCount > 0 && (
              <span className="badge">{zaiCount} z.ai</span>
            )}
            {xaiCount > 0 && (
              <span className="badge">{xaiCount} Grok Build</span>
            )}
            {localWorker && <span className="badge">1 MultiVibe Worker</span>}
            {accounts.length > 0 && <span className="badge">{usageCheckedCount}/{accounts.length} usage checked</span>}
            {usageUnsupportedCount > 0 && (
              <span className="badge">
                {usageUnsupportedCount} usage not exposed
              </span>
            )}
            {usageRefreshPendingCount > 0 && (
              <span className="badge badge-warn">
                {usageRefreshPendingCount} refresh pending
              </span>
            )}
            {hasAnyProvider && <button className="btn" onClick={() => setShowAddAccount(true)}>Add provider</button>}
          </div>
        </div>
        {!accounts.some((account) => account.multivibeCloud) && (
          <article className="local-worker-provider multivibe-cloud-provider" aria-labelledby="multivibe-cloud-provider-title">
            <div className="local-worker-provider-identity">
              <img className="local-worker-provider-icon" src="/assets/brand/multivibe-app-icon.svg" alt="" />
              <div>
                <h3 id="multivibe-cloud-provider-title">MultiVibe Cloud</h3>
                {multivibeCloud.status === "unavailable" && <p className="muted">Unavailable</p>}
                {cloudError && <p className="account-inline-error" role="alert">{cloudError}</p>}
              </div>
            </div>
            <div className="local-worker-provider-actions">
              <button className="btn" onClick={() => void connectCloud()} disabled={cloudBusy || multivibeCloud.status === "unavailable"}>
                {cloudBusy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </article>
        )}
        {localWorker && (
          <article className="local-worker-provider" aria-labelledby="local-worker-provider-title">
            <div className="local-worker-provider-identity">
              <img
                className="local-worker-provider-icon"
                src="/assets/brand/multivibe-app-icon.svg"
                alt=""
              />
              <div>
                <div className="inline wrap">
                  <h3 id="local-worker-provider-title">{localWorker.name}</h3>
                  <span className={localWorker.enrollment_state === "enrolled" ? "badge badge-live" : "badge badge-warn"}>
                    {localWorker.enrollment_state === "enrolled" ? "Enrolled" : "Not enrolled"}
                  </span>
                  <span className={localWorker.capacity_state === "enabled" ? "badge badge-live" : "badge"}>
                    {localWorker.capacity_state === "enabled"
                      ? "Capacity enabled"
                      : localWorker.capacity_state === "paused"
                        ? "Capacity paused"
                        : localWorker.capacity_state === "disabled"
                          ? "Cloud work disabled"
                          : "Capacity not configured"}
                  </span>
                </div>
                <p className="muted">
                  {localWorker.capability.hardware} · {localWorker.capability.accelerator.toUpperCase()} · {Math.round(localWorker.capability.accelerator_memory_bytes / (1024 ** 3))} GiB usable capacity
                </p>
              </div>
            </div>
            <div className="local-worker-provider-actions">
              <button
                ref={workerSetupTriggerRef}
                type="button"
                className="btn secondary"
                aria-haspopup="dialog"
                aria-controls="make-money-preview-dialog"
                onClick={() => setWorkerSetupOpen(true)}
              >
                Configure this worker
              </button>
              <a className="btn" href={localWorker.connect_url} target="_blank" rel="noreferrer">
                {localWorker.enrollment_state === "enrolled"
                  ? "Open worker in MultiVibe Cloud"
                  : "Connect this worker to MultiVibe Cloud"}
              </a>
            </div>
          </article>
        )}
        {!accounts.length && !localWorker ? (
          <div className="empty-state-content">
            <span className="empty-state-icon" aria-hidden="true">+</span>
            <h3>Connect your first provider</h3>
            <p className="muted">Add a hosted account or a local OpenAI-compatible endpoint. MultiVibe will discover its models and make them ready for routing.</p>
            <button className="btn" onClick={() => setShowAddAccount(true)}>Add a provider</button>
          </div>
        ) : accounts.length > 0 ? (
        <div className="provider-list">
          {[...accounts].sort((a, b) => Number(b.multivibeCloud === true) - Number(a.multivibeCloud === true)).map((a) => {
            const modelBlocks = activeModelBlocks(a);
            const isCloud = a.multivibeCloud === true;
            const runtimeIdentity = isCloud
              ? { label: "MultiVibe Cloud", iconUrl: "/assets/brand/multivibe-app-icon.svg" }
              : runtimeIdentityForAccount(a);
            const needsReauthentication =
              a.state?.needsTokenRefresh === true &&
              ["openai", "opencode", "xai"].includes(a.provider ?? "openai");
            return (
              <article
                key={a.id}
                className={`provider-card${needsReauthentication ? " provider-card-needs-reauth" : ""}`}
              >
                {needsReauthentication && (
                  <div
                    className="account-reauth-banner"
                    role="status"
                    aria-label="This account needs to be reconnected"
                  >
                    <span>This account needs to be reconnected</span>
                    <button
                      type="button"
                      className="btn account-reauth-button"
                      disabled={oauthBusyId === a.id}
                      onClick={() => void reauthOAuthAccount(a)}
                    >
                      {oauthBusyId === a.id ? "Opening..." : "Reauth this account"}
                    </button>
                  </div>
                )}
                <div className="provider-card-header">
                  <div className="provider-card-identity">
                    <span className="provider-badge">
                      <img
                        className="provider-icon"
                        src={runtimeIdentity.iconUrl}
                        alt={`${runtimeIdentity.label} icon`}
                        loading="lazy"
                      />
                      {runtimeIdentity.label}
                    </span>
                    {(!isCloud || a.email) && <strong className="provider-card-account-name">
                      {sanitized ? maskEmail(a.email) : (a.email ?? "No email set")}
                    </strong>}
                    <span className={`provider-card-status badge ${a.enabled ? "badge-live" : "badge-warn"}`}>
                      {a.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <span className={`provider-card-location badge${a.location === "local" ? " badge-live" : ""}`}>
                      {a.location ?? "cloud"}
                    </span>
                    {!isCloud && <span className="provider-card-usage mono muted">
                      {usageSummaryLabel(a, usageCacheTtlMs)}
                    </span>}
                  </div>
                  <div className="account-actions-cell">
                      <button
                        className="icon-menu-btn"
                        aria-label={`Open actions for ${a.email ?? a.id}`}
                        aria-expanded={openMenu?.accountId === a.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          accountActionTriggerRef.current = e.currentTarget;
                          setOpenMenu((current) =>
                            current?.accountId === a.id
                              ? null
                              : {
                                  accountId: a.id,
                                  anchor: {
                                    top: rect.top,
                                    bottom: rect.bottom,
                                    right: rect.right,
                                  },
                                  placement: placeFloatingMenu(
                                    {
                                      top: rect.top,
                                      bottom: rect.bottom,
                                      right: rect.right,
                                    },
                                    { width: 220, height: 0 },
                                    currentFloatingViewport(),
                                  ),
                                },
                          );
                        }}
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 18 18"
                          aria-hidden="true"
                        >
                          <circle cx="9" cy="3.5" r="1.5" />
                          <circle cx="9" cy="9" r="1.5" />
                          <circle cx="9" cy="14.5" r="1.5" />
                        </svg>
                      </button>
                      {openMenu?.accountId === a.id &&
                        createPortal(
                          <div
                            ref={accountActionMenuRef}
                            className="account-action-menu"
                            data-placement={openMenu.placement.side}
                            style={{
                              top: openMenu.placement.top,
                              left: openMenu.placement.left,
                              maxHeight: openMenu.placement.maxHeight,
                              maxWidth: openMenu.placement.maxWidth,
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className="account-action-item"
                              onClick={() => openEditModal(a)}
                            >
                              Modify parameters
                            </button>
                            <button
                              className="account-action-item"
                              onClick={() => {
                                setOpenMenu(null);
                                void patch(a.id, { enabled: !a.enabled });
                              }}
                            >
                              {a.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              className="account-action-item"
                              onClick={() => {
                                setOpenMenu(null);
                                void unblock(a.id);
                              }}
                            >
                              Unblock
                            </button>
                            {!isCloud && <button
                              className="account-action-item"
                              onClick={() => {
                                setOpenMenu(null);
                                void refreshUsage(a.id);
                              }}
                            >
                              Refresh usage
                            </button>}
                            {((isOpenAiAccount(a) && a.enabled) ||
                              settings.defaultPassthroughAccountId === a.id) && (
                              <button
                                className="account-action-item"
                                onClick={() => {
                                  setOpenMenu(null);
                                  void patchSettings({
                                    defaultPassthroughAccountId:
                                      settings.defaultPassthroughAccountId === a.id
                                        ? undefined
                                        : a.id,
                                  });
                                }}
                              >
                                {settings.defaultPassthroughAccountId === a.id
                                  ? "Clear default passthrough"
                                  : "Set as default passthrough"}
                              </button>
                            )}
                            {isOpenAiAccount(a) && (
                              <button
                                className="account-action-item"
                                onClick={() => {
                                  setOpenMenu(null);
                                  void consumeRateLimitResetCredit(a.id);
                                }}
                              >
                                Use rate-limit reset credit
                              </button>
                            )}
                            {isOpenAiAccount(a) ? (
                              <>
                                <button
                                  className="account-action-item"
                                  disabled={oauthBusyId === a.id}
                                  onClick={() => void reauthAccount(a)}
                                >
                                  {oauthBusyId === a.id
                                    ? "Opening..."
                                    : "Reauth"}
                                </button>
                                <button
                                  className="account-action-item"
                                  disabled={oauthBusyId === a.id}
                                  onClick={() =>
                                    void reauthAccountWithDeviceCode(a)
                                  }
                                >
                                  Device-code reauth
                                </button>
                              </>
                            ) : !isCloud && (
                              <>
                                <button
                                  className="account-action-item"
                                  onClick={() => openEditModal(a)}
                                >
                                  Change key
                                </button>
                                {a.provider === "opencode" && (
                                  <button
                                    className="account-action-item"
                                    disabled={oauthBusyId === a.id}
                                    onClick={() => void reauthOpenCodeAccount(a)}
                                  >
                                    {oauthBusyId === a.id
                                      ? "Opening..."
                                      : "OpenCode device reauth"}
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              className="account-action-item account-action-item-danger"
                              onClick={() => {
                                setOpenMenu(null);
                                if (isCloud) void disconnectCloud();
                                else void del(a.id);
                              }}
                              disabled={isCloud && cloudBusy}
                            >
                              {isCloud ? "Disconnect" : "Delete"}
                            </button>
                          </div>,
                          document.body,
                        )}
                  </div>
                </div>
                {isCloud ? (
                  <div className="provider-card-content">
                    <div className="cloud-provider-balance">
                      <span className="muted">Available balance</span>
                      <strong>
                        {multivibeCloud.status === "connected" && multivibeCloud.balanceUsd !== undefined
                          ? `${Number(multivibeCloud.balanceUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })} credits`
                          : "Balance unavailable"}
                      </strong>
                      {multivibeCloud.subscription && <span className="muted">{multivibeCloud.subscription}</span>}
                      {multivibeCloud.status === "disconnected" && <span className="muted">Reconnect to refresh your Cloud session.</span>}
                      {cloudError && <p className="account-inline-error" role="alert">{cloudError}</p>}
                    </div>
                    <div className="local-worker-provider-actions">
                      <a className="btn" href={multivibeCloud.topupUrl} target="_blank" rel="noreferrer">
                        Manage plan & add credits
                      </a>
                      {multivibeCloud.status === "disconnected" && (
                        <button className="btn secondary" type="button" onClick={() => void connectCloud()} disabled={cloudBusy}>Reconnect</button>
                      )}
                      <button className="cloud-disconnect-link" type="button" onClick={() => void disconnectCloud()} disabled={cloudBusy}>
                        {cloudBusy ? "Disconnecting…" : "Disconnect"}
                      </button>
                    </div>
                  </div>
                ) : <div className="provider-card-content">
                  <div className="provider-card-details">
                    {(a.baseUrl || a.upstreamMode || (a.provider === "opencode" && a.opencodeOrgName)) && (
                      <div className="provider-card-endpoint">
                        {a.baseUrl && <span className="mono muted">{a.baseUrl}</span>}
                        {a.upstreamMode && <span className="mono muted">upstream: {a.upstreamMode}</span>}
                        {a.provider === "opencode" && a.opencodeOrgName && (
                          <span className="mono muted">organization: {a.opencodeOrgName}</span>
                        )}
                      </div>
                    )}
                    {a.capacityProfile && (
                      <span className="mono muted">
                        capacity: {a.capacityProfile.maxConcurrent ?? "?"} slots · {a.capacityProfile.prefillTokensPerSecond ?? "?"} prefill tok/s · {a.capacityProfile.decodeTokensPerSecond ?? "?"} decode tok/s · {a.capacityProfile.contextWindow ?? "?"} ctx
                      </span>
                    )}
                    {isOpenAiAccount(a) && (
                      <div className="reset-quota-actions">
                        <button
                          className="btn secondary reset-quota-btn"
                          onClick={async () => {
                            await consumeRateLimitResetCredit(a.id);
                            setResetCreditRefresh((current) => current + 1);
                          }}
                        >
                          Reset quota now (available: {resetCredits[a.id] ?? "—"})
                        </button>
                        {a.state?.scheduledWeeklyReset ? (
                          <>
                            <span className="badge badge-live">Auto-reset scheduled at 0.5% remaining</span>
                            {a.state.scheduledWeeklyReset.lastError && (
                              <small className="reset-quota-error">
                                Last attempt failed: {a.state.scheduledWeeklyReset.lastError}
                              </small>
                            )}
                            <button
                              className="btn secondary reset-quota-btn"
                              onClick={() => void cancelScheduledRateLimitResetCredit(a.id)}
                            >
                              Cancel auto-reset
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn secondary reset-quota-btn"
                            onClick={() => void scheduleRateLimitResetCredit(a.id)}
                          >
                            Auto-reset at 0.5% remaining
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="provider-quota-grid" aria-label="Quota usage">
                    {shouldDisplayOptionalQuotaWindow(a, "primary") && (
                      <div className="provider-quota-item">
                        <span className="provider-quota-label">5h quota</span>
                        {renderUsageCell(a.usage?.primary?.usedPercent, a.usage?.primary?.resetAt, a.usage?.quotaStatus === "unsupported", a.usage?.quotaStatus === "error")}
                      </div>
                    )}
                    {shouldDisplayOptionalQuotaWindow(a, "secondary") && (
                      <div className="provider-quota-item">
                        <span className="provider-quota-label">Weekly quota</span>
                        {renderUsageCell(a.usage?.secondary?.usedPercent, a.usage?.secondary?.resetAt, a.usage?.quotaStatus === "unsupported", a.usage?.quotaStatus === "error")}
                      </div>
                    )}
                    {shouldDisplayOptionalQuotaWindow(a, "monthly") && (
                      <div className="provider-quota-item">
                        <span className="provider-quota-label">Monthly quota</span>
                        {renderUsageCell(a.usage?.monthly?.usedPercent, a.usage?.monthly?.resetAt, a.usage?.quotaStatus === "unsupported", a.usage?.quotaStatus === "error")}
                      </div>
                    )}
                    {a.usage?.credits && (
                      <div className="provider-quota-item">
                        <span className="provider-quota-label">Subscription credits</span>
                        {renderUsageCell(a.usage.credits.usedPercent, a.usage.credits.resetAt, false, a.usage.quotaStatus === "error")}
                      </div>
                    )}
                    {a.usage?.tools && (
                      <div className="provider-quota-item">
                        <span className="provider-quota-label">MCP tools quota</span>
                        {renderUsageCell(a.usage.tools.usedPercent, a.usage.tools.resetAt, false, a.usage.quotaStatus === "error")}
                      </div>
                    )}
                  </div>
                  {a.usage?.quotaMessage && (
                    <p className="muted">{a.usage.quotaMessage}</p>
                  )}
                </div>}
                {modelBlocks.length > 0 && (
                  <div className="state-stack provider-card-blocks">
                    {modelBlocks.map(([model, block]) => (
                      <span className="badge badge-warn" key={model}>
                        {`${model} blocked until ${fmt(block.until)}`}
                      </span>
                    ))}
                  </div>
                )}
                {a.state?.lastError && (
                  <div className="provider-card-footer">
                    <div className="provider-card-error">
                      <span className="provider-card-label">Last error</span>
                      <span className="mono">{a.state.lastError.slice(0, 120)}</span>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
        ) : null}
      </section>

      {workerSetupOpen && localWorker &&
        createPortal(
          <div
          className="modal-backdrop make-money-preview-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setWorkerSetupOpen(false);
            }
          }}
        >
          <div
            id="make-money-preview-dialog"
            ref={workerSetupDialogRef}
            className="modal panel make-money-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="make-money-preview-title"
            aria-describedby="make-money-preview-summary make-money-preview-status"
            tabIndex={-1}
          >
            <div className="modal-title-row make-money-preview-header">
              <div>
                <span className="badge badge-warn">
                  This computer · {localWorker.trust_tier === "community" ? "Community worker" : localWorker.trust_tier}
                </span>
                <h2 id="make-money-preview-title">Configure Cloud capacity</h2>
                <p id="make-money-preview-summary" className="muted">
                  Cloud jobs use only MultiVibe&apos;s managed Ollama runtime. Your
                  oMLX, LM Studio, Ollama and compatible local endpoints remain
                  available for local inference and are never used for Cloud work.
                </p>
              </div>
              <button
                ref={workerSetupCloseRef}
                type="button"
                className="btn ghost modal-close-button"
                aria-label="Close worker setup"
                onClick={() => setWorkerSetupOpen(false)}
              >
                Close
              </button>
            </div>

            <div id="make-money-preview-status" className="make-money-preview-status">
              <strong>Preview only.</strong> Nothing is shared or paid yet.
            </div>

            <section className="provider-selection-panel provider-capacity-panel" aria-labelledby="provider-capacity-title">
              <div className="provider-selection-heading">
                <div>
                  <span className="eyebrow">Your limits</span>
                  <h3 id="provider-capacity-title">Choose what to share</h3>
                  <p>
                    Start with the default limits or customize them in Advanced settings.
                  </p>
                </div>
                {(providerCapacityStatus === "ready" || providerCapacityStatus === "saving") && (
                  <span className={providerCapacityDraft.paused ? "badge badge-warn" : "badge"}>
                    {providerCapacityPolicy
                      ? `${providerCapacityDraft.paused ? "Paused" : "On"} · saved`
                      : "Not set"}
                  </span>
                )}
              </div>

              {providerCapacityStatus === "loading" && (
                <div className="provider-selection-empty" role="status">
                  Loading the protected local capacity policy…
                </div>
              )}

              {(providerCapacityStatus === "unavailable" || providerCapacityStatus === "error") && (
                <div className="provider-selection-empty provider-selection-error" role="status">
                  <strong>{providerCapacityMessage}</strong>
                  <span>No local policy was changed.</span>
                </div>
              )}

              {(providerCapacityStatus === "ready" || providerCapacityStatus === "saving") && (
                <>
                  <div className="provider-capacity-grid">
                    <label>
                      Sharing
                      <select
                        value={providerCapacityDraft.paused ? "paused" : "available"}
                        disabled={providerCapacityStatus === "saving"}
                        onChange={(event) => updateProviderCapacityDraft(
                          "paused",
                          event.target.value === "paused",
                        )}
                      >
                        <option value="paused">Paused</option>
                        <option value="available">On</option>
                      </select>
                      <small>Pause stops sharing.</small>
                    </label>

                  </div>

                  <label className="provider-capacity-consent">
                    <input
                      type="checkbox"
                      checked={providerCapacityDraft.allowCloudWorkloads}
                      disabled={providerCapacityStatus === "saving"}
                      onChange={(event) => updateProviderCapacityDraft(
                        "allowCloudWorkloads",
                        event.target.checked,
                      )}
                    />
                    <span>
                      <strong>Allow MultiVibe Cloud jobs</strong>
                      <small>
                        Off by default. You can pause sharing anytime.
                      </small>
                    </span>
                  </label>

                  <details className="make-money-preview-advanced provider-capacity-advanced">
                    <summary>
                      <span className="make-money-preview-advanced-copy">
                        <strong>Advanced settings</strong>
                        <span>Compute, memory, storage and downloads</span>
                      </span>
                    </summary>
                    <div className="provider-capacity-grid">
                    <label>
                      Compute allocation (%)
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        inputMode="numeric"
                        value={providerCapacityDraft.gpuUtilizationPercent}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="80"
                        onChange={(event) => updateProviderCapacityDraft(
                          "gpuUtilizationPercent",
                          event.target.value,
                        )}
                      />
                      <small>Requested runtime workload allocation.</small>
                    </label>

                    <label>
                      Runtime memory limit (%)
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        inputMode="numeric"
                        value={providerCapacityDraft.gpuVramPercent}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="75"
                        onChange={(event) => updateProviderCapacityDraft(
                          "gpuVramPercent",
                          event.target.value,
                        )}
                      />
                      <small>Percentage of usable runtime memory. CPU hosting reserves half of system memory first.</small>
                    </label>

                    <label className="provider-capacity-wide">
                      Model folder
                      <input
                        type="text"
                        value={providerCapacityDraft.modelStoragePath}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="/var/lib/multivibe/models"
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(event) => updateProviderCapacityDraft(
                          "modelStoragePath",
                          event.target.value,
                        )}
                      />
                      <small>Where downloaded models are stored.</small>
                    </label>

                    <label>
                      Model storage limit (GiB)
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={providerCapacityDraft.maxDiskGiB}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="30"
                        onChange={(event) => updateProviderCapacityDraft(
                          "maxDiskGiB",
                          event.target.value,
                        )}
                      />
                      <small>Maximum space for models.</small>
                    </label>

                    <label>
                      Keep free (GiB)
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={providerCapacityDraft.reserveFreeDiskGiB}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="5"
                        onChange={(event) => updateProviderCapacityDraft(
                          "reserveFreeDiskGiB",
                          event.target.value,
                        )}
                      />
                      <small>Space always kept free.</small>
                    </label>

                    <label>
                      Daily download limit (GiB)
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={providerCapacityDraft.maxDownloadGiBPerDay}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="20"
                        onChange={(event) => updateProviderCapacityDraft(
                          "maxDownloadGiBPerDay",
                          event.target.value,
                        )}
                      />
                      <small>Set to 0 to block downloads.</small>
                    </label>

                    <label>
                      Keep models for (seconds)
                      <input
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        value={providerCapacityDraft.minimumModelResidencySeconds}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="21600"
                        onChange={(event) => updateProviderCapacityDraft(
                          "minimumModelResidencySeconds",
                          event.target.value,
                        )}
                      />
                      <small>How long models stay ready.</small>
                    </label>

                    <label>
                      Model changes per day
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        value={providerCapacityDraft.maxModelChangesPerDay}
                        disabled={providerCapacityStatus === "saving"}
                        placeholder="4"
                        onChange={(event) => updateProviderCapacityDraft(
                          "maxModelChangesPerDay",
                          event.target.value,
                        )}
                      />
                      <small>Set to 0 to keep current models.</small>
                    </label>

                    <label className="provider-capacity-toggle provider-capacity-wide">
                      <input
                        type="checkbox"
                        checked={providerCapacityDraft.automaticDownloads}
                        disabled={providerCapacityStatus === "saving"}
                        onChange={(event) => updateProviderCapacityDraft(
                          "automaticDownloads",
                          event.target.checked,
                        )}
                      />
                      <span>
                        <strong>Download models automatically</strong>
                        <small>
                          Still limited by the settings above.
                        </small>
                      </span>
                    </label>
                    </div>
                  </details>



                  {!providerCapacityInput && (
                    <p className="provider-capacity-validation">
                      Check Advanced settings: complete every limit and use an absolute model folder.
                    </p>
                  )}

                  {providerCapacityMessage && (
                    <p className="provider-selection-message" role="status">
                      {providerCapacityMessage}
                    </p>
                  )}

                  <div className="provider-selection-actions">
                    <span className="muted">
                      {!providerCapacityPolicy
                        ? "Not saved yet"
                        : providerCapacityChanged
                          ? "Unsaved changes"
                          : "Saved locally"}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      disabled={
                        !providerCapacityInput ||
                        !providerCapacityChanged ||
                        providerCapacityStatus === "saving"
                      }
                      onClick={() => void saveProviderCapacityPolicy()}
                    >
                      {providerCapacityStatus === "saving"
                        ? "Saving…"
                        : "Save limits"}
                    </button>
                  </div>
                </>
              )}
            </section>

            <details className="make-money-preview-advanced">
              <summary>
                <span className="make-money-preview-advanced-copy">
                  <strong>Local-only runtime settings</strong>
                  <span>Configure local inference; these settings never supply Cloud jobs.</span>
                </span>
              </summary>

            <section className="provider-selection-panel" aria-labelledby="provider-runtime-endpoints-title">
              <div className="provider-selection-heading">
                <div>
                  <span className="eyebrow">Manual loopback runtimes</span>
                  <h3 id="provider-runtime-endpoints-title">Connect a supported local server</h3>
                  <p>
                    Only literal <span className="mono">127.0.0.1</span> or <span className="mono">::1</span> HTTP endpoints with an explicit port are accepted.
                    Bearers are stored only in Core&apos;s protected local file and are never returned by the API.
                  </p>
                </div>
                {providerRuntimeEndpoints && (
                  <span className="badge">
                    {providerRuntimeDrafts.length} configured · revision {providerRuntimeEndpoints.revision}
                  </span>
                )}
              </div>

              {(providerPreviewStatus === "ready" || providerPreviewStatus === "saving") && providerAdapterRegistry && (
                <>
                  <div className="provider-runtime-editor-list">
                    {providerRuntimeDrafts.map((draft, index) => {
                      const adapter = manuallyConfigurableProviderAdapters.find(
                        (candidate) => candidate.id === draft.adapterId,
                      );
                      const runtimeIdentity = runtimeIdentityForAdapter(
                        draft.adapterId,
                        adapter?.display_name,
                      );
                      return (
                        <fieldset className="provider-runtime-editor" key={draft.adapterId}>
                          <legend>
                            <img
                              className="runtime-icon"
                              src={runtimeIdentity.iconUrl}
                              alt=""
                              loading="lazy"
                            />
                            {runtimeIdentity.label}
                          </legend>
                          <label>
                            Loopback endpoint
                            <input
                              type="url"
                              value={draft.endpoint}
                              disabled={providerRuntimeSaving}
                              placeholder="http://127.0.0.1:8000"
                              spellCheck={false}
                              onChange={(event) => setProviderRuntimeDrafts((current) => current.map(
                                (entry, entryIndex) => entryIndex === index
                                  ? { ...entry, endpoint: event.target.value }
                                  : entry,
                              ))}
                            />
                          </label>
                          {adapter?.authentication !== "none" && (
                            <label>
                              Optional local bearer
                              <input
                                type="password"
                                value={draft.bearerToken}
                                disabled={providerRuntimeSaving || draft.clearBearer}
                                placeholder={draft.existingAuthentication === "bearer"
                                  ? "Stored locally — leave blank to keep"
                                  : "Leave blank when authentication is disabled"}
                                autoComplete="new-password"
                                onChange={(event) => setProviderRuntimeDrafts((current) => current.map(
                                  (entry, entryIndex) => entryIndex === index
                                    ? { ...entry, bearerToken: event.target.value, clearBearer: false }
                                    : entry,
                                ))}
                              />
                            </label>
                          )}
                          <div className="provider-runtime-editor-actions">
                            {draft.existingAuthentication === "bearer" && adapter?.authentication !== "none" && (
                              <label className="provider-model-choice">
                                <input
                                  type="checkbox"
                                  checked={draft.clearBearer}
                                  disabled={providerRuntimeSaving}
                                  onChange={(event) => setProviderRuntimeDrafts((current) => current.map(
                                    (entry, entryIndex) => entryIndex === index
                                      ? { ...entry, clearBearer: event.target.checked, bearerToken: "" }
                                      : entry,
                                  ))}
                                />
                                <span>Remove stored bearer</span>
                              </label>
                            )}
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={providerRuntimeSaving}
                              onClick={() => setProviderRuntimeDrafts((current) => current.filter(
                                (_, entryIndex) => entryIndex !== index,
                              ))}
                            >
                              Remove endpoint
                            </button>
                          </div>
                        </fieldset>
                      );
                    })}
                  </div>

                  <div className="provider-runtime-add-row">
                    <label className="compact-field">
                      Runtime adapter
                      <select
                        value={providerRuntimeAdapterToAdd}
                        disabled={providerRuntimeSaving || !availableProviderRuntimeAdapters.length}
                        onChange={(event) => setProviderRuntimeAdapterToAdd(event.target.value)}
                      >
                        <option value="">
                          {availableProviderRuntimeAdapters.length ? "Choose a manual adapter" : "All manual adapters are configured"}
                        </option>
                        {availableProviderRuntimeAdapters.map((adapter) => (
                          <option key={adapter.id} value={adapter.id}>{adapter.display_name}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={!providerRuntimeAdapterToAdd || providerRuntimeSaving}
                      onClick={() => {
                        const adapterId = providerRuntimeAdapterToAdd;
                        if (!adapterId) return;
                        setProviderRuntimeDrafts((current) => [...current, {
                          adapterId,
                          endpoint: adapterId === "nvidia-pair"
                            ? "http://127.0.0.1:11434"
                            : "http://127.0.0.1:8000",
                          bearerToken: "",
                          existingAuthentication: "none",
                          clearBearer: false,
                        }]);
                        setProviderRuntimeAdapterToAdd("");
                        setProviderRuntimeMessage("");
                      }}
                    >
                      Add local endpoint
                    </button>
                  </div>

                  {providerRuntimeAdapterToAdd === "nvidia-pair" && (
                    <p className="muted">
                      Copy the loopback API endpoint shown by PAIR. Its default ports overlap with Ollama and LM Studio, so MultiVibe cannot identify it safely by port alone.
                    </p>
                  )}

                  {providerRuntimeMessage && (
                    <p className="provider-selection-message" role="status">{providerRuntimeMessage}</p>
                  )}
                  <div className="provider-selection-actions">
                    <span className="muted">
                      Saving changes only the protected local runtime file and reruns bounded loopback detection.
                    </span>
                    <button
                      type="button"
                      className="btn"
                      disabled={!providerRuntimeChanged || providerRuntimeSaving}
                      onClick={() => void saveProviderRuntimeEndpoints()}
                    >
                      {providerRuntimeSaving ? "Saving locally…" : "Save endpoints locally"}
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="provider-selection-panel" aria-labelledby="provider-selection-title">
              <div className="provider-selection-heading">
                <div>
                  <span className="eyebrow">Local inference preferences</span>
                  <h3 id="provider-selection-title">Choose locally approved models</h3>
                  <p>
                    Detection and selection stay on this machine. Saving only
                    updates Core&apos;s protected local selection file. These models
                    are never submitted to or selected for MultiVibe Cloud work.
                  </p>
                </div>
                {providerSelection && (
                  <span className={providerSelectionDraft.length ? "badge badge-live" : "badge"}>
                    {providerSelectionDraft.length} selected · revision {providerSelection.revision}
                  </span>
                )}
              </div>

              {providerPreviewStatus === "loading" && (
                <div className="provider-selection-empty" role="status">
                  Checking reviewed local runtime endpoints…
                </div>
              )}

              {(providerPreviewStatus === "unavailable" || providerPreviewStatus === "error") && (
                <div className="provider-selection-empty provider-selection-error" role="status">
                  <strong>{providerPreviewMessage}</strong>
                  {providerPreviewStatus === "unavailable" && (
                    <span>Enable the packaged embedded agent to use local detection and selection.</span>
                  )}
                </div>
              )}

              {(providerPreviewStatus === "ready" || providerPreviewStatus === "saving") && providerDetectedModels && (
                <div className="provider-runtime-list">
                  {providerDetectedModels.runtimes.map((runtime) => {
                    const runtimeIdentity = runtimeIdentityForAdapter(runtime.adapter_id);
                    return (
                      <fieldset className="provider-runtime-group" key={runtime.adapter_id}>
                        <legend>
                          <img
                            className="runtime-icon"
                            src={runtimeIdentity.iconUrl}
                            alt=""
                            loading="lazy"
                          />
                          {runtimeIdentity.label}
                        </legend>
                        {runtime.models.map((model) => (
                          <label className="provider-model-choice" key={`${runtime.adapter_id}:${model}`}>
                            <input
                              type="checkbox"
                              checked={providerSelectionDraft.includes(model)}
                              disabled={providerPreviewStatus === "saving"}
                              onChange={() => toggleProviderSelection(model)}
                            />
                            <span className="mono">{model}</span>
                          </label>
                        ))}
                      </fieldset>
                    );
                  })}

                  {selectedButNotDetected.length > 0 && (
                    <fieldset className="provider-runtime-group provider-runtime-offline">
                      <legend>Selected but not currently detected</legend>
                      {selectedButNotDetected.map((model) => (
                        <label className="provider-model-choice" key={`offline:${model}`}>
                          <input
                            type="checkbox"
                            checked
                            disabled={providerPreviewStatus === "saving"}
                            onChange={() => toggleProviderSelection(model)}
                          />
                          <span className="mono">{model}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  {!providerDetectedModels.runtimes.length && !selectedButNotDetected.length && (
                    <div className="provider-selection-empty">
                      No model was returned by the reviewed loopback candidates.
                      Start a supported local runtime, then reopen this preview.
                    </div>
                  )}
                </div>
              )}

              {providerPreviewMessage && providerPreviewStatus === "ready" && (
                <p className="provider-selection-message" role="status">{providerPreviewMessage}</p>
              )}

              {(providerPreviewStatus === "ready" || providerPreviewStatus === "saving") && (
                <div className="provider-selection-actions">
                  <span className="muted">
                    {providerSelectionChanged
                      ? "Unsaved local changes"
                      : "Local selection is up to date"}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={!providerSelectionChanged || providerPreviewStatus === "saving"}
                    onClick={() => void saveProviderSelection()}
                  >
                    {providerPreviewStatus === "saving" ? "Saving locally…" : "Save local selection"}
                  </button>
                </div>
              )}
            </section>

            </details>

            <div className="modal-actions make-money-preview-actions">
              <span className="muted">
                Cloud work still requires enrollment and your explicit saved consent
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => setWorkerSetupOpen(false)}
              >
                Got it
              </button>
            </div>
          </div>
          </div>,
          document.body,
        )}

      {showAddAccount && !oauthDialog && (
        <ModalPortal><div className="modal-backdrop" onClick={() => { if (!isSubmitting) closeModal(); }}>
          <div ref={providerModalRef} className={`modal panel provider-setup-modal${onboardingProviderSetup ? " onboarding-provider-modal" : ""}`} role="dialog" aria-modal="true" aria-label={providerStep === 0 ? "Choose your provider" : undefined} aria-labelledby={providerStep > 0 ? "provider-setup-title" : undefined} tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={(event) => {
            if (event.key === "Escape" && !isSubmitting) { event.stopPropagation(); closeModal(); }
            if (event.key === "Tab") {
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [href]')).filter((item) => item.getClientRects().length > 0);
              const first = items[0], last = items[items.length - 1];
              if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}>
            <div className="inline wrap row-between">
              <span className="eyebrow">NEW CONNECTION</span>
              <div className="inline wrap">
                {onboardingProviderSetup && (
                  <button className="btn ghost" disabled={isSubmitting} onClick={() => {
                    closeModal();
                    onSkipOnboarding?.();
                  }}>
                    Skip setup
                  </button>
                )}
                <button className="btn ghost" disabled={isSubmitting} onClick={closeModal}>
                  {onboardingProviderSetup ? "Back" : "Close"}
                </button>
              </div>
            </div>
            <ol className="provider-setup-steps" aria-label="Setup progress">
              {["Choose provider", "Connect", "Review"].map((label, index) => <li key={label} className={index === providerStep ? "active" : index < providerStep ? "complete" : ""} aria-current={index === providerStep ? "step" : undefined}><span>{index < providerStep ? "✓" : index + 1}</span>{label}</li>)}
            </ol>
            {providerStep > 0 && <div className="provider-setup-heading">
              <ProviderMark provider={provider} sdkProvider={sdkProvider} />
              <div><h2 id="provider-setup-title">{providerStep === 1 ? `Connect ${selectedProviderName}` : "Ready to connect?"}</h2>
              <p className="muted">{providerStep === 1 ? "Enter your connection details to continue." : "Check your connection and customize routing if needed."}</p></div>
            </div>}
            {providerStep === 0 && <ProviderPicker value={provider} sdkProvider={sdkProvider} cloudProviders={sdkProviders} error={sdkCatalogError} onChange={selectProvider} />}
            {providerStep === 1 && <div className="grid modal-grid provider-setup-fields">

              <label>
                {provider === "openai" ? "Email" : "Email (optional)"}
                <input
                  value={manualEmail}
                  onChange={(e) => setManualEmail(e.target.value)}
                  placeholder="account@email.com"
                />
              </label>
              {isOAuthProvider(provider) && (
                <label>
                  {provider === "xai"
                    ? "Grok Build login method"
                    : "OpenAI login method"}
                  <select
                    value={manualOAuthMethod}
                    disabled={provider === "xai"}
                    onChange={(e) =>
                      setManualOAuthMethod(e.target.value as OAuthMethod)
                    }
                  >
                    {provider === "openai" && (
                      <option value="browser">Browser callback</option>
                    )}
                    <option value="device">Device code</option>
                  </select>
                </label>
              )}
              {(provider === "openai-compatible" || provider === "nvidia-pair") && (
                <label>
                  Base URL
                  <input
                    value={manualBaseUrl}
                    onChange={(e) => setManualBaseUrl(e.target.value)}
                    placeholder={provider === "nvidia-pair" ? "http://127.0.0.1:11434" : "https://your-api.example.com"}
                  />
                </label>
              )}
              {provider === "ai-sdk" && <>
                <label>Model IDs (optional)
                  <textarea value={sdkModels} onChange={(event) => setSdkModels(event.target.value)} placeholder="Leave empty for the catalog, or enter model IDs separated by commas" />
                </label>
                <p className="muted">{sdkProviders.find((entry) => entry.id === sdkProvider)?.models.length ?? 0} text-generation models listed by models.dev. Access and pricing depend on your provider account. Subscription quotas are not supplied by the catalog.</p>
              </>}
              {provider === "nvidia-pair" ? (
                <div className="muted">PAIR is probed without a token and is isolated as personal-cluster capacity.</div>
              ) : isManualTokenProvider(provider) ? (
                <>
                  <label>
                    API key
                    <input
                      type="password" autoComplete="off"
                      value={manualAccessToken}
                      onChange={(e) => setManualAccessToken(e.target.value)}
                      placeholder={provider === "opencode" ? "Optional for device sign-in" : "Required"}
                    />
                  </label>
                  {!onboardingProviderSetup && <label>
                    Refresh token (optional)
                    <input
                      type="password" autoComplete="off"
                      value={manualRefreshToken}
                      onChange={(e) => setManualRefreshToken(e.target.value)}
                      placeholder="Optional"
                    />
                  </label>}
                </>
              ) : (
                <div className="muted">
                  {provider === "xai"
                    ? "Grok Build uses xAI device OAuth and the SuperGrok / X Premium+ subscription quota."
                    : "OpenAI onboarding uses OAuth. Browser callback opens the login page and asks for the callback URL. Device code shows a one-time code and completes automatically after approval."}
                </div>
              )}
              {provider === "opencode" && (
                <div className="muted">
                  Enter an API key, or leave it empty to sign in with your OpenCode Console account on the next step. Go API keys support 5h, weekly and monthly quotas. Console device connections may not expose these quotas.
                </div>
              )}
            </div>}
            {providerStep === 2 && <>
              <dl className="provider-setup-summary">
                <div><dt>Provider</dt><dd>{provider === "ai-sdk" ? sdkProviders.find((item) => item.id === sdkProvider)?.name : SETUP_PROVIDERS.find((item) => item.id === provider)?.name}</dd></div>
                <div><dt>Account</dt><dd>{manualEmail.trim() || "No email label"}</dd></div>
                <div><dt>Connection</dt><dd>{isOAuthProvider(provider) ? manualOAuthMethod === "device" ? "Device sign-in" : "Browser sign-in" : provider === "opencode" && !manualAccessToken.trim() ? "OpenCode device sign-in" : provider === "nvidia-pair" ? "Token-free endpoint" : "API key provided"}</dd></div>
                {(provider === "openai-compatible" || provider === "nvidia-pair") && <div><dt>Endpoint</dt><dd>{manualBaseUrl}</dd></div>}
              </dl>
              {isOAuthProvider(provider) && <p className="provider-setup-note">Next, approve the connection with your provider to finish setup.</p>}
              {!onboardingProviderSetup && <details className="provider-setup-advanced"><summary>Advanced settings <span>Routing, priority & capacity</span></summary><div className="grid modal-grid">
              {!onboardingProviderSetup && <label>
                Upstream mode (optional)
                <select
                  value={manualUpstreamMode}
                  onChange={(e) =>
                    setManualUpstreamMode(
                      e.target.value as "" | "responses" | "chat/completions",
                    )
                  }
                >
                  <option value="">Automatic</option>
                  <option value="responses">Force `/v1/responses`</option>
                  <option value="chat/completions">
                    Force `/v1/chat/completions`
                  </option>
                </select>
              </label>}
              {!onboardingProviderSetup && isManualTokenProvider(provider) && (
                <>
                  <label>Execution location<select value={manualLocation} onChange={(e) => setManualLocation(e.target.value as "" | "local" | "personal-cluster" | "cloud")}><option value="">Infer from URL/provider</option><option value="local">Local</option><option value="personal-cluster">Personal cluster</option><option value="cloud">Cloud</option></select></label>
                  <label>Concurrent slots<input type="number" min="1" value={manualMaxConcurrent} onChange={(e) => setManualMaxConcurrent(e.target.value)} placeholder="1 local / 8 cloud" /></label>
                  <label>Prefill tokens/s<input type="number" min="0" value={manualPrefill} onChange={(e) => setManualPrefill(e.target.value)} /></label>
                  <label>Decode tokens/s<input type="number" min="0" value={manualDecode} onChange={(e) => setManualDecode(e.target.value)} /></label>
                  <label>Context window<input type="number" min="1" value={manualContext} onChange={(e) => setManualContext(e.target.value)} placeholder="262144" /></label>
                  <label>Health URL<input type="url" value={manualHealthUrl} onChange={(e) => setManualHealthUrl(e.target.value)} placeholder="http://worker.local:8000/health" /></label>
                  <label>Metrics URL<input type="url" value={manualMetricsUrl} onChange={(e) => setManualMetricsUrl(e.target.value)} placeholder="Optional JSON metrics" /></label>
                </>
              )}
              {!onboardingProviderSetup && <label>
                Priority
                <input
                  value={manualPriority}
                  onChange={(e) => setManualPriority(e.target.value)}
                  placeholder="0"
                />
              </label>}
              {!onboardingProviderSetup && <label className="inline">
                <input
                  type="checkbox"
                  checked={manualEnabled}
                  onChange={(e) => setManualEnabled(e.target.checked)}
                />
                Enabled
              </label>}
              </div></details>}
            </>}
            {providerError && <p className="provider-setup-error" role="alert">{providerError}</p>}
            <div className="provider-setup-footer">
              <button className="btn ghost" disabled={isSubmitting} onClick={() => { if (providerStep === 0) closeModal(); else { setProviderStep(providerStep - 1); setProviderError(""); } }}>{providerStep === 0 ? "Cancel" : "Back"}</button>
              <span className="muted provider-setup-step-count">Step {providerStep + 1} of 3</span>
              {providerStep < 2 && <button className="btn" disabled={providerStep === 1 && !providerConnectionReady} onClick={() => setProviderStep(providerStep + 1)}>Continue <span aria-hidden="true">→</span></button>}
              {providerStep === 2 && <div className="inline wrap">

              {!(provider === "opencode" && !manualAccessToken.trim()) && <button
                className="btn"
                disabled={
                  isSubmitting ||
                  (isOAuthProvider(provider)
                    ? provider === "openai" && !manualEmail.trim()
                    : (provider !== "nvidia-pair" && !manualAccessToken.trim()) ||
                      ((provider === "openai-compatible" || provider === "nvidia-pair") &&
                        !manualBaseUrl.trim()))
                }
                onClick={() => { setProviderError(""); void submitManualAccount().catch((error) => setProviderError(error instanceof Error ? error.message : String(error))); }}
              >
                {isSubmitting
                  ? isOAuthProvider(provider)
                    ? "Starting OAuth..."
                    : "Creating..."
                  : isOAuthProvider(provider)
                    ? provider === "xai"
                      ? "Start Grok device login"
                      : "Start OAuth"
                    : "Create account"}
              </button>}
              {provider === "xai" && (
                <button
                  className="btn ghost"
                  disabled={isSubmitting}
                  onClick={() => {
                    setIsSubmitting(true);
                    void importGrokAuth()
                      .then(() => closeModal())
                      .catch((error) => {
                        setProviderError(error instanceof Error ? error.message : String(error));
                      })
                      .finally(() => setIsSubmitting(false));
                  }}
                >
                  Import configured auth.json
                </button>
              )}
              {provider === "opencode" && (
                <button
                  className={manualAccessToken.trim() ? "btn ghost" : "btn"}
                  disabled={isSubmitting}
                  onClick={() => {
                    setIsSubmitting(true);
                    void openOAuthDialog({
                      email: manualEmail.trim(),
                      method: "device",
                      provider: "opencode",
                      mode: "create",
                      pendingPriority: Number(manualPriority) || 0,
                      pendingEnabled: manualEnabled,
                    }).catch((error) => setProviderError(error instanceof Error ? error.message : String(error))).finally(() => setIsSubmitting(false));
                  }}
                >
                  Connect OpenCode account
                </button>
              )}
              </div>}
            </div>
          </div>
        </div></ModalPortal>
      )}

      {editingAccount && (
        <ModalPortal><div className="modal-backdrop" onClick={closeEditModal}>
          <div className="modal panel" onClick={(e) => e.stopPropagation()}>
            <div className="inline wrap row-between">
              <h2>Update account</h2>
              <button className="btn ghost" onClick={closeEditModal}>
                Close
              </button>
            </div>
            <div className="grid modal-grid">
              <label>
                Email (optional)
                <input
                  value={editingAccount.email}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current ? { ...current, email: e.target.value } : current,
                    )
                  }
                  placeholder="account@email.com"
                />
              </label>
              {isOAuthProvider(editingAccount.provider) && (
                <label>
                  {editingAccount.provider === "xai"
                    ? "Grok Build reauth method"
                    : "OpenAI reauth method"}
                  <select
                    value={editOAuthMethod}
                    disabled={editingAccount.provider === "xai"}
                    onChange={(e) =>
                      setEditOAuthMethod(e.target.value as OAuthMethod)
                    }
                  >
                    {editingAccount.provider === "openai" && (
                      <option value="browser">Browser callback</option>
                    )}
                    <option value="device">Device code</option>
                  </select>
                </label>
              )}
              {editingAccount.provider === "openai-compatible" && (
                <label>
                  Base URL
                  <input
                    value={editingAccount.baseUrl}
                    onChange={(e) =>
                      setEditingAccount((current) =>
                        current
                          ? { ...current, baseUrl: e.target.value }
                          : current,
                      )
                    }
                    placeholder="https://your-api.example.com"
                  />
                </label>
              )}
              <label>
                Upstream mode (optional)
                <select
                  value={editingAccount.upstreamMode}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current
                        ? {
                            ...current,
                            upstreamMode: e.target.value as
                              | ""
                              | "responses"
                              | "chat/completions",
                          }
                        : current,
                    )
                  }
                >
                  <option value="">Automatic</option>
                  <option value="responses">Force `/v1/responses`</option>
                  <option value="chat/completions">
                    Force `/v1/chat/completions`
                  </option>
                </select>
              </label>
              <label>Execution location<select value={editingAccount.location} onChange={(e) => setEditingAccount((current) => current ? { ...current, location: e.target.value as "local" | "personal-cluster" | "cloud" } : current)}><option value="local">Local</option><option value="personal-cluster">Personal cluster</option><option value="cloud">Cloud</option></select></label>
              <label>Concurrent slots<input type="number" min="1" value={editingAccount.maxConcurrent} onChange={(e) => setEditingAccount((current) => current ? { ...current, maxConcurrent: e.target.value } : current)} /></label>
              <label>Prefill tokens/s<input type="number" min="0" value={editingAccount.prefillTokensPerSecond} onChange={(e) => setEditingAccount((current) => current ? { ...current, prefillTokensPerSecond: e.target.value } : current)} /></label>
              <label>Decode tokens/s<input type="number" min="0" value={editingAccount.decodeTokensPerSecond} onChange={(e) => setEditingAccount((current) => current ? { ...current, decodeTokensPerSecond: e.target.value } : current)} /></label>
              <label>Context window<input type="number" min="1" value={editingAccount.contextWindow} onChange={(e) => setEditingAccount((current) => current ? { ...current, contextWindow: e.target.value } : current)} /></label>
              <label>Health URL<input type="url" value={editingAccount.healthUrl} onChange={(e) => setEditingAccount((current) => current ? { ...current, healthUrl: e.target.value } : current)} /></label>
              <label>Metrics URL<input type="url" value={editingAccount.metricsUrl} onChange={(e) => setEditingAccount((current) => current ? { ...current, metricsUrl: e.target.value } : current)} /></label>
              {isManualTokenProvider(editingAccount.provider) ? (
                <>
                  <label>
                    API key
                    <input
                      value={editingAccount.accessToken}
                      onChange={(e) =>
                        setEditingAccount((current) =>
                          current
                            ? { ...current, accessToken: e.target.value }
                            : current,
                        )
                      }
                      placeholder="Required"
                    />
                  </label>
                  <label>
                    Refresh token (optional)
                    <input
                      value={editingAccount.refreshToken}
                      onChange={(e) =>
                        setEditingAccount((current) =>
                          current
                            ? { ...current, refreshToken: e.target.value }
                            : current,
                        )
                      }
                      placeholder="Optional"
                    />
                  </label>
                </>
              ) : (
                <div className="muted">
                  {editingAccount.provider === "xai"
                    ? "Grok Build reauth uses xAI device OAuth. Save changes, then approve the one-time code."
                    : "OpenAI reauth uses OAuth. Save changes to open the login flow, then paste the full callback URL instead of editing tokens manually."}
                </div>
              )}
              <label>
                Priority
                <input
                  value={editingAccount.priority}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current
                        ? { ...current, priority: e.target.value }
                        : current,
                    )
                  }
                  placeholder="0"
                />
              </label>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={editingAccount.enabled}
                  onChange={(e) =>
                    setEditingAccount((current) =>
                      current
                        ? { ...current, enabled: e.target.checked }
                        : current,
                    )
                  }
                />
                Enabled
              </label>
            </div>
            <div className="inline wrap">
              <button
                className="btn"
                disabled={
                  isSavingEdit ||
                  (isOAuthProvider(editingAccount.provider)
                    ? editingAccount.provider === "openai" &&
                      !editingAccount.email.trim()
                    : !editingAccount.accessToken.trim() ||
                      (editingAccount.provider === "openai-compatible" &&
                        !editingAccount.baseUrl.trim()))
                }
                onClick={() => void saveEditedAccount()}
              >
                {isSavingEdit
                  ? isOAuthProvider(editingAccount.provider)
                    ? "Starting OAuth..."
                    : "Saving..."
                  : isOAuthProvider(editingAccount.provider)
                    ? editingAccount.provider === "xai"
                      ? "Start Grok reauth"
                      : "Start reauth"
                    : "Save changes"}
              </button>
              <button className="btn ghost" onClick={closeEditModal}>
                Cancel
              </button>
            </div>
          </div>
        </div></ModalPortal>
      )}

      {oauthDialog && (
        <ModalPortal><div className="modal-backdrop" onClick={closeOauthDialog}>
          <div className="modal panel" onClick={(e) => e.stopPropagation()}>
            <div className="inline wrap row-between">
              <h2>
                {oauthDialog.mode === "create"
                  ? `Complete ${oauthProviderLabel(oauthDialog.provider)} OAuth`
                  : `Complete ${oauthProviderLabel(oauthDialog.provider)} reauth`}
              </h2>
              <div className="inline wrap">
                {onboardingProviderSetup && (
                  <button className="btn ghost" onClick={() => {
                    closeOauthDialog();
                    closeModal();
                    onSkipOnboarding?.();
                  }}>
                    Skip setup
                  </button>
                )}
                <button className="btn ghost" onClick={closeOauthDialog}>
                  Close
                </button>
              </div>
            </div>
            <div className="grid modal-grid">
              <label>
                Email {oauthDialog.provider !== "openai" ? "(from provider after approval)" : ""}
                <input value={oauthDialog.email} disabled />
              </label>
              {oauthDialog.method === "device" ? (
                <>
                  <label>
                    Verification URL
                    <input value={oauthDialog.verificationUrl ?? ""} disabled />
                  </label>
                  <label>
                    Device code
                    <input
                      className="mono"
                      value={oauthDialog.userCode ?? ""}
                      disabled
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Redirect URI
                    <input value={oauthDialog.expectedRedirectUri} disabled />
                  </label>
                  <label>
                    Callback URL
                    <textarea
                      value={oauthDialog.callbackInput}
                      onChange={(e) =>
                        setOauthDialog((current) =>
                          current
                            ? { ...current, callbackInput: e.target.value }
                            : current,
                        )
                      }
                      placeholder="Paste the full URL after the browser reaches the callback page"
                      rows={5}
                    />
                  </label>
                </>
              )}
            </div>
            <div className="muted">
              {oauthDialog.method === "device"
                ? `Open the verification URL, enter the one-time code, and approve the ${
                    oauthDialog.provider === "xai"
                      ? "xAI"
                      : oauthDialog.provider === "opencode"
                        ? "OpenCode"
                        : "OpenAI"
                  } login. This dialog will complete automatically after approval. Do not share this code.`
                : "Complete the OpenAI login in the opened browser tab. When the browser reaches the callback page, copy the full URL and paste it here. Do not paste access or refresh tokens."}
            </div>
            <div className="inline wrap">
              <button
                className="btn"
                onClick={() =>
                  window.open(
                    oauthDialog.method === "device"
                      ? oauthDialog.verificationUrl
                      : oauthDialog.authorizeUrl,
                    "_blank",
                    "noreferrer",
                  )
                }
              >
                {oauthDialog.method === "device"
                  ? "Open verification page"
                  : "Open login page"}
              </button>
              {oauthDialog.method === "browser" ? (
                <button
                  className="btn"
                  disabled={
                    oauthDialog.isSubmitting ||
                    !oauthDialog.callbackInput.trim()
                  }
                  onClick={() => void submitOauthCallback()}
                >
                  {oauthDialog.isSubmitting
                    ? "Completing..."
                    : "Complete OAuth"}
                </button>
              ) : (
                <button className="btn" disabled>
                  {oauthDialog.isSubmitting
                    ? "Checking..."
                    : "Waiting for approval"}
                </button>
              )}
              <button className="btn ghost" onClick={closeOauthDialog}>
                Cancel
              </button>
            </div>
          </div>
        </div></ModalPortal>
      )}
    </>
  );
}
