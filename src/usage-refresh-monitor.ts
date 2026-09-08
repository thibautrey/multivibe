import { isDeepStrictEqual } from "node:util";
import {
  OPENCODE_BASE_URL,
  USAGE_REFRESH_INTERVAL_MS,
  XAI_BASE_URL,
} from "./config.js";
import { ensureValidToken } from "./account-utils.js";
import type { OAuthConfig } from "./oauth.js";
import {
  isUsageRefreshNeeded,
  normalizeProvider,
} from "./quota.js";
import type { Account, AccountState } from "./types.js";
import { AccountStore } from "./store.js";
import { UsageRefreshCoordinator } from "./usage-refresh.js";

const DEFAULT_MAX_CONCURRENT_REFRESHES = 4;

export type UsageRefreshMonitorOptions = {
  store: AccountStore;
  oauthConfig: OAuthConfig;
  openaiBaseUrl: string;
  mistralBaseUrl: string;
  zaiBaseUrl: string;
  opencodeBaseUrl?: string;
  xaiBaseUrl?: string;
  intervalMs?: number;
  maxConcurrentRefreshes?: number;
  coordinator?: UsageRefreshCoordinator;
  logger?: {
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
};

export type UsageRefreshCycleResult = {
  checked: number;
  refreshed: number;
  failed: number;
  skipped: number;
};

export type UsageRefreshMonitor = {
  start(): void;
  stop(): void;
  refreshNow(): Promise<UsageRefreshCycleResult>;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function usageBaseUrl(
  account: Account,
  options: UsageRefreshMonitorOptions,
): string {
  switch (normalizeProvider(account)) {
    case "openai-compatible":
      return trimTrailingSlash(String(account.baseUrl ?? ""));
    case "opencode":
      return trimTrailingSlash(account.baseUrl ?? options.opencodeBaseUrl ?? OPENCODE_BASE_URL);
    case "mistral":
      return options.mistralBaseUrl;
    case "zai":
      return options.zaiBaseUrl;
    case "xai":
      return trimTrailingSlash(account.baseUrl ?? options.xaiBaseUrl ?? XAI_BASE_URL);
    default:
      return options.openaiBaseUrl;
  }
}

const TOKEN_FIELDS = ["accessToken", "refreshToken", "expiresAt"] as const;
const STATE_FIELDS = [
  "lastError",
  "recentErrors",
  "needsTokenRefresh",
  "authBlockedUntil",
] as const;

function changedFieldsPatch<T extends object, K extends keyof T>(
  source: T,
  updated: T,
  latest: T,
  fields: readonly K[],
): Partial<Pick<T, K>> {
  const patch: Partial<Pick<T, K>> = {};
  for (const field of fields) {
    // Do not overwrite a newer concurrent mutation. This lets a background
    // probe update only the fields that were unchanged when it started.
    if (
      !isDeepStrictEqual(updated[field], source[field]) &&
      isDeepStrictEqual(latest[field], source[field])
    ) {
      patch[field] = updated[field];
    }
  }
  return patch;
}

async function refreshOneAccount(
  account: Account,
  options: UsageRefreshMonitorOptions,
  coordinator: UsageRefreshCoordinator,
): Promise<"refreshed" | "failed" | "skipped"> {
  const initial = structuredClone(account);
  const valid = await ensureValidToken(initial, options.oauthConfig);
  // Token validation can yield while a request-triggered refresh completes.
  // Re-read the store before starting another upstream probe so that the
  // shared coordinator also coalesces this otherwise easy-to-miss race.
  const latestBeforeProbe = options.store
    .getCachedAccounts()
    .find((candidate) => candidate.id === account.id);
  if (
    !latestBeforeProbe ||
    latestBeforeProbe.state?.scheduledWeeklyReset ||
    !isUsageRefreshNeeded(latestBeforeProbe)
  ) {
    return "skipped";
  }
  const source =
    latestBeforeProbe.accessToken === initial.accessToken &&
    isDeepStrictEqual(latestBeforeProbe.usage, initial.usage)
      ? valid
      : structuredClone(latestBeforeProbe);
  const persistenceBaseline = source === valid ? initial : source;
  const refreshed = await coordinator.refresh(
    source,
    usageBaseUrl(source, options),
  );
  const latest = options.store
    .getCachedAccounts()
    .find((candidate) => candidate.id === account.id);
  if (!latest) return "skipped";

  const usageChanged =
    refreshed.usage !== undefined &&
    (!source.usage || refreshed.usage.fetchedAt > source.usage.fetchedAt) &&
    isDeepStrictEqual(latest.usage, source.usage);
  const patch: Partial<Account> = {};
  if (usageChanged) patch.usage = refreshed.usage;

  const tokenPatch = changedFieldsPatch(
    persistenceBaseline,
    refreshed,
    latest,
    TOKEN_FIELDS,
  );
  Object.assign(patch, tokenPatch);

  const sourceState = persistenceBaseline.state ?? {};
  const refreshedState = refreshed.state ?? {};
  const latestState = latest.state ?? {};
  const statePatch = changedFieldsPatch(
    sourceState,
    refreshedState,
    latestState,
    STATE_FIELDS,
  ) as Partial<AccountState>;
  if (Object.keys(statePatch).length) patch.state = statePatch;

  if (!Object.keys(patch).length) return "skipped";
  await options.store.patchAccount(account.id, patch);
  return usageChanged && refreshed.usage?.quotaStatus !== "error" ? "refreshed" : "failed";
}

async function refreshWithConcurrency(
  accounts: Account[],
  options: UsageRefreshMonitorOptions,
  coordinator: UsageRefreshCoordinator,
): Promise<UsageRefreshCycleResult> {
  const maxConcurrent = Math.max(
    1,
    Number.isFinite(options.maxConcurrentRefreshes)
      ? Math.floor(options.maxConcurrentRefreshes as number)
      : DEFAULT_MAX_CONCURRENT_REFRESHES,
  );
  const result: UsageRefreshCycleResult = {
    checked: accounts.length,
    refreshed: 0,
    failed: 0,
    skipped: 0,
  };
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= accounts.length) return;
      const account = accounts[index];
      try {
        const outcome = await refreshOneAccount(account, options, coordinator);
        result[outcome] += 1;
      } catch (error: any) {
        result.failed += 1;
        options.logger?.warn?.(
          `background usage refresh failed for account ${account.id}:`,
          error?.message ?? String(error),
        );
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(maxConcurrent, accounts.length) },
      () => worker(),
    ),
  );
  return result;
}

export function createUsageRefreshMonitor(
  options: UsageRefreshMonitorOptions,
): UsageRefreshMonitor {
  const coordinator = options.coordinator ?? new UsageRefreshCoordinator();
  const intervalMs =
    options.intervalMs !== undefined &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? Math.max(1, Math.floor(options.intervalMs))
      : USAGE_REFRESH_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let cyclePromise: Promise<UsageRefreshCycleResult> | undefined;

  const refreshNow = (): Promise<UsageRefreshCycleResult> => {
    if (cyclePromise) return cyclePromise;
    const cycle = (async () => {
      const accounts = (await options.store.listAccounts()).filter(
        (account) =>
          !account.state?.scheduledWeeklyReset &&
          isUsageRefreshNeeded(account),
      );
      return refreshWithConcurrency(accounts, options, coordinator);
    })();
    cyclePromise = cycle;
    void cycle.finally(() => {
      if (cyclePromise === cycle) cyclePromise = undefined;
    }).catch(() => undefined);
    return cycle;
  };

  const runScheduledCycle = () => {
    void refreshNow().catch((error: any) => {
      options.logger?.error?.(
        "background usage refresh cycle failed:",
        error?.message ?? String(error),
      );
    });
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(runScheduledCycle, intervalMs);
      timer.unref?.();
      runScheduledCycle();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    refreshNow,
  };
}

export function startUsageRefreshMonitor(
  options: UsageRefreshMonitorOptions,
): UsageRefreshMonitor {
  const monitor = createUsageRefreshMonitor(options);
  monitor.start();
  return monitor;
}
