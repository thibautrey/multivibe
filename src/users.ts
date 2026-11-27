import crypto from "node:crypto";
import type {
  PublicUser,
  PublicUserQuotaWindow,
  User,
  UserPlan,
  UserQuota,
  UserQuotaPeriod,
  UserQuotaWindow,
  UserQuotaWindowPeriod,
  UserRole,
  UserUsage,
} from "./types.js";

/**
 * Dashboard users.
 *
 * The store lives in `accounts.json` next to the accounts it owns. Passwords
 * are scrypt hashes; the plaintext never leaves the request. Sessions are
 * stateless signed cookies so the Rust edge and this control plane can validate
 * the same value without a shared session database.
 */

const SESSION_VERSION = "v1";
const SESSION_MAC_PREFIX = "multivibe-session-v1.";
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionClaims = {
  /** Absent for the legacy admin-token session. */
  userId?: string;
  role: UserRole;
  expiresAt: number;
};

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<User["password"]> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return {
    algo: "scrypt",
    salt: salt.toString("base64"),
    hash: key.toString("base64"),
    updatedAt: Date.now(),
  };
}

export async function verifyPassword(
  password: string,
  stored: User["password"] | undefined,
): Promise<boolean> {
  if (!stored || stored.algo !== "scrypt") return false;
  const salt = Buffer.from(stored.salt, "base64");
  const expected = Buffer.from(stored.hash, "base64");
  if (!salt.length || !expected.length) return false;
  const actual = await scrypt(password, salt);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase().slice(0, 320);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPassword(password: string): boolean {
  return password.length >= 8 && password.length <= 512;
}

export function normalizeQuota(input: unknown): UserQuota {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const period: UserQuotaPeriod =
    raw.period === "day" || raw.period === "total" ? raw.period : "month";
  const quota: UserQuota = { period };
  const credit = Number(raw.creditUsd);
  if (Number.isFinite(credit)) quota.creditUsd = Math.max(0, credit);
  const maxTokens = Number(raw.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0)
    quota.maxTokens = Math.max(1, Math.floor(maxTokens));
  const maxRequests = Number(raw.maxRequests);
  if (Number.isFinite(maxRequests) && maxRequests > 0)
    quota.maxRequests = Math.max(1, Math.floor(maxRequests));
  return quota;
}

export function periodStartFor(period: UserQuotaPeriod, now = new Date()): string {
  if (period === "total") return new Date(0).toISOString();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (period === "month") start.setUTCDate(1);
  return start.toISOString();
}

/** Reset counters when the quota period rolled over since the last write. */
export function rollUsagePeriod(user: User, now = new Date()): boolean {
  const start = periodStartFor(user.quota.period, now);
  if (user.usage.periodStart === start) return false;
  // The prepaid wallet is intentionally preserved: purchased credit does not
  // expire with the period allowance.
  user.usage = {
    periodStart: start,
    requests: 0,
    tokens: 0,
    costUsd: 0,
    grantedCostUsd: 0,
    updatedAt: Date.now(),
  };
  return true;
}

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS: Record<Exclude<UserQuotaWindowPeriod, "month">, number> = {
  "5h": 5 * HOUR_MS,
  day: 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
};

export const QUOTA_WINDOW_PERIODS: ReadonlyArray<UserQuotaWindowPeriod> = [
  "5h",
  "day",
  "week",
  "month",
];

function isWindowPeriod(value: unknown): value is UserQuotaWindowPeriod {
  return QUOTA_WINDOW_PERIODS.includes(value as UserQuotaWindowPeriod);
}

/** Epoch ms at which the next window rollover happens, when it is known. */
export function windowResetsAt(period: UserQuotaWindowPeriod, startedAt: number): number | undefined {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return undefined;
  if (period === "month") {
    const start = new Date(startedAt);
    return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  }
  return startedAt + WINDOW_MS[period];
}

/**
 * Windows are rolling and anchored at first use. A record whose start falls
 * outside the current window is stale, so the window has restarted.
 */
export function windowStartedAt(
  period: UserQuotaWindowPeriod,
  startedAt: number | undefined,
  now = new Date(),
): number {
  const timestamp = Number(startedAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return now.getTime();
  if (period === "month") {
    return timestamp >= Date.parse(periodStartFor("month", now)) ? timestamp : now.getTime();
  }
  return now.getTime() - timestamp < WINDOW_MS[period] ? timestamp : now.getTime();
}

function finiteLimit(value: unknown, max: number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.min(max, Number.isInteger(number) ? number : Math.floor(number));
}

export function normalizeQuotaWindow(
  input: unknown,
  index = 0,
): UserQuotaWindow | undefined {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const period = isWindowPeriod(raw.period) ? raw.period : "week";
  const window: UserQuotaWindow = {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 40) : `w${index + 1}`,
    period,
  };
  if (typeof raw.label === "string" && raw.label.trim()) window.label = raw.label.trim().slice(0, 60);
  const present = (value: unknown) => value !== null && value !== undefined && value !== "";
  if (present(raw.creditUsd)) {
    const credit = Number(raw.creditUsd);
    if (Number.isFinite(credit) && credit >= 0) window.creditUsd = credit;
  }
  const tokens = present(raw.maxTokens) ? finiteLimit(raw.maxTokens, Number.MAX_SAFE_INTEGER) : undefined;
  if (tokens !== undefined) window.maxTokens = tokens;
  const requests = present(raw.maxRequests)
    ? finiteLimit(raw.maxRequests, Number.MAX_SAFE_INTEGER)
    : undefined;
  if (requests !== undefined) window.maxRequests = requests;
  return window;
}

/** Normalizes an admin plan payload; an absent plan keeps pay-as-you-go. */
export function normalizePlan(input: unknown): UserPlan | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const mode = raw.mode === "subscription" ? "subscription" : "usage";
  const plan: UserPlan = { mode };
  if (typeof raw.name === "string" && raw.name.trim()) plan.name = raw.name.trim().slice(0, 80);
  const price = Number(raw.priceUsd);
  if (Number.isFinite(price) && price >= 0) plan.priceUsd = Math.round(price * 100) / 100;
  if (mode === "subscription") {
    const seen = new Set<string>();
    const windows: UserQuotaWindow[] = [];
    const entries = Array.isArray(raw.windows) ? raw.windows : [];
    for (const entry of entries.slice(0, 8)) {
      const window = normalizeQuotaWindow(entry, windows.length);
      if (!window) continue;
      let id = window.id;
      for (let suffix = 2; seen.has(id); suffix += 1) id = `${window.id}-${suffix}`;
      seen.add(id);
      windows.push({ ...window, id });
    }
    plan.windows = windows;
  }
  return plan;
}

/**
 * Restart windows whose rolling period elapsed and drop counters for windows
 * the plan no longer contains. Returns true when anything changed.
 */
export function rollUserWindows(user: User, now = new Date()): boolean {
  const windows = user.plan?.mode === "subscription" ? user.plan.windows ?? [] : [];
  const current = { ...(user.windowUsage ?? {}) };
  let changed = false;
  const ids = new Set<string>();
  for (const window of windows) {
    ids.add(window.id);
    const record = current[window.id];
    const startedAt = windowStartedAt(window.period, record?.startedAt, now);
    if (!record || record.startedAt !== startedAt) {
      current[window.id] = {
        startedAt,
        requests: 0,
        tokens: 0,
        costUsd: 0,
        updatedAt: Date.now(),
      };
      changed = true;
    }
  }
  for (const id of Object.keys(current)) {
    if (ids.has(id)) continue;
    delete current[id];
    changed = true;
  }
  if (changed) user.windowUsage = current;
  return changed;
}

export type QuotaReason = "suspended" | "credit" | "tokens" | "requests";

const money = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * How much of the period spend the allowance already covered. Legacy records
 * written before prepaid credit stored this counter are read as "allowance
 * first", which matches the historical behaviour.
 */
export function grantedCostOf(
  usage: { costUsd: number; grantedCostUsd?: number },
  creditUsd: number | undefined,
): number {
  if (typeof usage.grantedCostUsd === "number" && Number.isFinite(usage.grantedCostUsd)) {
    return Math.max(0, usage.grantedCostUsd);
  }
  const spent = Math.max(0, usage.costUsd);
  return creditUsd === undefined ? spent : Math.min(spent, creditUsd);
}

/**
 * Prepaid credit is exhausted only when every defined source is. A period
 * allowance and a purchased balance stack: the allowance is consumed first,
 * the wallet covers the rest, and the account blocks once both reach zero.
 * Neither source defined means unlimited credit.
 */
function creditExhausted(
  limits: { creditUsd?: number },
  usage: { costUsd: number; grantedCostUsd?: number },
  walletUsd: number | undefined,
): boolean {
  const allowance = typeof limits.creditUsd === "number" ? limits.creditUsd : undefined;
  const wallet = typeof walletUsd === "number" && Number.isFinite(walletUsd) ? walletUsd : undefined;
  if (allowance === undefined && wallet === undefined) return false;
  const allowanceExhausted =
    allowance === undefined ? true : grantedCostOf(usage, allowance) >= allowance;
  const walletExhausted = wallet === undefined ? true : wallet <= 0;
  if (allowance !== undefined && wallet !== undefined) {
    return allowanceExhausted && walletExhausted;
  }
  return wallet === undefined ? allowanceExhausted : walletExhausted;
}

function reasonsFor(
  limits: { creditUsd?: number; maxTokens?: number; maxRequests?: number },
  usage: { requests: number; tokens: number; costUsd: number; grantedCostUsd?: number },
  walletUsd?: number,
): QuotaReason[] {
  const reasons: QuotaReason[] = [];
  if (creditExhausted(limits, usage, walletUsd)) reasons.push("credit");
  if (typeof limits.maxTokens === "number" && usage.tokens >= limits.maxTokens) reasons.push("tokens");
  if (typeof limits.maxRequests === "number" && usage.requests >= limits.maxRequests)
    reasons.push("requests");
  return reasons;
}

function remainingFor(
  limits: { creditUsd?: number; maxTokens?: number; maxRequests?: number },
  usage: { requests: number; tokens: number; costUsd: number; grantedCostUsd?: number },
  walletUsd?: number,
): { creditUsd?: number; tokens?: number; requests?: number } {
  const allowance = typeof limits.creditUsd === "number" ? limits.creditUsd : undefined;
  const wallet = typeof walletUsd === "number" && Number.isFinite(walletUsd) ? walletUsd : undefined;
  return {
    creditUsd:
      allowance === undefined && wallet === undefined
        ? undefined
        : money(
            (allowance === undefined
              ? 0
              : Math.max(0, allowance - grantedCostOf(usage, allowance))) +
              (wallet === undefined ? 0 : Math.max(0, wallet)),
          ),
    tokens:
      typeof limits.maxTokens === "number" ? Math.max(0, limits.maxTokens - usage.tokens) : undefined,
    requests:
      typeof limits.maxRequests === "number"
        ? Math.max(0, limits.maxRequests - usage.requests)
        : undefined,
  };
}

/** Subscription windows with their live counters, for enforcement and display. */
export function quotaWindows(user: User, now = new Date()): PublicUserQuotaWindow[] {
  if (user.plan?.mode !== "subscription") return [];
  const records = user.windowUsage ?? {};
  return (user.plan.windows ?? []).map((window) => {
    const startedAt = windowStartedAt(window.period, records[window.id]?.startedAt, now);
    const record =
      records[window.id]?.startedAt === startedAt
        ? records[window.id]!
        : { startedAt, requests: 0, tokens: 0, costUsd: 0 };
    const usage = {
      requests: record.requests,
      tokens: record.tokens,
      costUsd: record.costUsd,
    };
    const reasons = reasonsFor(window, usage);
    return {
      ...window,
      startedAt,
      ...(windowResetsAt(window.period, startedAt) !== undefined
        ? { resetsAt: windowResetsAt(window.period, startedAt) }
        : {}),
      usage,
      remaining: remainingFor(window, usage),
      blocked: reasons.length > 0,
    };
  });
}

export type QuotaState = {
  blocked: boolean;
  suspended: boolean;
  mode: UserPlan["mode"];
  reasons: QuotaReason[];
  remaining: { creditUsd?: number; tokens?: number; requests?: number };
  /** Windows whose limit is currently reached. */
  blockedWindows: string[];
  windows: PublicUserQuotaWindow[];
};

/**
 * Counters from a period that already ended are treated as zero until the next
 * write rolls them over, so a dashboard never shows a spent allowance that has
 * reopened, and the Rust edge applies the same rule independently.
 */
function activeUsage(user: User, now: Date): UserUsage {
  const start = periodStartFor(user.quota.period, now);
  const stored = user.usage;
  if (stored.periodStart && stored.periodStart < start) {
    return { periodStart: start, requests: 0, tokens: 0, costUsd: 0 };
  }
  return stored;
}

export function quotaState(user: User, now = new Date()): QuotaState {
  const usage = activeUsage(user, now);
  const reasons = user.status === "suspended" ? ["suspended" as QuotaReason] : [];
  reasons.push(...reasonsFor(user.quota, usage, user.walletUsd));
  const windows = quotaWindows(user, now);
  for (const window of windows) {
    if (!window.blocked) continue;
    for (const reason of reasonsFor(window, window.usage)) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  // The binding constraint is the smallest remaining value across the usage
  // quota and every subscription window.
  const remaining = remainingFor(user.quota, usage, user.walletUsd);
  for (const window of windows) {
    for (const key of ["creditUsd", "tokens", "requests"] as const) {
      const value = window.remaining[key];
      if (value === undefined) continue;
      const current = remaining[key];
      remaining[key] = current === undefined ? value : Math.min(current, value);
    }
  }
  return {
    blocked: reasons.length > 0,
    suspended: user.status === "suspended",
    mode: user.plan?.mode ?? "usage",
    reasons: [...new Set(reasons)],
    remaining,
    blockedWindows: windows.filter((window) => window.blocked).map((window) => window.id),
    windows,
  };
}

export function publicUser(user: User): PublicUser {
  const now = new Date();
  const quotaStateValue = quotaState(user, now);
  // Spend accounting stays internal; the dashboard only needs the remaining
  // credit and the prepaid balance. A rolled-over period reads as zero so the
  // dashboard never shows counters the edge already ignores.
  const { grantedCostUsd: _grantedCostUsd, ...usage } = activeUsage(user, now);
  return {
    id: user.id,
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
    hasPassword: Boolean(user.password),
    passkeys: (user.passkeys ?? []).map((passkey) => ({
      id: passkey.id,
      ...(passkey.name ? { name: passkey.name } : {}),
      createdAt: passkey.createdAt,
      ...(passkey.lastUsedAt ? { lastUsedAt: passkey.lastUsedAt } : {}),
    })),
    quota: { ...user.quota },
    usage: {
      ...usage,
      ...(quotaStateValue.remaining.creditUsd !== undefined
        ? { remainingCreditUsd: quotaStateValue.remaining.creditUsd }
        : {}),
    },
    ...(typeof user.walletUsd === "number" && Number.isFinite(user.walletUsd)
      ? { walletUsd: money(user.walletUsd) }
      : {}),
    ...(user.plan ? { plan: structuredClonePlan(user.plan) } : {}),
    ...(user.allowedModels?.length ? { allowedModels: [...user.allowedModels] } : {}),
    ...(quotaStateValue.windows.length ? { quotaWindows: quotaStateValue.windows } : {}),
    ...(user.invite
      ? { invitePending: true, inviteExpiresAt: user.invite.expiresAt }
      : {}),
  };
}

function structuredClonePlan(plan: UserPlan): UserPlan {
  return JSON.parse(JSON.stringify(plan)) as UserPlan;
}


export function newInvite(): { token: string; tokenHash: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashInviteToken(token),
    expiresAt: Date.now() + INVITE_TTL_MS,
  };
}

export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sessionMac(payload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${SESSION_MAC_PREFIX}${payload}`)
    .digest("base64url");
}

export function signSession(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: claims.userId, r: claims.role, e: claims.expiresAt }),
  ).toString("base64url");
  return `${SESSION_VERSION}.${payload}.${sessionMac(payload, secret)}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Legacy admin-token cookie, still accepted so existing sessions keep working. */
export function adminSessionValue(secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("multivibe-admin-session-v1")
    .digest("base64url");
}

export function verifySession(value: string | undefined, secret: string): SessionClaims | null {
  if (!value) return null;
  if (secret && safeEqual(value, adminSessionValue(secret))) {
    return { role: "admin", expiresAt: Number.MAX_SAFE_INTEGER };
  }
  const [version, payload, mac, ...rest] = value.split(".");
  if (version !== SESSION_VERSION || !payload || !mac || rest.length) return null;
  if (!secret || !safeEqual(mac, sessionMac(payload, secret))) return null;
  let claims: { u?: unknown; r?: unknown; e?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const role = claims.r === "admin" ? "admin" : claims.r === "member" ? "member" : null;
  const expiresAt = Number(claims.e);
  if (!role || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const userId = typeof claims.u === "string" && claims.u.trim() ? claims.u.trim() : undefined;
  return { ...(userId ? { userId } : {}), role, expiresAt };
}
