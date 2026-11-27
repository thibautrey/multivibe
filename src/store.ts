import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Account,
  ApplicationPolicy,
  AppliedPayment,
  CreditEntry,
  ModelAlias,
  OAuthFlowState,
  OAuthStateFile,
  StoredProxyApiKey,
  StoreSettings,
  StoreFile,
  User,
} from "./types.js";
import { ACCOUNT_FLUSH_INTERVAL_MS } from "./config.js";
import { inferAccountLocation, migrateModelAlias } from "./smart-routing.js";
import { grantedCostOf, normalizeEmail, rollUsagePeriod, rollUserWindows } from "./users.js";

const DEFAULT_FILE: StoreFile = {
  accounts: [],
  modelAliases: [],
  proxyApiKeys: [],
  applicationPolicies: [],
  users: [],
  settings: {},
};
const DEFAULT_OAUTH_FILE: OAuthStateFile = { states: [] };

type AccountCatalogSnapshot = Omit<Account, "usage" | "state">;

const MAX_CREDIT_LEDGER = 500;
const MAX_PAYMENT_AWARDS = 500;
const roundUsd = (value: number) => Math.round(value * 1e6) / 1e6;

function appendCreditEntry(
  user: User,
  entry: {
    kind: CreditEntry["kind"];
    amountUsd: number;
    actor?: string;
    note?: string;
    paymentId?: string;
  },
): void {
  const record: CreditEntry = {
    id: randomUUID(),
    at: Date.now(),
    balanceAfterUsd: roundUsd(user.walletUsd ?? 0),
    ...entry,
  };
  user.creditLedger = [record, ...(user.creditLedger ?? [])].slice(0, MAX_CREDIT_LEDGER);
}

/** Keep the idempotency map bounded; oldest payment ids are forgotten first. */
function prunePaymentAwards(user: User): void {
  const awards = user.paymentAwards;
  if (!awards) return;
  const keys = Object.keys(awards);
  if (keys.length <= MAX_PAYMENT_AWARDS) return;
  for (const key of keys.slice(0, keys.length - MAX_PAYMENT_AWARDS)) delete awards[key];
}

function accountCatalogSnapshot(account: Account): AccountCatalogSnapshot {
  const { usage: _usage, state: _state, ...catalogConfiguration } = account;
  return structuredClone(catalogConfiguration);
}

async function ensureFile(filePath: string, seed: object) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonAtomic(filePath, seed);
  }
  await fs.chmod(filePath, 0o600);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600);
}

/**
 * Advisory cross-process lock on the account store.
 *
 * `accounts.json` has two writers in the shipped container: this Node process
 * and the Rust edge (`start-multivibe.sh` starts both). Each rewrites the whole
 * document from its own memory, so an unlocked read-modify-write in either
 * one silently deletes the other's additions. A single O_EXCL lock file, taken
 * for the read *and* the write, is what makes "last writer wins" impossible.
 *
 * The file is not `fs.open`-locked because Node has no portable advisory lock;
 * `wx` creation is atomic on every filesystem this ships on. A lock older than
 * `STORE_LOCK_STALE_MS` is broken so a crashed writer cannot wedge the store.
 */
const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_STALE_MS = 30_000;

export function storeLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

export async function withStoreLock<T>(
  filePath: string,
  work: () => Promise<T>,
): Promise<T> {
  const lockPath = storeLockPath(filePath);
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  while (handle === null) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const age = await fs
        .stat(lockPath)
        .then((stat) => Date.now() - stat.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY);
      if (age > STORE_LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`account store lock is held: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  const held = handle;
  try {
    return await work();
  } finally {
    await held.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export async function cleanupOrphanedTmpFiles(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const entries = await fs.readdir(dataDir);
  await Promise.all(
    entries
      .filter((f) => f.endsWith(".tmp-"))
      .map((f) => fs.unlink(path.join(dataDir, f)))
  );
}

export class AccountStore {
  private inMemoryAccounts: Account[] = [];
  private inMemoryModelAliases: ModelAlias[] = [];
  private inMemoryProxyApiKeys: StoredProxyApiKey[] = [];
  private inMemoryApplicationPolicies: ApplicationPolicy[] = [];
  private inMemoryUsers: User[] = [];
  // Tombstones for entries this process removed on purpose. Without them the
  // read-before-write merge would re-adopt a key the operator just revoked,
  // because the Rust edge may still hold the pre-deletion document.
  private removedProxyApiKeys = new Set<string>();
  private removedApplicationPolicies = new Set<string>();
  private inMemorySettings: StoreSettings = {};
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  // Persistence writes use their own generation so a mutation that arrives
  // during a flush cannot be lost.
  private revision = 0;
  // Model discovery only depends on account configuration and aliases. Runtime
  // telemetry (usage, selection timestamps, blocks, and errors) must not make
  // an otherwise fresh catalog stale.
  private catalogRevision = 0;
  private accountCatalogSnapshots = new Map<string, AccountCatalogSnapshot>();
  private modelAliasCatalogSnapshots = new Map<string, ModelAlias>();
  private lastFlushError: { at: number; message: string } | undefined;

  constructor(
    private filePath: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async init() {
    await ensureFile(this.filePath, DEFAULT_FILE);
    await this.reloadFromDisk();
  }

  private async reloadFromDisk() {
    const raw = await fs.readFile(this.filePath, "utf8");
    const data = JSON.parse(raw) as StoreFile & { modelAliases?: unknown[] };
    let migrated = false;
    this.inMemoryAccounts = Array.isArray(data.accounts)
      ? data.accounts.map((account) => {
          if (account.localRuntime && account.enabled) {
            migrated = true;
            account = { ...account, enabled: false };
          }
          if (account.location) return account;
          migrated = true;
          return { ...account, location: inferAccountLocation(account) };
        })
      : [];
    this.inMemoryModelAliases = Array.isArray(data.modelAliases)
      ? data.modelAliases.map((alias) => {
          const next = migrateModelAlias(alias);
          if ((alias as any)?.schemaVersion !== 2) migrated = true;
          return next;
        })
      : [];
    this.inMemoryProxyApiKeys = Array.isArray(data.proxyApiKeys)
      ? data.proxyApiKeys
      : [];
    this.inMemoryApplicationPolicies = Array.isArray(data.applicationPolicies)
      ? data.applicationPolicies.map((policy) => ({
          application: policy.application,
          fairnessWeight: Math.max(0.1, Number(policy.fairnessWeight) || 1),
          webhooks: Array.isArray(policy.webhooks)
            ? policy.webhooks.map((webhook) => ({ ...webhook }))
            : [],
        }))
      : [];
    this.inMemoryUsers = Array.isArray(data.users)
      ? data.users
          .filter((user) => user && typeof user.id === "string")
          .map((user) => ({
            ...user,
            email: normalizeEmail(user.email),
            role: user.role === "admin" ? "admin" : "member",
            status: user.status === "suspended" ? "suspended" : "active",
            quota: user.quota ?? { period: "month" },
            usage: user.usage ?? { requests: 0, tokens: 0, costUsd: 0 },
            walletUsd:
              typeof user.walletUsd === "number" && Number.isFinite(user.walletUsd)
                ? roundUsd(user.walletUsd)
                : undefined,
            ...(Array.isArray(user.creditLedger)
              ? {
                  creditLedger: user.creditLedger
                    .filter((entry) => entry && typeof entry.id === "string")
                    .slice(0, MAX_CREDIT_LEDGER),
                }
              : {}),
            ...(user.paymentAwards && typeof user.paymentAwards === "object"
              ? {
                  paymentAwards: Object.fromEntries(
                    Object.entries(user.paymentAwards)
                      .filter(
                        ([key, award]) =>
                          key &&
                          award &&
                          typeof award === "object" &&
                          Number.isFinite(Number((award as AppliedPayment).creditUsd)),
                      )
                      .map(([key, award]) => [
                        key,
                        {
                          creditUsd: roundUsd(Math.max(0, Number(award.creditUsd))),
                          refundedUsd: roundUsd(Math.max(0, Number(award.refundedUsd) || 0)),
                        },
                      ])
                      .slice(-MAX_PAYMENT_AWARDS),
                  ),
                }
              : {}),
          }))
      : [];
    this.inMemorySettings =
      data.settings && typeof data.settings === "object"
        ? { ...data.settings }
        : {};
    const enabledAt = Date.parse(this.inMemorySettings.anonymousUsageSharingEnabledAt ?? "");
    if (typeof this.inMemorySettings.anonymousUsageSharingEnabled !== "boolean") {
      this.inMemorySettings.anonymousUsageSharingEnabled = true;
      this.inMemorySettings.anonymousUsageSharingEnabledAt = this.clock().toISOString();
      migrated = true;
    } else if (
      this.inMemorySettings.anonymousUsageSharingEnabled &&
      (!Number.isFinite(enabledAt) || enabledAt > this.clock().getTime())
    ) {
      this.inMemorySettings.anonymousUsageSharingEnabledAt = this.clock().toISOString();
      migrated = true;
    }
    this.accountCatalogSnapshots = new Map(
      this.inMemoryAccounts.map((account) => [
        account.id,
        accountCatalogSnapshot(account),
      ]),
    );
    this.modelAliasCatalogSnapshots = new Map(
      this.inMemoryModelAliases.map((alias) => [
        alias.id,
        structuredClone(alias),
      ]),
    );
    this.dirty = migrated;
    if (migrated) {
      this.revision += 1;
      await this.flushIfDirty();
    }
  }

  private scheduleFlush() {
    if (this.dirty && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushIfDirty().catch((error) => {
          console.error("account store flush failed", error);
        });
      }, ACCOUNT_FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  /**
   * Re-read the file and adopt `proxyApiKeys` / `applicationPolicies` entries
   * this process has never seen.
   *
   * Node owns accounts, aliases and settings; the Rust edge owns the enrollment
   * and token writes. Both rewrite the whole document from their own memory, so
   * without this merge whichever writes second silently erases the other's
   * additions. Collections are keyed rather than positional: an entry present
   * on disk with the same identity is kept as-is, so a concurrent edit is not
   * reverted by a stale in-memory copy.
   *
   * Deletions stay authoritative on the Node side. An entry this process
   * deliberately removed is remembered in `removedProxyApiKeys` /
   * `removedApplicationPolicies`, so a merge cannot resurrect it from a stale
   * file.
   */
  private async mergeUnmanagedCollections(): Promise<{
    proxyApiKeys: StoredProxyApiKey[];
    applicationPolicies: ApplicationPolicy[];
  }> {
    let onDisk: StoreFile;
    try {
      onDisk = JSON.parse(await fs.readFile(this.filePath, "utf8")) as StoreFile;
    } catch {
      return {
        proxyApiKeys: this.inMemoryProxyApiKeys,
        applicationPolicies: this.inMemoryApplicationPolicies,
      };
    }

    const diskKeys = Array.isArray(onDisk.proxyApiKeys) ? onDisk.proxyApiKeys : [];
    const byKeyId = new Map(
      this.inMemoryProxyApiKeys.map((entry) => [entry.id, entry] as const),
    );
    const byApplication = new Set(
      this.inMemoryProxyApiKeys.map((entry) => entry.application),
    );
    const mergedKeys = [...this.inMemoryProxyApiKeys];
    for (const entry of diskKeys) {
      if (this.removedProxyApiKeys.has(entry.id)) continue;
      if (byKeyId.has(entry.id) || byApplication.has(entry.application)) continue;
      mergedKeys.push(entry);
      byKeyId.set(entry.id, entry);
      byApplication.add(entry.application);
    }

    const diskPolicies = Array.isArray(onDisk.applicationPolicies)
      ? onDisk.applicationPolicies
      : [];
    const byPolicyApp = new Map(
      this.inMemoryApplicationPolicies.map(
        (policy) => [policy.application, policy] as const,
      ),
    );
    const mergedPolicies = [...this.inMemoryApplicationPolicies];
    for (const policy of diskPolicies) {
      if (this.removedApplicationPolicies.has(policy.application)) continue;
      if (byPolicyApp.has(policy.application)) continue;
      mergedPolicies.push(policy);
      byPolicyApp.set(policy.application, policy);
    }

    // Adopt what was merged so later flushes and readers see the same view.
    this.inMemoryProxyApiKeys = mergedKeys;
    this.inMemoryApplicationPolicies = mergedPolicies;
    return { proxyApiKeys: mergedKeys, applicationPolicies: mergedPolicies };
  }

  async flushIfDirty() {
    if (this.flushPromise) return this.flushPromise;
    if (!this.dirty) return;

    this.flushPromise = (async () => {
      while (this.dirty) {
        const revision = this.revision;
        try {
          // The account store file has a second writer: the Rust edge rewrites
          // it wholesale for enrollment and token persistence. Reading before
          // every write keeps entries that this process did not author, so a
          // flush cannot silently delete an enrolled application's API key.
          await withStoreLock(this.filePath, async () => {
            const merged = await this.mergeUnmanagedCollections();
            await writeJsonAtomic(this.filePath, {
              accounts: this.inMemoryAccounts,
              modelAliases: this.inMemoryModelAliases,
              proxyApiKeys: merged.proxyApiKeys,
              applicationPolicies: merged.applicationPolicies,
              users: this.inMemoryUsers,
              settings: this.inMemorySettings,
            });
          });
          this.lastFlushError = undefined;
          if (this.revision === revision) this.dirty = false;
        } catch (error: any) {
          this.lastFlushError = {
            at: Date.now(),
            message: error?.message ?? String(error),
          };
          throw error;
        }
      }
    })().finally(() => {
      this.flushPromise = null;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      if (this.dirty) this.scheduleFlush();
    });

    return this.flushPromise;
  }

  getPersistenceStatus() {
    return {
      dirty: this.dirty,
      flushPending: Boolean(this.flushPromise || this.flushTimer),
      lastError: this.lastFlushError,
    };
  }

  getRevision(): number {
    return this.revision;
  }

  getCatalogRevision(): number {
    return this.catalogRevision;
  }

  getCachedAccounts(): Account[] {
    return [...this.inMemoryAccounts];
  }

  getCachedModelAliases(): ModelAlias[] {
    return this.inMemoryModelAliases.map((alias) => structuredClone(alias));
  }

  getCachedSettings(): StoreSettings {
    return { ...this.inMemorySettings };
  }

  async getSettings(): Promise<StoreSettings> {
    return this.getCachedSettings();
  }

  async patchSettings(patch: Partial<StoreSettings>): Promise<StoreSettings> {
    const wasSharingEnabled = this.inMemorySettings.anonymousUsageSharingEnabled !== false;
    this.inMemorySettings = {
      ...this.inMemorySettings,
      ...patch,
    };
    if ("anonymousUsageSharingEnabled" in patch) {
      if (patch.anonymousUsageSharingEnabled === true) {
        this.inMemorySettings.anonymousUsageSharingEnabled = true;
        if (!wasSharingEnabled) {
          this.inMemorySettings.anonymousUsageSharingEnabledAt = this.clock().toISOString();
        }
      } else if (patch.anonymousUsageSharingEnabled === false) {
        this.inMemorySettings.anonymousUsageSharingEnabled = false;
      }
    }
    if ("communityBenchmarksSharingEnabled" in patch) {
      if (patch.communityBenchmarksSharingEnabled === true) {
        this.inMemorySettings.communityBenchmarksSharingEnabled = true;
        if (!this.inMemorySettings.communityBenchmarksSharingEnabledAt) {
          this.inMemorySettings.communityBenchmarksSharingEnabledAt = this.clock().toISOString();
        }
      } else {
        delete this.inMemorySettings.communityBenchmarksSharingEnabled;
        delete this.inMemorySettings.communityBenchmarksSharingEnabledAt;
      }
    }
    if (!this.inMemorySettings.defaultPassthroughAccountId) {
      delete this.inMemorySettings.defaultPassthroughAccountId;
    }
    if (!this.inMemorySettings.imageRequestModelOverride) {
      delete this.inMemorySettings.imageRequestModelOverride;
    }
    this.dirty = true;
    this.revision += 1;
    this.scheduleFlush();
    await this.flushIfDirty();
    return this.getCachedSettings();
  }

  markAccountModified(accountId: string, account: Account) {
    // Keep legacy metadata for recovery, but never reactivate the retired engine.
    if (account.localRuntime) account.enabled = false;
    const normalized = account.location
      ? account
      : { ...account, location: inferAccountLocation(account) };
    const idx = this.inMemoryAccounts.findIndex((a) => a.id === accountId);
    const previousCatalogSnapshot = this.accountCatalogSnapshots.get(accountId);
    const nextCatalogSnapshot = accountCatalogSnapshot(normalized);
    const catalogChanged =
      idx === -1 ||
      accountId !== normalized.id ||
      !previousCatalogSnapshot ||
      !isDeepStrictEqual(previousCatalogSnapshot, nextCatalogSnapshot);
    if (idx === -1) {
      this.inMemoryAccounts.push(normalized);
    } else {
      this.inMemoryAccounts[idx] = normalized;
    }
    if (accountId !== normalized.id) {
      this.accountCatalogSnapshots.delete(accountId);
    }
    this.accountCatalogSnapshots.set(normalized.id, nextCatalogSnapshot);
    this.dirty = true;
    this.revision += 1;
    if (catalogChanged) this.catalogRevision += 1;
    this.scheduleFlush();
  }

  /** Install a validated Team manifest and its cursor as one persistence generation.
   * No await occurs between the CAS check and replacement. A failed flush leaves
   * the complete generation dirty for retry, never acknowledges a partial manifest.
   */
  async commitTeamManifest(accounts: readonly Account[], removedProviderIds: readonly string[],
    expectedCursor: number, team: NonNullable<StoreSettings["multivibeTeam"]>): Promise<void> {
    if ((this.inMemorySettings.multivibeTeam?.syncCursor ?? 0) !== expectedCursor)
      throw new Error("Team Sync cursor changed");
    if (!Number.isSafeInteger(team.syncCursor) || team.syncCursor < expectedCursor)
      throw new Error("Team Sync manifest is stale");
    const ids = new Set<string>(), providers = new Set<string>();
    const removed = new Set(removedProviderIds);
    const prepared = accounts.map(account => {
      const providerId = account.multivibeTeam?.providerId;
      if (!providerId || ids.has(account.id) || providers.has(providerId) || removed.has(providerId))
        throw new Error("Team account batch is invalid");
      const collision = this.inMemoryAccounts.find(existing => existing.id === account.id);
      if (collision && collision.multivibeTeam?.providerId !== providerId)
        throw new Error("Team account id collision");
      ids.add(account.id); providers.add(providerId);
      return structuredClone(account);
    });
    const next = this.inMemoryAccounts.filter(account => !account.multivibeTeam ||
      (!removed.has(account.multivibeTeam.providerId) && !providers.has(account.multivibeTeam.providerId)));
    next.push(...prepared);
    const snapshots = new Map(next.map(account => [account.id, accountCatalogSnapshot(account)]));
    const settings = {...this.inMemorySettings, multivibeTeam: structuredClone(team)};
    this.inMemoryAccounts = next;
    this.inMemorySettings = settings;
    this.accountCatalogSnapshots = snapshots;
    this.catalogRevision += 1;
    this.revision += 1;
    this.dirty = true;
    await this.flushIfDirty();
  }

  /** Detach in one durable generation. Distributed credentials intentionally
   * become local accounts; proxy-only accounts cannot work without Team access.
   * Like manifest commits, a failed write leaves the whole generation dirty.
   */
  async commitTeamDetach(): Promise<void> {
    const next: Account[] = [];
    for (const account of this.inMemoryAccounts) {
      if (!account.multivibeTeam) { next.push(account); continue; }
      if (account.multivibeTeam.deliveryMode === "cloud_proxy") continue;
      const {multivibeTeam: _, ...local} = account;
      next.push(local);
    }
    const snapshots = new Map(next.map(account => [account.id, accountCatalogSnapshot(account)]));
    this.inMemoryAccounts = next;
    this.inMemorySettings = {...this.inMemorySettings, multivibeTeam: undefined};
    this.accountCatalogSnapshots = snapshots;
    this.catalogRevision += 1;
    this.revision += 1;
    this.dirty = true;
    await this.flushIfDirty();
  }

  async addOrUpdate(account: Account) {
    this.markAccountModified(account.id, account);
    await this.flushIfDirty();
    return account;
  }

  async upsertAccount(account: Account): Promise<Account> {
    this.markAccountModified(account.id, account);
    return account;
  }

  async patchAccount(id: string, patch: Partial<Account>): Promise<Account | null> {
    const idx = this.inMemoryAccounts.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const existing = this.inMemoryAccounts[idx];
    const updated = {
      ...existing,
      ...patch,
      state: { ...existing.state, ...patch.state },
      usage: patch.usage ?? existing.usage,
    };
    this.markAccountModified(id, updated);
    return updated;
  }

  patchAccountTokenIfCurrent(
    id: string,
    expectedAccessToken: string,
    patch: Pick<Account, "accessToken"> &
      Partial<
        Pick<
          Account,
          | "refreshToken"
          | "expiresAt"
          | "chatgptAccountId"
          | "email"
          | "state"
        >
      >,
  ):
    | { status: "not_found" | "conflict" }
    | { status: "updated"; account: Account } {
    const existing = this.inMemoryAccounts.find((account) => account.id === id);
    if (!existing) return { status: "not_found" };
    if (existing.accessToken !== expectedAccessToken) {
      return { status: "conflict" };
    }
    const updated: Account = {
      ...existing,
      ...patch,
      state: { ...existing.state, ...patch.state },
    };
    this.markAccountModified(id, updated);
    return { status: "updated", account: updated };
  }

  async deleteAccount(id: string): Promise<boolean> {
    const before = this.inMemoryAccounts.length;
    this.inMemoryAccounts = this.inMemoryAccounts.filter((a) => a.id !== id);
    if (this.inMemoryAccounts.length === before) return false;
    this.accountCatalogSnapshots.delete(id);
    this.dirty = true;
    this.revision += 1;
    this.catalogRevision += 1;
    await this.flushIfDirty();
    return true;
  }

  async listAccounts(): Promise<Account[]> {
    return this.getCachedAccounts();
  }

  private markModelAliasModified(aliasId: string, alias: ModelAlias) {
    const idx = this.inMemoryModelAliases.findIndex((a) => a.id === aliasId);
    const previousCatalogSnapshot =
      this.modelAliasCatalogSnapshots.get(aliasId);
    const nextCatalogSnapshot = structuredClone(alias);
    const catalogChanged =
      idx === -1 ||
      aliasId !== alias.id ||
      !previousCatalogSnapshot ||
      !isDeepStrictEqual(previousCatalogSnapshot, nextCatalogSnapshot);
    if (idx === -1) {
      this.inMemoryModelAliases.push(alias);
    } else {
      this.inMemoryModelAliases[idx] = alias;
    }
    if (aliasId !== alias.id) {
      this.modelAliasCatalogSnapshots.delete(aliasId);
    }
    this.modelAliasCatalogSnapshots.set(alias.id, nextCatalogSnapshot);
    this.dirty = true;
    this.revision += 1;
    if (catalogChanged) this.catalogRevision += 1;
    this.scheduleFlush();
  }

  async listModelAliases(): Promise<ModelAlias[]> {
    return this.getCachedModelAliases();
  }

  async upsertModelAlias(alias: ModelAlias): Promise<ModelAlias> {
    this.markModelAliasModified(alias.id, alias);
    return alias;
  }

  async patchModelAlias(
    id: string,
    patch: Partial<ModelAlias>,
  ): Promise<ModelAlias | null> {
    const idx = this.inMemoryModelAliases.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const existing = this.inMemoryModelAliases[idx];
    const updated: ModelAlias = {
      ...existing,
      ...patch,
      id: existing.id,
      schemaVersion: 2,
      rules: Array.isArray(patch.rules)
        ? structuredClone(patch.rules)
        : structuredClone(existing.rules),
    };
    this.markModelAliasModified(id, updated);
    return updated;
  }

  async deleteModelAlias(id: string): Promise<boolean> {
    const before = this.inMemoryModelAliases.length;
    this.inMemoryModelAliases = this.inMemoryModelAliases.filter(
      (a) => a.id !== id,
    );
    if (this.inMemoryModelAliases.length === before) return false;
    this.modelAliasCatalogSnapshots.delete(id);
    this.dirty = true;
    this.revision += 1;
    this.catalogRevision += 1;
    await this.flushIfDirty();
    return true;
  }

  private rollUserPeriods(): void {
    const now = new Date();
    let changed = false;
    for (const user of this.inMemoryUsers) {
      if (rollUsagePeriod(user, now)) changed = true;
      if (rollUserWindows(user, now)) changed = true;
    }
    if (!changed) return;
    this.dirty = true;
    this.revision += 1;
    this.scheduleFlush();
  }

  getCachedUsers(): User[] {
    this.rollUserPeriods();
    return this.inMemoryUsers.map((user) => structuredClone(user));
  }

  async listUsers(): Promise<User[]> {
    return this.getCachedUsers();
  }

  async findUser(id: string): Promise<User | undefined> {
    this.rollUserPeriods();
    const user = this.inMemoryUsers.find((candidate) => candidate.id === id);
    return user ? structuredClone(user) : undefined;
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    this.rollUserPeriods();
    const normalized = normalizeEmail(email);
    const user = this.inMemoryUsers.find((candidate) => candidate.email === normalized);
    return user ? structuredClone(user) : undefined;
  }

  async addUser(user: User): Promise<User> {
    if (this.inMemoryUsers.some((candidate) => candidate.id === user.id)) {
      throw new Error("user id already exists");
    }
    if (this.inMemoryUsers.some((candidate) => candidate.email === normalizeEmail(user.email))) {
      throw new Error("user email already exists");
    }
    this.inMemoryUsers.push(structuredClone(user));
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return structuredClone(user);
  }

  async patchUser(id: string, patch: Partial<User>): Promise<User | null> {
    const index = this.inMemoryUsers.findIndex((candidate) => candidate.id === id);
    if (index === -1) return null;
    const existing = this.inMemoryUsers[index];
    const email = patch.email === undefined ? existing.email : normalizeEmail(patch.email);
    if (this.inMemoryUsers.some((candidate) => candidate.id !== id && candidate.email === email)) {
      throw new Error("user email already exists");
    }
    this.inMemoryUsers[index] = {
      ...existing,
      ...patch,
      id: existing.id,
      email,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    // A direct quota edit from the dashboard is still a balance movement: keep
    // it in the same audit trail as the dedicated grant route.
    const nextAllowance = patch.quota?.creditUsd;
    if (typeof nextAllowance === "number") {
      const delta = roundUsd(nextAllowance - (existing.quota.creditUsd ?? 0));
      if (delta !== 0) {
        appendCreditEntry(this.inMemoryUsers[index], {
          kind: "allowance",
          amountUsd: delta,
          note: "quota edit",
        });
      }
    }
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return structuredClone(this.inMemoryUsers[index]);
  }

  async deleteUser(id: string): Promise<boolean> {
    const before = this.inMemoryUsers.length;
    this.inMemoryUsers = this.inMemoryUsers.filter((user) => user.id !== id);
    if (this.inMemoryUsers.length === before) return false;
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return true;
  }

  /**
   * Accumulate usage for quota enforcement. Called for every completed client
   * request, so it only mutates memory; the regular flush timer persists it.
   */
  recordUserUsage(
    userId: string,
    delta: { requests?: number; tokens?: number; costUsd?: number },
  ): void {
    const user = this.inMemoryUsers.find((candidate) => candidate.id === userId);
    if (!user) return;
    rollUsagePeriod(user);
    rollUserWindows(user);
    const cost = roundUsd(Math.max(0, delta.costUsd ?? 0));
    if (cost > 0) {
      const allowance =
        typeof user.quota.creditUsd === "number" ? user.quota.creditUsd : undefined;
      const hasWallet = typeof user.walletUsd === "number" && Number.isFinite(user.walletUsd);
      // Freeze the covered counter on first spend so a later allowance change
      // never retroactively bills machine history.
      const granted = grantedCostOf(user.usage, allowance);
      if (allowance !== undefined) {
        // The period allowance is consumed first, the prepaid wallet covers
        // the rest. An exhausted allowance keeps its cap so a rollover is the
        // only thing that reopens it.
        const covered = Math.min(cost, Math.max(0, allowance - granted));
        user.usage.grantedCostUsd = roundUsd(granted + covered);
        const uncovered = roundUsd(cost - covered);
        if (uncovered > 0 && hasWallet) {
          user.walletUsd = roundUsd((user.walletUsd ?? 0) - uncovered);
        }
      } else if (hasWallet) {
        // Wallet-only billing: the balance is the sole credit source.
        user.usage.grantedCostUsd = granted;
        user.walletUsd = roundUsd((user.walletUsd ?? 0) - cost);
      } else {
        // Unlimited credit: keep the counter in sync with the total spend.
        user.usage.grantedCostUsd = roundUsd(granted + cost);
      }
    }
    user.usage.requests += Math.max(0, delta.requests ?? 0);
    user.usage.tokens += Math.max(0, delta.tokens ?? 0);
    user.usage.costUsd = roundUsd(user.usage.costUsd + cost);
    user.usage.updatedAt = Date.now();
    if (user.plan?.mode === "subscription") {
      user.windowUsage ??= {};
      for (const window of user.plan.windows ?? []) {
        const record = (user.windowUsage[window.id] ??= {
          startedAt: Date.now(),
          requests: 0,
          tokens: 0,
          costUsd: 0,
        });
        record.requests += Math.max(0, delta.requests ?? 0);
        record.tokens += Math.max(0, delta.tokens ?? 0);
        record.costUsd += Math.max(0, delta.costUsd ?? 0);
        record.updatedAt = Date.now();
      }
    }
    this.dirty = true;
    this.revision += 1;
    this.scheduleFlush();
  }

  /**
   * Add credit to the period allowance. The prepaid wallet is untouched; the
   * ledger records the change for audit.
   */
  async grantUserAllowance(
    id: string,
    amountUsd: number,
    options: { actor?: string; note?: string } = {},
  ): Promise<User | null> {
    const user = this.inMemoryUsers.find((candidate) => candidate.id === id);
    if (!user) return null;
    const amount = roundUsd(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    rollUsagePeriod(user);
    user.quota = {
      ...user.quota,
      creditUsd: roundUsd((user.quota.creditUsd ?? 0) + amount),
    };
    appendCreditEntry(user, {
      kind: "allowance",
      amountUsd: amount,
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.note ? { note: options.note } : {}),
    });
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return structuredClone(user);
  }

  /**
   * Move the prepaid balance in either direction. Positive amounts are
   * top-ups, negative amounts are manual debits (refund, correction). The
   * first movement freezes prior unlimited usage as already covered so a
   * later purchase never bills history.
   */
  async adjustUserWallet(
    id: string,
    amountUsd: number,
    options: {
      kind?: CreditEntry["kind"];
      actor?: string;
      note?: string;
      paymentId?: string;
    } = {},
  ): Promise<User | null> {
    const user = this.inMemoryUsers.find((candidate) => candidate.id === id);
    if (!user) return null;
    const amount = roundUsd(amountUsd);
    if (!Number.isFinite(amount) || amount === 0) return null;
    rollUsagePeriod(user);
    if (user.usage.grantedCostUsd === undefined) {
      user.usage.grantedCostUsd = roundUsd(
        grantedCostOf(user.usage, user.quota.creditUsd),
      );
    }
    user.walletUsd = roundUsd((user.walletUsd ?? 0) + amount);
    appendCreditEntry(user, {
      kind: options.kind ?? (amount > 0 ? "topup" : "debit"),
      amountUsd: amount,
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.note ? { note: options.note } : {}),
      ...(options.paymentId ? { paymentId: options.paymentId } : {}),
    });
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return structuredClone(user);
  }

  /**
   * Credit a wallet from a broker payment. The payment id makes the write
   * idempotent: an event replayed after a lost cursor never doubles the
   * balance, even once the bounded ledger has rotated.
   */
  async creditWalletFromPayment(
    id: string,
    input: {
      paymentId: string;
      creditUsd: number;
      actor?: string;
      note?: string;
    },
  ): Promise<{ user: User; applied: boolean } | null> {
    const user = this.inMemoryUsers.find((candidate) => candidate.id === id);
    if (!user) return null;
    const amount = roundUsd(input.creditUsd);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if ((user.paymentAwards?.[input.paymentId]?.creditUsd ?? 0) > 0) {
      return { user: structuredClone(user), applied: false };
    }
    rollUsagePeriod(user);
    if (user.usage.grantedCostUsd === undefined) {
      user.usage.grantedCostUsd = roundUsd(grantedCostOf(user.usage, user.quota.creditUsd));
    }
    user.walletUsd = roundUsd((user.walletUsd ?? 0) + amount);
    user.paymentAwards = {
      ...(user.paymentAwards ?? {}),
      [input.paymentId]: { creditUsd: amount, refundedUsd: 0 },
    };
    prunePaymentAwards(user);
    appendCreditEntry(user, {
      kind: "topup",
      amountUsd: amount,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.note ? { note: input.note } : {}),
      paymentId: input.paymentId,
    });
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return { user: structuredClone(user), applied: true };
  }

  /**
   * Return the credited part of a payment after a refund or dispute. The
   * refund is proportional to the credited amount, so a bonus or a partial
   * refund never invents money. Debiting can push the wallet negative.
   */
  async refundWalletFromPayment(
    id: string,
    input: {
      paymentId: string;
      amountCents: number;
      refundedCents: number;
      disputed?: boolean;
      actor?: string;
      note?: string;
    },
  ): Promise<{ user: User; applied: boolean; amountUsd: number } | null> {
    const user = this.inMemoryUsers.find((candidate) => candidate.id === id);
    if (!user) return null;
    const award = user.paymentAwards?.[input.paymentId];
    if (!award) return { user: structuredClone(user), applied: false, amountUsd: 0 };
    const total = Math.max(0, Math.floor(input.amountCents));
    const refunded = input.disputed
      ? total
      : Math.min(total, Math.max(0, Math.floor(input.refundedCents)));
    if (total <= 0 || refunded <= 0) {
      return { user: structuredClone(user), applied: false, amountUsd: 0 };
    }
    const target = roundUsd((award.creditUsd * refunded) / total);
    const delta = roundUsd(target - award.refundedUsd);
    if (delta <= 0) {
      return { user: structuredClone(user), applied: false, amountUsd: 0 };
    }
    rollUsagePeriod(user);
    if (user.usage.grantedCostUsd === undefined) {
      user.usage.grantedCostUsd = roundUsd(grantedCostOf(user.usage, user.quota.creditUsd));
    }
    user.walletUsd = roundUsd((user.walletUsd ?? 0) - delta);
    user.paymentAwards = {
      ...(user.paymentAwards ?? {}),
      [input.paymentId]: { ...award, refundedUsd: target },
    };
    prunePaymentAwards(user);
    appendCreditEntry(user, {
      kind: "refund",
      amountUsd: -delta,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.note ? { note: input.note } : {}),
      paymentId: input.paymentId,
    });
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return { user: structuredClone(user), applied: true, amountUsd: delta };
  }

  async resetUserUsage(id: string): Promise<User | null> {
    return this.patchUser(id, {
      usage: {
        periodStart: undefined,
        requests: 0,
        tokens: 0,
        costUsd: 0,
        grantedCostUsd: 0,
        updatedAt: Date.now(),
      },
      windowUsage: {},
    });
  }

  getCachedProxyApiKeys(): StoredProxyApiKey[] {
    return this.inMemoryProxyApiKeys.map((entry) => ({ ...entry }));
  }

  async listProxyApiKeys(): Promise<StoredProxyApiKey[]> {
    return this.getCachedProxyApiKeys();
  }

  /**
   * Reads a key after adopting anything the Rust edge wrote to disk, so a
   * revocation never deletes the local entry without first seeing the
   * Cloudflare metadata attached to it.
   */
  async findProxyApiKey(id: string): Promise<StoredProxyApiKey | undefined> {
    await withStoreLock(this.filePath, async () => {
      await this.mergeUnmanagedCollections();
    });
    const entry = this.inMemoryProxyApiKeys.find((candidate) => candidate.id === id);
    return entry ? { ...entry } : undefined;
  }

  async addProxyApiKey(entry: StoredProxyApiKey): Promise<StoredProxyApiKey> {
    // A re-created application owns its identity again; clear any tombstone so
    // the merge path does not filter it back out.
    this.removedProxyApiKeys.delete(entry.id);
    this.removedApplicationPolicies.delete(entry.application);
    this.inMemoryProxyApiKeys.push({ ...entry });
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return { ...entry };
  }

  async deleteProxyApiKey(id: string): Promise<boolean> {
    // A key enrolled through the Rust edge lives in the file this process has
    // not necessarily read since it started. Deleting from memory alone would
    // report 404 for a credential that is still valid, which makes offboarding
    // impossible: the operator is told the key does not exist while it keeps
    // authenticating. Adopt whatever is on disk first, then delete.
    await withStoreLock(this.filePath, async () => {
      await this.mergeUnmanagedCollections();
    });
    const before = this.inMemoryProxyApiKeys.length;
    this.inMemoryProxyApiKeys = this.inMemoryProxyApiKeys.filter(
      (entry) => entry.id !== id,
    );
    if (this.inMemoryProxyApiKeys.length === before) return false;
    this.removedProxyApiKeys.add(id);
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return true;
  }

  getCachedApplicationPolicies(): ApplicationPolicy[] {
    return this.inMemoryApplicationPolicies.map((policy) => structuredClone(policy));
  }

  getApplicationPolicy(application: string): ApplicationPolicy {
    const policy = this.inMemoryApplicationPolicies.find(
      (entry) => entry.application === application,
    );
    return policy
      ? structuredClone(policy)
      : { application, fairnessWeight: 1, webhooks: [] };
  }

  /**
   * Remove an application's admission policy.
   *
   * Revoking a key leaves its policy behind, and until now nothing could delete
   * one: an offboarded client kept a share reservation in every admission
   * decision. Deleting the key alone is therefore not offboarding.
   *
   * The on-disk entries are adopted first, for the same reason as key deletion:
   * enrollment writes policies from the other process.
   */
  async deleteApplicationPolicy(application: string): Promise<boolean> {
    await withStoreLock(this.filePath, async () => {
      await this.mergeUnmanagedCollections();
    });
    const before = this.inMemoryApplicationPolicies.length;
    this.inMemoryApplicationPolicies = this.inMemoryApplicationPolicies.filter(
      (policy) => policy.application !== application,
    );
    if (this.inMemoryApplicationPolicies.length === before) return false;
    // Without a tombstone the merge would re-adopt it from a document the other
    // process still holds.
    this.removedApplicationPolicies.add(application);
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return true;
  }

  async upsertApplicationPolicy(policy: ApplicationPolicy): Promise<ApplicationPolicy> {
    const normalized: ApplicationPolicy = {
      application: policy.application,
      fairnessWeight: Math.max(0.1, Math.min(100, Number(policy.fairnessWeight) || 1)),
      ...(policy.maxConcurrentShare === undefined
        ? {}
        : {
            maxConcurrentShare: Math.max(
              0,
              Math.min(1, Number(policy.maxConcurrentShare) || 0),
            ),
          }),
      ...(policy.burst === undefined
        ? {}
        : { burst: Math.max(0, Math.min(8, Math.trunc(Number(policy.burst) || 0))) }),
      ...(policy.shareWindows === undefined
        ? {}
        : {
            shareWindows: policy.shareWindows
              .filter(
                (window) =>
                  Number.isInteger(window.startHour) &&
                  Number.isInteger(window.endHour) &&
                  window.startHour >= 0 &&
                  window.startHour < 24 &&
                  window.endHour > 0 &&
                  window.endHour <= 24 &&
                  window.startHour !== window.endHour &&
                  Number.isFinite(window.multiplier),
              )
              .map((window) => ({
                startHour: window.startHour,
                endHour: window.endHour,
                ...(window.days?.length ? { days: [...window.days] } : {}),
                multiplier: Math.max(1, Math.min(8, window.multiplier)),
              })),
          }),
      webhooks: policy.webhooks.map((webhook) => ({ ...webhook })),
    };
    const index = this.inMemoryApplicationPolicies.findIndex(
      (entry) => entry.application === normalized.application,
    );
    if (index === -1) this.inMemoryApplicationPolicies.push(normalized);
    else this.inMemoryApplicationPolicies[index] = normalized;
    this.dirty = true;
    this.revision += 1;
    await this.flushIfDirty();
    return structuredClone(normalized);
  }
}

export class OAuthStateStore {
  constructor(private filePath: string) {}

  async init() {
    await ensureFile(this.filePath, DEFAULT_OAUTH_FILE);
  }

  private async read(): Promise<OAuthStateFile> {
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as OAuthStateFile;
  }

  private async write(data: OAuthStateFile): Promise<void> {
    await writeJsonAtomic(this.filePath, data);
  }

  async create(state: OAuthFlowState) {
    const data = await this.read();
    data.states = [state, ...data.states.filter((s) => s.id !== state.id)].slice(0, 200);
    await this.write(data);
  }

  async get(id: string): Promise<OAuthFlowState | undefined> {
    const data = await this.read();
    return data.states.find((s) => s.id === id);
  }

  async update(id: string, patch: Partial<OAuthFlowState>): Promise<OAuthFlowState | undefined> {
    const data = await this.read();
    const idx = data.states.findIndex((s) => s.id === id);
    if (idx === -1) return undefined;
    data.states[idx] = { ...data.states[idx], ...patch };
    await this.write(data);
    return data.states[idx];
  }
}
