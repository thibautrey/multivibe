import { providerMutationFields } from "../../capabilities";
import { useDashboardApi, useDashboardRuntime } from "../../adapter";
import { ChatGPTDeviceGuide } from "../ChatGPTDeviceGuide";
import type { ModelRoute } from "../../lib/modelCatalog";
import { findAvailableCount } from "../../lib/resetCredits";
import ModalPortal from "../ModalPortal";
import type { Account, ExposedModel, ProviderId, StoreSettings, TraceStats } from "../../types";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmt, maskEmail, maskId, usd } from "../../lib/ui";
import { ApiError } from "../../lib/api";
import {
  observeFloatingViewportChanges,
  placeFloatingMenu,
  type FloatingMenuAnchor,
  type FloatingMenuPlacement,
  type FloatingMenuViewport,
} from "../../lib/floatingMenu";
import {
  runtimeIdentityForAccount,
} from "../../lib/runtimeCatalog";
import { tracksSubscriptionQuota } from "../../lib/accountQuota";
import { providerAccess } from "../../lib/providerAccess";
import { providerAccountTarget, type OpenAIConnectionMode } from "../../lib/providerConnection";

import { modelsExposedByAccount } from "../../lib/modelCatalog";
import { AccountModelsSection } from "../AccountModelsSection";
import { ProviderPicker, ProviderMark, SETUP_PROVIDERS, type SetupProvider, type CloudProvider } from "../ProviderPicker";
import { ProviderModelPicker, type ProviderModelOption, type ProviderModelsLive } from "../ProviderModelPicker";
import { Metric } from "../Metric";
import { WidgetGrid } from "../WidgetGrid";
import { createPortal } from "react-dom";
import { t as translate, useT } from "../../i18n";

const CODEX_QUOTA_RESET_FORECAST_URL = "https://www.willcodexquotareset.com/";

type Props = {
  traceStats: TraceStats;
  accounts: Account[];
  /** Exposed catalog of the workspace, used to list what each account serves. */
  models?: ExposedModel[];
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
    provider?: "openai" | "opencode" | "xai" | "github-copilot",
  ) => Promise<any>;
  pollDeviceOAuth: (flowId: string) => Promise<any>;
  completeOAuth: (flowId: string, input: string) => Promise<any>;
  oauthRedirectUri: string;
  /** Forces a fresh upstream discovery round before the catalog is re-read. */
  onRefreshModels?: () => Promise<void>;
  providerSetupRequest?: number;
  modelSetupTarget?: ModelRoute;
  onModelSetupConsumed?: () => void;
  onboardingProviderSetup?: boolean;
  onProviderSetupClosed?: () => void;
  onSkipOnboarding?: () => void;
};

export type MultivibeCloudProvider = {
  status: "disconnected" | "connected" | "unavailable";
  dollarCreditsUsd?: string;
  balanceUsd?: string;
  subscription?: string;
  topupUrl: string;
};

type AccountProvider = ProviderId;
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
  sdkProvider?: string;
  sdkModels: string;
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
  pollingError?: string;
  mode: "create" | "reauth";
  accountId?: string;
  pendingPriority?: number;
  pendingEnabled?: boolean;
  provider: "openai" | "opencode" | "xai" | "github-copilot";
};

function isOAuthProvider(provider: AccountProvider) {
  return provider === "openai" || provider === "xai" || provider === "github-copilot";
}

function isManualTokenProvider(provider: AccountProvider) {
  return provider === "ai-sdk" || provider === "mistral" || provider === "openai-compatible" || provider === "opencode" || provider === "zai";
}

function oauthProviderLabel(provider: "openai" | "opencode" | "xai" | "github-copilot") {
  if (provider === "github-copilot") return "GitHub Copilot";
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
  if (ageMs < 60_000) return translate("just now");
  const ageMinutes = Math.floor(ageMs / 60_000);
  if (ageMinutes < 60) return translate("{count}m ago", { count: ageMinutes });
  const ageHours = Math.floor(ageMinutes / 60);
  return translate("{count}h ago", { count: ageHours });
}

function usageStatusLabel(account: Account, usageCacheTtlMs: number) {
  if (!account.usage) return translate("Usage not checked");
  if (account.usage.quotaStatus === "unsupported") return translate("Usage not exposed");
  if (account.usage.quotaStatus === "error") return translate("Usage refresh failed");
  if (
    typeof account.usage.fetchedAt === "number" &&
    Date.now() - account.usage.fetchedAt >= usageCacheTtlMs
  ) {
    return translate("Refresh pending");
  }
  const primary = account.usage.primary?.usedPercent;
  const secondary = account.usage.secondary?.usedPercent;
  if (primary === 0 && secondary === 0) return translate("No usage reported");
  return translate("Usage checked");
}

function usageSummaryLabel(account: Account, usageCacheTtlMs: number) {
  const status = usageStatusLabel(account, usageCacheTtlMs);
  const fetchedAt = account.usage?.fetchedAt;
  return typeof fetchedAt === "number" && Number.isFinite(fetchedAt)
    ? translate("{status} · {age}", { status, age: usageAgeLabel(fetchedAt) })
    : status;
}

export function AccountsTab(props: Props) {
  const t = useT();
  const api = useDashboardApi();
  const { capabilities } = useDashboardRuntime();
  const {
    traceStats,
    accounts,
    models = [],
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
    onRefreshModels,
  } = props;
  // The routing catalog already tags every model with the account it was
  // discovered from, so these per-provider lists need no extra request.
  const modelsByAccount = React.useMemo(() => {
    const grouped = new Map<string, ExposedModel[]>();
    for (const account of accounts) grouped.set(account.id, modelsExposedByAccount(models, account));
    return grouped;
  }, [accounts, models]);
  const [resetCredits, setResetCredits] = useState<Record<string, number | undefined>>({});
  const [resetCreditRefresh, setResetCreditRefresh] = useState(0);
  const resetCreditAccounts = JSON.stringify(
    accounts.filter(account => isOpenAiAccount(account) && !account.state?.needsTokenRefresh && account.actions?.quotaReset !== false).map((account) => [account.id, account.usage?.fetchedAt]),
  );

  useEffect(() => {
    const controller = new AbortController();
    const entries = JSON.parse(resetCreditAccounts) as [string, number | null][];
    for (const [id] of entries) {
      void api(`accounts/${encodeURIComponent(id)}/rate-limit-reset-credit`, {
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
      setCloudError(error?.message ?? t("Could not connect to MultiVibe Cloud."));
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
      setCloudError(error?.message ?? t("Could not disconnect from MultiVibe Cloud."));
    } finally {
      setCloudBusy(false);
    }
  };
  const [provider, setProvider] = useState<AccountProvider>("openai");
  const [sdkProviders, setSdkProviders] = useState<CloudProvider[]>([]);
  const [sdkProvider, setSdkProvider] = useState("anthropic");
  const [sdkModels, setSdkModels] = useState("");
  const [editModelOptions, setEditModelOptions] = useState<ProviderModelOption[]>([]);
  const [editModelsLoading, setEditModelsLoading] = useState(false);
  const [editModelsError, setEditModelsError] = useState("");
  const [editModelsLive, setEditModelsLive] = useState<ProviderModelsLive>(null);
  const [sdkCatalogError, setSdkCatalogError] = useState("");
  useEffect(() => {
    let active = true;
    void api("provider-catalog").then((catalog) => {
      if (active) setSdkProviders(catalog.providers);
    }).catch(() => { if (active) setSdkCatalogError(translate("Provider list could not be loaded. Reload to try again.")); });
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
    useState<OAuthMethod>("device");
  const [openAIConnectionMode, setOpenAIConnectionMode] =
    useState<OpenAIConnectionMode>("subscription");
  const [editOAuthMethod, setEditOAuthMethod] =
    useState<OAuthMethod>("device");
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
    if (!oauthDialog || oauthDialog.method !== "device" || oauthDialog.pollingError) return;

    let cancelled = false;
    const delayMs = Math.max(1, oauthDialog.intervalSeconds ?? 5) * 1000;
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      if (devicePollInFlight.current) return;
      devicePollInFlight.current = true;
      try {
        console.log("[oauth-device] polling approval", {
          intervalSeconds: oauthDialog.intervalSeconds ?? 5,
        });
        const result = await pollDeviceOAuth(oauthDialog.flowId);
        console.log("[oauth-device] poll result", {
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
            (capabilities.providerPriority && (oauthDialog.pendingPriority ?? 0) !== 0 ||
              oauthDialog.pendingEnabled === false)
          ) {
            await patch(accountId, providerMutationFields({
              priority: oauthDialog.pendingPriority ?? 0,
              enabled: oauthDialog.pendingEnabled ?? true,
            }, capabilities, "update"));
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
          error: err,
        });
        if (!cancelled) {
          setOauthDialog((current) =>
            current ? {
              ...current, isSubmitting: false,
              ...((err instanceof ApiError && [400, 404, 410, 500].includes(err.status))
                ? { pollingError: translate("Sign-in could not be completed. Close this dialog and start a new sign-in.") } : {}),
            } : current,
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
    setManualOAuthMethod("device");
    setOpenAIConnectionMode("subscription");
    setProviderError("");
  }, [provider, sdkProvider]);
  const selectedProviderName = provider === "ai-sdk"
    ? sdkProviders.find((item) => item.id === sdkProvider)?.name
    : SETUP_PROVIDERS.find((item) => item.id === provider)?.name;
  const selectedSdkProvider = sdkProviders.find((item) => item.id === sdkProvider);
  const editingSdkProvider = sdkProviders.find((item) => item.id === editingAccount?.sdkProvider);
  const createModelOptions = React.useMemo<ProviderModelOption[]>(
    () => (selectedSdkProvider?.models ?? []).map((model) => ({ id: model.id, name: model.name })),
    [selectedSdkProvider],
  );

  const loadAccountProviderModels = useCallback(async (accountId: string, refresh = false) => {
    if (!capabilities.providerModelDiscovery) return;
    setEditModelsLoading(true);
    setEditModelsError("");
    try {
      const result = await api(
        `accounts/${encodeURIComponent(accountId)}/models${refresh ? "/refresh" : ""}`,
        refresh ? { method: "POST" } : undefined,
      );
      const prefix = typeof result.provider === "string" && result.provider ? `${result.provider}/` : "";
      const options = (Array.isArray(result.data) ? result.data : [])
        .map((model: any) => {
          const raw = typeof model?.id === "string" ? model.id : "";
          return {
            id: prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw,
            name: typeof model?.name === "string" ? model.name : undefined,
            context: typeof model?.context_window === "number" ? model.context_window : null,
          };
        })
        .filter((model: ProviderModelOption) => model.id);
      setEditModelOptions(options);
      setEditModelsLive({
        discovered: Boolean(result.discovered),
        source: result.live?.source ?? null,
        fetchedAt: result.live?.fetchedAt ?? null,
        stale: Boolean(result.live?.stale),
        error: result.live?.error ?? null,
        catalog: result.catalog ?? null,
      });
    } catch {
      setEditModelOptions([]);
      setEditModelsLive(null);
      setEditModelsError(translate("Models unavailable. Enter the IDs manually or try again."));
    } finally {
      setEditModelsLoading(false);
    }
  }, []);

  const usesOpenAIAPIKey = provider === "openai" && openAIConnectionMode === "api-key";
  const usesOAuthConnection = isOAuthProvider(provider) && !usesOpenAIAPIKey;
  const providerConnectionReady = usesOAuthConnection
    ? provider !== "openai" || Boolean(manualEmail.trim())
    : (provider === "opencode" || Boolean(manualAccessToken.trim())) &&
      (!(provider === "openai-compatible") || Boolean(manualBaseUrl.trim())) &&
      (provider !== "ai-sdk" || Boolean(selectedSdkProvider) &&
        (!selectedSdkProvider?.endpointRequired || Boolean(manualBaseUrl.trim())) &&
        (!selectedSdkProvider?.requiresModelSelection || sdkModels.split(/[\n,]+/).some((id) => id.trim())));

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
    setManualOAuthMethod("device");
    setOpenAIConnectionMode("subscription");
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
    setEditOAuthMethod("device");
    setIsSavingEdit(false);
    setEditModelOptions([]);
    setEditModelsLive(null);
    setEditModelsError("");
    setEditModelsLoading(false);
  };

  const closeOauthDialog = () => {
    setOauthDialog(null);
    sessionStorage.removeItem("multivibe-oauth-pending");
  };

  const openOAuthDialog = async (options: {
    email: string;
    method: OAuthMethod;
    provider: "openai" | "opencode" | "xai" | "github-copilot";
    mode: "create" | "reauth";
    accountId?: string;
    pendingPriority?: number;
    pendingEnabled?: boolean;
  }) => {
    if (options.method === "browser" && !capabilities.providerBrowserOAuth) throw new Error(t("Browser sign-in is unavailable in this workspace."));
    const result = await startOAuth(
      options.email,
      options.accountId,
      options.method,
      options.provider,
    );
    const flowId = result?.flowId as string | undefined;
    if (!flowId) throw new Error(t("Missing OAuth flow details from start response"));

    const authorizeUrl = String(result?.authorizeUrl ?? "");
    const expectedRedirectUri =
      (result?.expectedRedirectUri as string | undefined) || oauthRedirectUri;
    const verificationUrl = String(result?.verificationUrl ?? "");
    const userCode = String(result?.userCode ?? "");

    if (options.method === "browser" && !authorizeUrl) {
      throw new Error(t("Missing browser OAuth authorize URL from start response"));
    }
    if (options.method === "device" && (!verificationUrl || !userCode)) {
      throw new Error(t("Missing device code details from start response"));
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
    // Persist only the non-sensitive, post-callback settings that the completion
    // handler actually reads back (see App.tsx). The OAuth flow id and sign-in
    // method are deliberately excluded so no credential-bearing value is written
    // to sessionStorage in clear text.
    sessionStorage.setItem(
      "multivibe-oauth-pending",
      JSON.stringify({
        mode: options.mode,
        accountId: options.accountId,
        pendingPriority: options.pendingPriority,
        pendingEnabled: options.pendingEnabled,
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
    if (usesOAuthConnection) {
      if (provider === "openai" && !manualEmail.trim()) return;
      setIsSubmitting(true);
      try {
        await openOAuthDialog({
          email: manualEmail.trim(),
          method: (provider === "xai" || provider === "github-copilot") ? "device" : manualOAuthMethod,
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

    if (!manualAccessToken.trim()) return;
    if ((provider === "openai-compatible") && !manualBaseUrl.trim()) return;
    setIsSubmitting(true);
    try {
      const accountTarget = providerAccountTarget(provider, sdkProvider, openAIConnectionMode);
      await createAccount(providerMutationFields({
        provider: accountTarget.provider,
        sdkProvider: accountTarget.sdkProvider,
        sdkModels: accountTarget.provider === "ai-sdk" && !usesOpenAIAPIKey ? sdkModels.split(/[\n,]+/).map((id) => id.trim()).filter(Boolean) : undefined,
        email: manualEmail.trim() || undefined,
        accessToken: manualAccessToken.trim(),
        refreshToken: manualRefreshToken.trim() || undefined,
        baseUrl:
          provider === "openai-compatible" || provider === "ai-sdk" && selectedSdkProvider?.endpointPlaceholder ? manualBaseUrl.trim() || undefined : undefined,
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
      }, capabilities, "create"));
      closeModal();
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (account: Account) => {
    setOpenMenu(null);
    const nextProvider: AccountProvider =
      account.provider === "github-copilot" ? "github-copilot" :
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
      sdkProvider: account.sdkProvider,
      sdkModels: account.sdkModels?.join(", ") ?? "",
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
    setEditOAuthMethod("device");
    if (account.provider === "ai-sdk" && capabilities.providerModelDiscovery) void loadAccountProviderModels(account.id);
    else { setEditModelOptions(sdkProviders.find(item => item.id === account.sdkProvider)?.models ?? []); setEditModelsLive(null); setEditModelsError(""); }
  };

  const saveEditedAccount = async () => {
    if (!editingAccount) return;
    if (capabilities.providerCredentialEditing && isOAuthProvider(editingAccount.provider)) {
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
            (editingAccount.provider === "xai" || editingAccount.provider === "github-copilot") ? "device" : editOAuthMethod,
          provider: editingAccount.provider,
          mode: "reauth",
          accountId: editingAccount.id,
        });
      } finally {
        setIsSavingEdit(false);
      }
      return;
    }

    if (capabilities.providerCredentialEditing && !editingAccount.accessToken.trim()) return;
    if (
      capabilities.providerUpstreamSettings && (editingAccount.provider === "openai-compatible" || editingAccount.provider === "ai-sdk" && editingSdkProvider?.endpointRequired) &&
      !editingAccount.baseUrl.trim()
    )
      return;
    setIsSavingEdit(true);
    try {
      await patch(editingAccount.id, providerMutationFields({
        email: editingAccount.email.trim() || undefined,
        accessToken: editingAccount.accessToken.trim(),
        refreshToken: editingAccount.refreshToken.trim() || undefined,
        baseUrl:
          editingAccount.provider === "openai-compatible" || editingAccount.provider === "ai-sdk" && editingSdkProvider?.endpointPlaceholder
            ? editingAccount.baseUrl.trim()
            : undefined,
        sdkModels: editingAccount.provider === "ai-sdk" ? editingAccount.sdkModels.split(/[\n,]+/).map((id) => id.trim()).filter(Boolean) : undefined,
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
      }, capabilities, "update"));
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
        (capabilities.providerPriority && (oauthDialog.pendingPriority ?? 0) !== 0 ||
          oauthDialog.pendingEnabled === false)
      ) {
        await patch(accountId, providerMutationFields({
          priority: oauthDialog.pendingPriority ?? 0,
          enabled: oauthDialog.pendingEnabled ?? true,
        }, capabilities, "update"));
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
        t("This OpenAI account has no email, so reauth cannot be started."),
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

  const reauthAccountWithDeviceCode = async (account: Account) => {
    setOpenMenu(null);
    if ((account.provider ?? "openai") !== "openai") return;
    if (!account.email?.trim()) {
      window.alert(
        t("This OpenAI account has no email, so reauth cannot be started."),
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
    if (provider !== "xai" && provider !== "github-copilot") return;

    setOpenMenu(null);
    setOauthBusyId(account.id);
    try {
      await openOAuthDialog({
        email: account.email?.trim() ?? "",
        method: "device",
        provider,
        mode: "reauth",
        accountId: account.id,
      });
    } finally {
      setOauthBusyId(null);
    }
  };

  const openAiCount = accounts.filter(
    (account) => capabilities.host && (account.provider ?? "openai") === "openai" && account.actions?.quotaReset !== false,
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
    void api("quota-reset-forecast")
      .then((result) => {
        if (cancelled) return;
        const rawForecast = result?.forecast;
        const score = Number(rawForecast?.score);
        if (!Number.isFinite(score) || score < 0 || score > 100) {
          throw new Error(translate("Invalid quota reset forecast"));
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
  const quotaTrackedAccounts = accounts.filter(tracksSubscriptionQuota);
  const usageCheckedCount = quotaTrackedAccounts.filter((account) => Boolean(account.usage)).length;
  const usageUnsupportedCount = quotaTrackedAccounts.filter(
    (account) => account.usage?.quotaStatus === "unsupported",
  ).length;
  const usageRefreshPendingCount = quotaTrackedAccounts.filter(
    (account) =>
      account.usage?.quotaStatus !== "unsupported" &&
      typeof account.usage?.fetchedAt === "number" &&
      Date.now() - account.usage.fetchedAt >= usageCacheTtlMs,
  ).length;
  const hasAnyProvider = accounts.length > 0;

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
          <small>{unsupported ? t("Not exposed") : stale ? t("Stale · {value}", { value: fmt(resetAt) }) : fmt(resetAt)}</small>
        </div>
        <div className="mini-progress">
          <span style={{ width: `${safeValue}%` }} />
        </div>
      </div>
    );
  };

  return (
    <>
      {hasAnyProvider && (
        <>
      <WidgetGrid storageKey="providers" label={t("Provider metrics")}>
        <Metric widgetId="providers"
          title={t("Providers")}
          value={`${accounts.length}`}
          detail={t("Total configured providers")}
        />
        <Metric widgetId="enabled"
          title={t("Enabled")}
          value={`${enabledCount}`}
          detail={t("Available for routing")}
          tone="success"
        />
        <Metric widgetId="blocked" required
          title={t("Blocked")}
          value={`${blockedCount}`}
          detail={t("Need manual review or quota reset")}
          tone={blockedCount > 0 ? "warning" : "default"}
        />
        <Metric widgetId="top-model"
          title={t("Top model")}
          value={traceStats.models[0]?.model ?? "-"}
          detail={t("Highest volume in the selected range")}
        />
        {openAiCount > 0 && (
          <Metric widgetId="quota-reset-forecast"
            title={t("Will Codex reset?")}
            value={quotaResetForecastStatus === "ready" && quotaResetForecast
              ? `${Math.round(quotaResetForecast.score)}%` : "—"}
            loading={quotaResetForecastStatus === "loading"}
            detail={quotaResetForecastStatus === "error"
              ? t("Forecast unavailable")
              : t("Chance of a reset · Unofficial forecast for the next {hours} hours.", { hours: quotaResetForecast?.horizonHours ?? 48 })}
            action={{ href: CODEX_QUOTA_RESET_FORECAST_URL, label: t("View forecast") }}
          />
        )}
      </WidgetGrid>
        </>
      )}

      <section className={hasAnyProvider ? "panel providers-list-panel" : "panel providers-empty-state"}>
        <div className="section-split-header">
          <h2>{accounts.length ? t("Connected providers") : t("Providers")}</h2>
          <div className="inline wrap">
            <details className="provider-list-summary"><summary>{t("{count} connections", { count: accounts.length })}</summary><div className="inline wrap">
            {openAiCount > 0 && (
              <span className="badge">{openAiCount} OpenAI</span>
            )}
            {openAiCompatibleCount > 0 && (
              <span className="badge">
                {openAiCompatibleCount} OpenAI-compatible
              </span>
            )}
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

            {quotaTrackedAccounts.length > 0 && (
              <span className="badge">
                {t("{checked}/{total} usage checked", { checked: usageCheckedCount, total: quotaTrackedAccounts.length })}
              </span>
            )}
            {usageUnsupportedCount > 0 && (
              <span className="badge">
                {t("{count} usage not exposed", { count: usageUnsupportedCount })}
              </span>
            )}
            {usageRefreshPendingCount > 0 && (
              <span className="badge badge-warn">
                {t("{count} refresh pending", { count: usageRefreshPendingCount })}
              </span>
            )}
            </div></details>
            {hasAnyProvider && <button className="btn" onClick={() => setShowAddAccount(true)}>{t("Add provider")}</button>}
          </div>
        </div>
        {capabilities.cloudConnection && !accounts.some((account) => account.multivibeCloud) && (
          <article className="local-worker-provider multivibe-cloud-provider" aria-labelledby="multivibe-cloud-provider-title">
            <div className="local-worker-provider-identity">
              <img className="local-worker-provider-icon" src="/assets/brand/multivibe-app-icon.svg" alt="" />
              <div>
                <h3 id="multivibe-cloud-provider-title">MultiVibe Cloud</h3>
                {multivibeCloud.status === "unavailable" && <p className="muted">{t("Connection temporarily unavailable. Host will retry automatically.")}</p>}
                {cloudError && <p className="account-inline-error" role="alert">{cloudError}</p>}
              </div>
            </div>
            <div className="local-worker-provider-actions">
              <button className="btn" onClick={() => void connectCloud()} disabled={cloudBusy || multivibeCloud.status === "unavailable"}>
                {cloudBusy ? t("Connecting…") : t("Connect")}
              </button>
            </div>
          </article>
        )}

        {!accounts.length ? (
          <div className="empty-state-content">
            <span className="empty-state-icon" aria-hidden="true">+</span>
            <h3>{t("Connect your first provider")}</h3>
            <p className="muted">{t("Add a hosted account or a local OpenAI-compatible endpoint. MultiVibe will discover its models and make them ready for routing.")}</p>
            <button className="btn" onClick={() => setShowAddAccount(true)}>{t("Add a provider")}</button>
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
              ["openai", "opencode", "xai", "github-copilot"].includes(a.provider ?? "openai");
            return (
              <article
                key={a.id}
                className={`provider-card${isCloud ? " provider-card-cloud" : ""}${needsReauthentication ? " provider-card-needs-reauth" : ""}`}
              >
                {needsReauthentication && a.actions?.reauthenticate !== false && (
                  <div
                    className="account-reauth-banner"
                    role="status"
                    aria-label={t("This account needs to be reconnected")}
                  >
                    <span>{t("This account needs to be reconnected")}</span>
                    <button
                      type="button"
                      className="btn account-reauth-button"
                      disabled={oauthBusyId === a.id}
                      onClick={() => void reauthOAuthAccount(a)}
                    >
                      {oauthBusyId === a.id ? t("Opening...") : t("Reauth this account")}
                    </button>
                  </div>
                )}
                <div className="provider-card-header">
                  <div className="provider-card-identity">
                    <span className="provider-badge">
                      <img
                        className="provider-icon"
                        src={runtimeIdentity.iconUrl}
                        alt={t("{name} icon", { name: runtimeIdentity.label })}
                        loading="lazy"
                      />
                      {runtimeIdentity.label}
                    </span>
                    {(!isCloud || a.email) && <strong className="provider-card-account-name">
                      {sanitized ? maskEmail(a.email) : (a.email ?? t("No email set"))}
                    </strong>}
                    <span className={`provider-card-status badge ${a.enabled ? "badge-live" : "badge-warn"}`}>
                      {a.enabled ? t("Enabled") : t("Disabled")}
                    </span>
                    <span className={`provider-card-location badge${a.location === "local" ? " badge-live" : ""}`}>
                      {a.location === "local" ? t("Local") : a.location === "cloud" ? t("Cloud") : (a.location ?? t("Cloud"))}
                    </span>
                    {!isCloud && tracksSubscriptionQuota(a) && (
                      <span className="provider-card-usage mono muted">
                        {usageSummaryLabel(a, usageCacheTtlMs)}
                      </span>
                    )}
                  </div>
                  <div className="account-actions-cell">
                      <button
                        className="icon-menu-btn"
                        aria-label={t("Open actions for {account}", { account: a.email ?? a.id })}
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
                              disabled={a.actions?.edit === false}
                              onClick={() => openEditModal(a)}
                            >
                              {t("Modify parameters")}
                            </button>
                            <button
                              className="account-action-item"
                              disabled={a.actions?.edit === false}
                              onClick={() => {
                                setOpenMenu(null);
                                if (a.actions?.edit !== false) void patch(a.id, { enabled: !a.enabled });
                              }}
                            >
                              {a.enabled ? t("Disable") : t("Enable")}
                            </button>
                            <button
                              className="account-action-item"
                              disabled={a.actions?.unblock === false}
                              onClick={() => {
                                setOpenMenu(null);
                                if (a.actions?.unblock !== false) void unblock(a.id);
                              }}
                            >
                              {t("Unblock")}
                            </button>
                            {!isCloud && tracksSubscriptionQuota(a) && a.actions?.refreshUsage !== false && (
                              <button
                                className="account-action-item"
                                onClick={() => {
                                  setOpenMenu(null);
                                  void refreshUsage(a.id);
                                }}
                              >
                                {t("Refresh usage")}
                              </button>
                            )}
                            {capabilities.host && ((isOpenAiAccount(a) && a.enabled) ||
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
                                  ? t("Clear default passthrough")
                                  : t("Set as default passthrough")}
                              </button>
                            )}
                            {isOpenAiAccount(a) && a.actions?.quotaReset !== false && (
                              <button
                                className="account-action-item"
                                onClick={() => {
                                  setOpenMenu(null);
                                  void consumeRateLimitResetCredit(a.id);
                                }}
                              >
                                {t("Use rate-limit reset credit")}
                              </button>
                            )}
                            {isOpenAiAccount(a) && a.actions?.reauthenticate !== false ? (
                              <>
                                <button
                                  className="account-action-item"
                                  disabled={oauthBusyId === a.id}
                                  onClick={() => void reauthAccount(a)}
                                >
                                  {oauthBusyId === a.id
                                    ? t("Opening...")
                                    : t("Reauth")}
                                </button>
                                <button
                                  className="account-action-item"
                                  disabled={oauthBusyId === a.id}
                                  onClick={() =>
                                    void reauthAccountWithDeviceCode(a)
                                  }
                                >
                                  {t("Device-code reauth")}
                                </button>
                              </>
                            ) : !isCloud && (
                              <>
{capabilities.providerCredentialEditing && <button
                                  className="account-action-item"
                                  disabled={a.actions?.edit === false}
                              onClick={() => openEditModal(a)}
                                >
                                  {t("Change key")}
                                </button>}
                                {a.provider === "opencode" && a.actions?.reauthenticate !== false && (
                                  <button
                                    className="account-action-item"
                                    disabled={oauthBusyId === a.id}
                                    onClick={() => void reauthOpenCodeAccount(a)}
                                  >
                                    {oauthBusyId === a.id
                                      ? t("Opening...")
                                      : t("OpenCode device reauth")}
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              className="account-action-item account-action-item-danger"
                              onClick={() => {
                                setOpenMenu(null);
                                if (isCloud && capabilities.cloudConnection) void disconnectCloud();
                                else void del(a.id);
                              }}
                              disabled={a.actions?.delete === false || (isCloud && (cloudBusy || !capabilities.cloudConnection))}
                            >
                              {isCloud ? t("Disconnect") : t("Delete")}
                            </button>
                          </div>,
                          document.body,
                        )}
                  </div>
                </div>
                {isCloud ? (
                  <div className="provider-card-content cloud-provider-content">
                    <div className="cloud-provider-balance">
                      <span className="muted">{t("Available balance")}</span>
                      <strong>
                        {multivibeCloud.status === "connected" && multivibeCloud.balanceUsd !== undefined
                          ? t("{amount} credits", { amount: Number(multivibeCloud.balanceUsd).toLocaleString(undefined, { maximumFractionDigits: 2 }) })
                          : t("Balance unavailable")}
                      </strong>
                      {multivibeCloud.subscription && <span className="muted">{multivibeCloud.subscription}</span>}
                      {multivibeCloud.status === "unavailable" && <span className="muted">{t("Reconnecting automatically…")}</span>}
                      {multivibeCloud.status === "disconnected" && <span className="muted">{t("Reconnect to refresh your Cloud session.")}</span>}
                      {cloudError && <p className="account-inline-error" role="alert">{cloudError}</p>}
                    </div>
                    <div className="local-worker-provider-actions">
                      <a className="btn" href={multivibeCloud.topupUrl} target="_blank" rel="noreferrer">
                        {t("Manage plan & add credits")}
                      </a>
                      {capabilities.cloudConnection && multivibeCloud.status === "disconnected" && (
                        <button className="btn secondary" type="button" onClick={() => void connectCloud()} disabled={cloudBusy}>{t("Reconnect")}</button>
                      )}
                    </div>
                  </div>
                ) : <div className="provider-card-content">
                  {(a.baseUrl || a.upstreamMode || a.capacityProfile || isOpenAiAccount(a) || (a.provider === "opencode" && a.opencodeOrgName)) && <details className="provider-card-details provider-connection-details"><summary>{a.state?.scheduledWeeklyReset?.lastError ? t("Settings · auto-reset failed") : a.state?.scheduledWeeklyReset ? t("Settings · auto-reset scheduled") : t("Connection settings")}</summary>
                    {(a.baseUrl || a.upstreamMode || (a.provider === "opencode" && a.opencodeOrgName)) && (
                      <div className="provider-card-endpoint">
                        {a.baseUrl && <span className="mono muted">{a.baseUrl}</span>}
                        {a.upstreamMode && <span className="mono muted">{t("upstream: {mode}", { mode: a.upstreamMode })}</span>}
                        {a.provider === "opencode" && a.opencodeOrgName && (
                          <span className="mono muted">{t("organization: {name}", { name: a.opencodeOrgName })}</span>
                        )}
                      </div>
                    )}
                    {a.capacityProfile && (
                      <span className="mono muted">
                        {t("capacity: {slots} slots · {prefill} prefill tok/s · {decode} decode tok/s · {ctx} ctx", {
                          slots: a.capacityProfile.maxConcurrent ?? "?",
                          prefill: a.capacityProfile.prefillTokensPerSecond ?? "?",
                          decode: a.capacityProfile.decodeTokensPerSecond ?? "?",
                          ctx: a.capacityProfile.contextWindow ?? "?",
                        })}
                      </span>
                    )}
                    {isOpenAiAccount(a) && a.actions?.quotaReset !== false && (
                      <div className="reset-quota-actions">
                        <button
                          className="btn secondary reset-quota-btn"
                          onClick={async () => {
                            await consumeRateLimitResetCredit(a.id);
                            setResetCreditRefresh((current) => current + 1);
                          }}
                        >
                          {t("Reset quota now (available: {count})", { count: resetCredits[a.id] ?? "—" })}
                        </button>
                        {a.state?.scheduledWeeklyReset ? (
                          <>
                            <span className="badge badge-live">{t("Auto-reset scheduled at 0.5% remaining")}</span>
                            {a.state.scheduledWeeklyReset.lastError && (
                              <small className="reset-quota-error">
                                {t("Last attempt failed: {error}", { error: a.state.scheduledWeeklyReset.lastError })}
                              </small>
                            )}
                            <button
                              className="btn secondary reset-quota-btn"
                              onClick={() => void cancelScheduledRateLimitResetCredit(a.id)}
                            >
                              {t("Cancel auto-reset")}
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn secondary reset-quota-btn"
                            onClick={() => void scheduleRateLimitResetCredit(a.id)}
                          >
                            {t("Auto-reset at 0.5% remaining")}
                          </button>
                        )}
                      </div>
                    )}
                  </details>}
                  {tracksSubscriptionQuota(a) && (
                    <>
                      <div className="provider-quota-grid" aria-label={t("Quota usage")}>
                        {a.usage?.quotaStatus !== "unsupported" && shouldDisplayOptionalQuotaWindow(a, "primary") && (
                          <div className="provider-quota-item">
                            <span className="provider-quota-label">{t("5h quota")}</span>
                            {renderUsageCell(a.usage?.primary?.usedPercent, a.usage?.primary?.resetAt, a.usage?.quotaStatus === "unsupported", a.usage?.quotaStatus === "error")}
                          </div>
                        )}
                        {a.usage?.quotaStatus !== "unsupported" && shouldDisplayOptionalQuotaWindow(a, "secondary") && (
                          <div className="provider-quota-item">
                            <span className="provider-quota-label">{t("Weekly quota")}</span>
                            {renderUsageCell(a.usage?.secondary?.usedPercent, a.usage?.secondary?.resetAt, a.usage?.quotaStatus === "unsupported", a.usage?.quotaStatus === "error")}
                          </div>
                        )}
                        {a.usage?.quotaStatus !== "unsupported" && shouldDisplayOptionalQuotaWindow(a, "monthly") && (
                          <div className="provider-quota-item">
                            <span className="provider-quota-label">{a.usage?.monthly?.label ?? t("Monthly quota")}</span>
                            {renderUsageCell(a.usage?.monthly?.usedPercent, a.usage?.monthly?.resetAt, a.usage?.quotaStatus === "unsupported", a.usage?.quotaStatus === "error")}
                          </div>
                        )}
                        {a.usage?.codexCredits && (
                          <div className="provider-quota-item">
                            <span className="provider-quota-label">{t("Codex credits")}</span>
                            <span>
                              {a.usage.codexCredits.unlimited === true ? t("Unlimited")
                                : typeof a.usage.codexCredits.remaining === "number"
                                  ? t("{amount} credits", { amount: a.usage.codexCredits.remaining.toLocaleString(undefined, { maximumFractionDigits: 2 }) })
                                  : a.usage.codexCredits.hasCredits === false ? t("No credits") : t("Unavailable")}
                              {a.usage.quotaStatus === "error" ? ` ${t("(stale)")}` : ""}
                            </span>
                          </div>
                        )}
                        {a.usage?.balance && (
                          <div className="provider-quota-item">
                            <span className="provider-quota-label">{t("Available balance")}</span>
                            <span>{Number(a.usage.balance.remaining).toLocaleString()} {a.usage.balance.unit}{a.usage.quotaStatus === "error" ? ` ${t("(stale)")}` : ""}</span>
                          </div>
                        )}
                        {a.usage?.credits && (
                          <div className="provider-quota-item">
                            <span className="provider-quota-label">{a.usage.credits.label ?? t("Subscription credits")}</span>
                            {renderUsageCell(a.usage.credits.usedPercent, a.usage.credits.resetAt, false, a.usage.quotaStatus === "error")}
                          </div>
                        )}
                        {a.usage?.spend && (
                          <div className="provider-quota-item">
                            <span className="provider-quota-label">{t("API key spend")}</span>
                            <span>{Number(a.usage.spend.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} {a.usage.spend.unit}{a.usage.quotaStatus === "error" ? ` ${t("(stale)")}` : ""}</span>
                          </div>
                        )}
                        {a.usage?.allowances?.map((window: { label: string; usedPercent?: number; resetAt?: number }) => (
                          <div className="provider-quota-item" key={window.label}>
                            <span className="provider-quota-label">{window.label}</span>
                            {renderUsageCell(window.usedPercent, window.resetAt, false, a.usage.quotaStatus === "error")}
                          </div>
                        ))}
                        {a.usage?.tools && (
                          <div className="provider-quota-item">
                            <span className="provider-quota-label">{t("MCP tools quota")}</span>
                            {renderUsageCell(a.usage.tools.usedPercent, a.usage.tools.resetAt, false, a.usage.quotaStatus === "error")}
                          </div>
                        )}
                      </div>
                      {a.usage?.quotaMessage && (
                        <p className="muted">{a.usage.quotaMessage}</p>
                      )}
                    </>
                  )}
                </div>}
                {(!isCloud || (modelsByAccount.get(a.id)?.length ?? 0) > 0) && (
                  <AccountModelsSection
                    accountLabel={runtimeIdentity.label}
                    models={modelsByAccount.get(a.id) ?? []}
                    onRefresh={onRefreshModels}
                  />
                )}
                {modelBlocks.length > 0 && (
                  <div className="state-stack provider-card-blocks">
                    {modelBlocks.map(([model, block]) => (
                      <span className="badge badge-warn" key={model}>
                        {t("{model} blocked until {time}", { model, time: fmt(block.until) })}
                      </span>
                    ))}
                  </div>
                )}
                {a.state?.lastError && (
                  <div className="provider-card-footer">
                    <div className="provider-card-error">
                      <span className="provider-card-label">{t("Last error")}</span>
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



      {showAddAccount && !oauthDialog && (
        <ModalPortal><div className="modal-backdrop" onClick={() => { if (!isSubmitting) closeModal(); }}>
          <div ref={providerModalRef} className={`modal panel provider-setup-modal${providerStep === 0 ? " provider-setup-modal-picker" : ""}${onboardingProviderSetup ? " onboarding-provider-modal" : ""}`} role="dialog" aria-modal="true" aria-label={providerStep === 0 ? t("Choose your provider") : undefined} aria-labelledby={providerStep > 0 ? "provider-setup-title" : undefined} tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={(event) => {
            if (event.key === "Escape" && !isSubmitting) { event.stopPropagation(); closeModal(); }
            if (event.key === "Tab") {
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [href]')).filter((item) => item.getClientRects().length > 0);
              const first = items[0], last = items[items.length - 1];
              if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}>
            <div className="provider-setup-topbar">
              <span className="provider-setup-heading">{providerStep === 0 ? t("Add a provider") : t("Connect your provider")}</span>
              <div className="inline wrap">
                {onboardingProviderSetup && (
                  <button className="btn ghost" disabled={isSubmitting} onClick={() => {
                    closeModal();
                    onSkipOnboarding?.();
                  }}>
                    {t("Skip setup")}
                  </button>
                )}
                <button className="btn ghost" disabled={isSubmitting} onClick={closeModal}>
                  {onboardingProviderSetup ? t("Back") : t("Close")}
                </button>
              </div>
            </div>
            {providerStep > 0 && <div className="provider-setup-heading">
              <ProviderMark provider={provider} sdkProvider={sdkProvider} />
              <div><h2 id="provider-setup-title">{providerStep === 1 ? t("Connect {provider}", { provider: String(selectedProviderName) }) : t("Ready to connect?")}</h2>
              <p className="muted">{providerStep === 1 ? t("Enter your connection details to continue.") : t("Check your connection and customize routing if needed.")}</p></div>
            </div>}
            {providerStep === 0 && <ProviderPicker value={provider} sdkProvider={sdkProvider} cloudProviders={sdkProviders} error={sdkCatalogError} onChange={selectProvider} />}
            {providerStep === 1 && <div className="grid modal-grid provider-connection-fields provider-setup-fields">

              {provider === "openai" && <label>
                {t("Connection type")}
                <select value={openAIConnectionMode} onChange={(event) => {
                  setOpenAIConnectionMode(event.target.value as OpenAIConnectionMode);
                  setManualAccessToken("");
                  setProviderError("");
                }}>
                  <option value="subscription">{t("ChatGPT / Codex subscription")}</option>
                  <option value="api-key">{t("OpenAI API key")}</option>
                </select>
              </label>}
              <label>
                {provider === "openai" && openAIConnectionMode === "subscription" ? t("Email") : t("Email (optional)")}
                <input
                  value={manualEmail}
                  onChange={(e) => setManualEmail(e.target.value)}
                  placeholder="account@email.com"
                />
              </label>
              {usesOAuthConnection && (
                <label>
                  {t("{provider} login method", { provider: oauthProviderLabel(provider) })}
                  <select
                    value={manualOAuthMethod}
                    disabled={provider !== "openai" || !capabilities.providerBrowserOAuth}
                    onChange={(e) =>
                      setManualOAuthMethod(e.target.value as OAuthMethod)
                    }
                  >
                    {capabilities.providerBrowserOAuth && provider === "openai" && (
                      <option value="browser">{t("Browser callback")}</option>
                    )}
                    <option value="device">{t("Device code (recommended)")}</option>
                  </select>
                </label>
              )}
              {provider === "openai" && openAIConnectionMode === "subscription" && manualOAuthMethod === "device" && <ChatGPTDeviceGuide />}
              {(provider === "openai-compatible") && (
                <label>
                  {t("Base URL")}
                  <input
                    value={manualBaseUrl}
                    onChange={(e) => setManualBaseUrl(e.target.value)}
                    placeholder={"https://your-api.example.com"}
                  />
                </label>
              )}
              {provider === "ai-sdk" && <>
                {selectedSdkProvider?.endpointPlaceholder && <label>
                  {selectedSdkProvider.endpointRequired ? t("Provider endpoint (required)") : t("Provider endpoint (optional)")}
                  <input type="url" value={manualBaseUrl} onChange={(event) => setManualBaseUrl(event.target.value)} placeholder={selectedSdkProvider.endpointPlaceholder} />
                </label>}
                <div>
                  <p className="muted">{selectedSdkProvider?.requiresModelSelection ? t("Deployment / model names (required)") : t("Model IDs (optional)")}</p>
                  <ProviderModelPicker
                    providerName={selectedSdkProvider?.name}
                    value={sdkModels}
                    onChange={setSdkModels}
                    options={createModelOptions}
                    requiresSelection={selectedSdkProvider?.requiresModelSelection}
                  />
                </div>
                <p className="muted">{t("Access and pricing depend on your provider account. Subscription quotas are not supplied by the catalog.")}</p>
                {providerAccess(sdkProvider, true) && <p className="muted">{providerAccess(sdkProvider, true)?.note}</p>}
              </>}
              {usesOpenAIAPIKey ? (
                <>
                  <label>
                    {t("OpenAI API key")}
                    <input
                      type="password"
                      autoComplete="off"
                      value={manualAccessToken}
                      onChange={(event) => setManualAccessToken(event.target.value)}
                      placeholder="sk-…"
                    />
                  </label>
                  <p className="provider-setup-note">{t("Requests use {url}. API usage is billed separately from ChatGPT and Codex subscriptions.", { url: "https://api.openai.com/v1" })}</p>
                </>
              ) : (
                <div className="muted">
                  {provider === "github-copilot"
                    ? t("Sign in on GitHub with a one-time device code. Models depend on your Copilot plan and organization policy. Premium request and chat quotas are refreshed when GitHub exposes them.")
                    : provider === "xai"
                    ? t("Grok Build uses xAI device OAuth and the SuperGrok / X Premium+ subscription quota.")
                    : t("Approve a one-time code on OpenAI’s sign-in page. MultiVibe finishes connecting automatically.")}
                </div>
              )}
              {provider === "opencode" && (
                <div className="muted">
                  {t("Enter an API key, or leave it empty to sign in with your OpenCode Console account on the next step. Go API keys support 5h, weekly and monthly quotas. Console device connections may not expose these quotas.")}
                </div>
              )}
            </div>}
            {providerStep === 2 && <>
              <dl className="provider-setup-summary">
                <div><dt>{t("Provider")}</dt><dd>{provider === "ai-sdk" ? sdkProviders.find((item) => item.id === sdkProvider)?.name : SETUP_PROVIDERS.find((item) => item.id === provider)?.name}</dd></div>
                <div><dt>{t("Account")}</dt><dd>{manualEmail.trim() || t("No email label")}</dd></div>
                <div><dt>{t("Connection")}</dt><dd>{usesOAuthConnection ? manualOAuthMethod === "device" ? t("Device sign-in") : t("Browser sign-in") : provider === "opencode" && !manualAccessToken.trim() ? t("OpenCode device sign-in") : t("API key provided")}</dd></div>
                {(usesOpenAIAPIKey || provider === "openai-compatible" || provider === "ai-sdk" && selectedSdkProvider?.endpointPlaceholder) && <div><dt>{t("Endpoint")}</dt><dd>{usesOpenAIAPIKey ? "https://api.openai.com/v1" : manualBaseUrl || selectedSdkProvider?.endpointPlaceholder}</dd></div>}
              </dl>
              {usesOAuthConnection && <p className="provider-setup-note">{t("Next, approve the connection with your provider to finish setup.")}</p>}
              {!onboardingProviderSetup && <details className="provider-setup-advanced"><summary>{t("Advanced settings")} <span>{capabilities.providerCapacity ? t("Routing, priority & capacity") : t("Connection status")}</span></summary><div className="grid modal-grid">
              {!onboardingProviderSetup && capabilities.providerUpstreamSettings && <label>
                {t("Upstream mode (optional)")}
                <select
                  value={manualUpstreamMode}
                  onChange={(e) =>
                    setManualUpstreamMode(
                      e.target.value as "" | "responses" | "chat/completions",
                    )
                  }
                >
                  <option value="">{t("Automatic")}</option>
                  <option value="responses">{t("Force `/v1/responses`")}</option>
                  <option value="chat/completions">
                    {t("Force `/v1/chat/completions`")}
                  </option>
                </select>
              </label>}
              {!onboardingProviderSetup && capabilities.providerCapacity && isManualTokenProvider(provider) && (
                <>
                  <label>{t("Execution location")}<select value={manualLocation} onChange={(e) => setManualLocation(e.target.value as "" | "local" | "personal-cluster" | "cloud")}><option value="">{t("Infer from URL/provider")}</option><option value="local">{t("Local")}</option><option value="personal-cluster">{t("Personal cluster")}</option><option value="cloud">{t("Cloud")}</option></select></label>
                  <label>{t("Concurrent slots")}<input type="number" min="1" value={manualMaxConcurrent} onChange={(e) => setManualMaxConcurrent(e.target.value)} placeholder={t("1 local / 8 cloud")} /></label>
                  <label>{t("Prefill tokens/s")}<input type="number" min="0" value={manualPrefill} onChange={(e) => setManualPrefill(e.target.value)} /></label>
                  <label>{t("Decode tokens/s")}<input type="number" min="0" value={manualDecode} onChange={(e) => setManualDecode(e.target.value)} /></label>
                  <label>{t("Context window")}<input type="number" min="1" value={manualContext} onChange={(e) => setManualContext(e.target.value)} placeholder="262144" /></label>
                  <label>{t("Health URL")}<input type="url" value={manualHealthUrl} onChange={(e) => setManualHealthUrl(e.target.value)} placeholder="http://worker.local:8000/health" /></label>
                  <label>{t("Metrics URL")}<input type="url" value={manualMetricsUrl} onChange={(e) => setManualMetricsUrl(e.target.value)} placeholder={t("Optional JSON metrics")} /></label>
                </>
              )}
              {!onboardingProviderSetup && capabilities.providerPriority && <label>
                {t("Priority")}
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
                {t("Enabled")}
              </label>}
              </div></details>}
            </>}
            {providerError && <p className="provider-setup-error" role="alert">{providerError}</p>}
            <div className="provider-setup-footer">
              <button className="btn ghost" disabled={isSubmitting} onClick={() => { if (providerStep === 0) closeModal(); else { setProviderStep(providerStep - 1); setProviderError(""); } }}>{providerStep === 0 ? t("Cancel") : t("Back")}</button>
              <span className="muted provider-setup-step-count">{t("Step {step} of 3", { step: providerStep + 1 })}</span>
              {providerStep < 2 && <button className="btn" disabled={providerStep === 1 && !providerConnectionReady} onClick={() => setProviderStep(providerStep + 1)}>{t("Continue")} <span aria-hidden="true">→</span></button>}
              {providerStep === 2 && <div className="inline wrap">

              {!(provider === "opencode" && !manualAccessToken.trim()) && <button
                className="btn"
                disabled={
                  isSubmitting || !providerConnectionReady
                }
                onClick={() => { setProviderError(""); void submitManualAccount().catch((error) => setProviderError(error instanceof Error ? error.message : String(error))); }}
              >
                {isSubmitting
                  ? usesOAuthConnection
                    ? t("Starting OAuth...")
                    : t("Creating...")
                  : usesOAuthConnection
                    ? provider === "github-copilot" ? t("Sign in with GitHub") : provider === "xai"
                      ? t("Start Grok device login")
                      : t("Start OAuth")
                    : t("Create account")}
              </button>}
              {capabilities.host && provider === "xai" && (
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
                  {t("Import configured auth.json")}
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
                  {t("Connect OpenCode account")}
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
              <h2>{t("Update account")}</h2>
              <button className="btn ghost" onClick={closeEditModal}>
                {t("Close")}
              </button>
            </div>
            <div className="grid modal-grid provider-connection-fields">
              <label>
                {t("Email (optional)")}
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
              {capabilities.providerCredentialEditing && isOAuthProvider(editingAccount.provider) && (
                <label>
                  {t("{provider} reauth method", { provider: oauthProviderLabel(editingAccount.provider) })}
                  <select
                    value={editOAuthMethod}
                    disabled={editingAccount.provider !== "openai" || !capabilities.providerBrowserOAuth}
                    onChange={(e) =>
                      setEditOAuthMethod(e.target.value as OAuthMethod)
                    }
                  >
                    {capabilities.providerBrowserOAuth && editingAccount.provider === "openai" && (
                      <option value="browser">{t("Browser callback")}</option>
                    )}
                    <option value="device">{t("Device code (recommended)")}</option>
                  </select>
                </label>
              )}
              {capabilities.providerUpstreamSettings && (editingAccount.provider === "openai-compatible" || editingAccount.provider === "ai-sdk" && editingSdkProvider?.endpointPlaceholder) && (
                <label>
                  {t("Base URL")}
                  <input
                    value={editingAccount.baseUrl}
                    onChange={(e) =>
                      setEditingAccount((current) =>
                        current
                          ? { ...current, baseUrl: e.target.value }
                          : current,
                      )
                    }
                    placeholder={editingSdkProvider?.endpointPlaceholder ?? "https://your-api.example.com"}
                  />
                </label>
              )}
              {editingAccount.provider === "ai-sdk" && <div>
                <p className="muted">{editingSdkProvider?.requiresModelSelection ? t("Deployment / model names (required)") : t("Model IDs (optional)")}</p>
                <ProviderModelPicker
                  providerName={editingSdkProvider?.name}
                  value={editingAccount.sdkModels}
                  onChange={(next) => setEditingAccount((current) => current ? { ...current, sdkModels: next } : current)}
                  options={editModelOptions}
                  live={editModelsLive}
                  loading={editModelsLoading}
                  error={editModelsError}
                  onRefresh={capabilities.providerModelDiscovery ? () => { if (editingAccount) void loadAccountProviderModels(editingAccount.id, true); } : undefined}
                  requiresSelection={editingSdkProvider?.requiresModelSelection}
                />
              </div>}
              {capabilities.providerUpstreamSettings && <label>
                {t("Upstream mode (optional)")}
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
                  <option value="">{t("Automatic")}</option>
                  <option value="responses">{t("Force `/v1/responses`")}</option>
                  <option value="chat/completions">
                    {t("Force `/v1/chat/completions`")}
                  </option>
                </select>
              </label>}
              {capabilities.providerCapacity && <><label>{t("Execution location")}<select value={editingAccount.location} onChange={(e) => setEditingAccount((current) => current ? { ...current, location: e.target.value as "local" | "personal-cluster" | "cloud" } : current)}><option value="local">{t("Local")}</option><option value="personal-cluster">{t("Personal cluster")}</option><option value="cloud">{t("Cloud")}</option></select></label>
              <label>{t("Concurrent slots")}<input type="number" min="1" value={editingAccount.maxConcurrent} onChange={(e) => setEditingAccount((current) => current ? { ...current, maxConcurrent: e.target.value } : current)} /></label>
              <label>{t("Prefill tokens/s")}<input type="number" min="0" value={editingAccount.prefillTokensPerSecond} onChange={(e) => setEditingAccount((current) => current ? { ...current, prefillTokensPerSecond: e.target.value } : current)} /></label>
              <label>{t("Decode tokens/s")}<input type="number" min="0" value={editingAccount.decodeTokensPerSecond} onChange={(e) => setEditingAccount((current) => current ? { ...current, decodeTokensPerSecond: e.target.value } : current)} /></label>
              <label>{t("Context window")}<input type="number" min="1" value={editingAccount.contextWindow} onChange={(e) => setEditingAccount((current) => current ? { ...current, contextWindow: e.target.value } : current)} /></label>
              <label>{t("Health URL")}<input type="url" value={editingAccount.healthUrl} onChange={(e) => setEditingAccount((current) => current ? { ...current, healthUrl: e.target.value } : current)} /></label>
              <label>{t("Metrics URL")}<input type="url" value={editingAccount.metricsUrl} onChange={(e) => setEditingAccount((current) => current ? { ...current, metricsUrl: e.target.value } : current)} /></label>
              </>}
              {capabilities.providerCredentialEditing && (isManualTokenProvider(editingAccount.provider) ? (
                <>
                  <label>
                    {t("API key")}
                    <input
                      type="password" autoComplete="off"
                      value={editingAccount.accessToken}
                      onChange={(e) =>
                        setEditingAccount((current) =>
                          current
                            ? { ...current, accessToken: e.target.value }
                            : current,
                        )
                      }
                      placeholder={t("Required")}
                    />
                  </label>
                  <label>
                    {t("Refresh token (optional)")}
                    <input
                      type="password" autoComplete="off"
                      value={editingAccount.refreshToken}
                      onChange={(e) =>
                        setEditingAccount((current) =>
                          current
                            ? { ...current, refreshToken: e.target.value }
                            : current,
                        )
                      }
                      placeholder={t("Optional")}
                    />
                  </label>
                </>
              ) : (
                <div className="muted">
                  {editingAccount.provider === "github-copilot"
                    ? t("Sign in again on GitHub and approve the one-time device code.")
                    : editingAccount.provider === "xai"
                    ? t("Grok Build reauth uses xAI device OAuth. Save changes, then approve the one-time code.")
                    : t("Save changes to start sign-in. Approve the one-time code, or paste the callback URL if you chose browser callback.")}
                </div>
              ))}
              {capabilities.providerPriority && <label>
                {t("Priority")}
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
              </label>}
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
                {t("Enabled")}
              </label>
            </div>
            <div className="inline wrap">
              <button
                className="btn"
                disabled={
                  isSavingEdit ||
                  (capabilities.providerCredentialEditing && isOAuthProvider(editingAccount.provider)
                    ? editingAccount.provider === "openai" &&
                      !editingAccount.email.trim()
                    : capabilities.providerCredentialEditing && !editingAccount.accessToken.trim() ||
                      (capabilities.providerUpstreamSettings && (editingAccount.provider === "openai-compatible" || editingAccount.provider === "ai-sdk" && editingSdkProvider?.endpointRequired) &&
                        !editingAccount.baseUrl.trim()) ||
                      (editingAccount.provider === "ai-sdk" && editingSdkProvider?.requiresModelSelection && !editingAccount.sdkModels.split(/[\n,]+/).some((id) => id.trim())))
                }
                onClick={() => void saveEditedAccount()}
              >
                {isSavingEdit
                  ? capabilities.providerCredentialEditing && isOAuthProvider(editingAccount.provider)
                    ? t("Starting OAuth...")
                    : t("Saving...")
                  : capabilities.providerCredentialEditing && isOAuthProvider(editingAccount.provider)
                    ? editingAccount.provider === "xai"
                      ? t("Start Grok reauth")
                      : t("Start reauth")
                    : t("Save changes")}
              </button>
              <button className="btn ghost" onClick={closeEditModal}>
                {t("Cancel")}
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
                  ? t("Complete {provider} OAuth", { provider: oauthProviderLabel(oauthDialog.provider) })
                  : t("Complete {provider} reauth", { provider: oauthProviderLabel(oauthDialog.provider) })}
              </h2>
              <div className="inline wrap">
                {onboardingProviderSetup && (
                  <button className="btn ghost" onClick={() => {
                    closeOauthDialog();
                    closeModal();
                    onSkipOnboarding?.();
                  }}>
                    {t("Skip setup")}
                  </button>
                )}
                <button className="btn ghost" onClick={closeOauthDialog}>
                  {t("Close")}
                </button>
              </div>
            </div>
            {oauthDialog.pollingError && <p role="alert">{oauthDialog.pollingError}</p>}
            <div className="grid modal-grid">
              <label>
                {oauthDialog.provider !== "openai" ? t("Email (from provider after approval)") : t("Email")}
                <input value={oauthDialog.email} disabled />
              </label>
              {oauthDialog.provider === "openai" && oauthDialog.method === "device" && <ChatGPTDeviceGuide />}
              {oauthDialog.method === "device" ? (
                <>
                  <label>
                    {t("Verification URL")}
                    <input value={oauthDialog.verificationUrl ?? ""} disabled />
                  </label>
                  <label>
                    {t("Device code")}
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
                    {t("Redirect URI")}
                    <input value={oauthDialog.expectedRedirectUri} disabled />
                  </label>
                  <label>
                    {t("Callback URL")}
                    <textarea
                      value={oauthDialog.callbackInput}
                      onChange={(e) =>
                        setOauthDialog((current) =>
                          current
                            ? { ...current, callbackInput: e.target.value }
                            : current,
                        )
                      }
                      placeholder={t("Paste the full URL after the browser reaches the callback page")}
                      rows={5}
                    />
                  </label>
                </>
              )}
            </div>
            <div className="muted">
              {oauthDialog.method === "device"
                ? t("Open the verification URL, enter the one-time code, and approve the {provider} login. This dialog will complete automatically after approval. Do not share this code.", {
                    provider: oauthDialog.provider === "github-copilot" ? "GitHub" : oauthDialog.provider === "xai"
                      ? "xAI"
                      : oauthDialog.provider === "opencode"
                        ? "OpenCode"
                        : "OpenAI",
                  })
                : t("Complete the OpenAI login in the opened browser tab. When the browser reaches the callback page, copy the full URL and paste it here. Do not paste access or refresh tokens.")}
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
                  ? t("Open verification page")
                  : t("Open login page")}
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
                    ? t("Completing...")
                    : t("Complete OAuth")}
                </button>
              ) : (
                <button className="btn" disabled>
                  {oauthDialog.isSubmitting
                    ? t("Checking...")
                    : t("Waiting for approval")}
                </button>
              )}
              <button className="btn ghost" onClick={closeOauthDialog}>
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div></ModalPortal>
      )}
    </>
  );
}
