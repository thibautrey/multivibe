import type { AccountStore } from "../store.js";
import type {
  PaymentPack,
  PaymentsSettings,
  PublicUser,
  StoreSettings,
  User,
} from "../types.js";
import { publicUser } from "../users.js";
import {
  BrokerClient,
  BrokerClientError,
  pollEnrollment as pollBrokerEnrollment,
  startEnrollment as startBrokerEnrollment,
  type BrokerConnectStatus,
  type BrokerEvent,
  type BrokerPayment,
  type CheckoutRequest,
} from "./broker-client.js";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
  type PendingEnrollment,
  type PaymentsCredentials,
} from "./credentials.js";
import { MARKETPLACE_POLL_INTERVAL_MS, MARKETPLACE_REQUEST_TIMEOUT_MS } from "../config.js";

export class PaymentsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentsError";
  }
}

export type PaymentsServiceOptions = {
  store: AccountStore;
  credentialsPath: string;
  brokerUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

export type PublicPayment = {
  paymentId: string;
  sessionId?: string;
  userRef: string;
  kind: "topup" | "subscription";
  status: BrokerPayment["status"];
  amountCents: number;
  feeCents: number;
  netCents: number;
  currency: string;
  creditUsd?: number;
  planRef?: string;
  createdAt: number;
  paidAt?: number;
  refundedCents?: number;
};

export type MemberBilling = {
  enabled: boolean;
  connected: boolean;
  currency: string;
  walletUsd: number;
  remainingCreditUsd?: number;
  packs: PaymentPack[];
  payments: PublicPayment[];
  connect: BrokerConnectStatus;
};

const DEFAULT_PACKS: PaymentPack[] = [];

function moneyNote(payment: { amountCents: number; currency: string }): string {
  const amount = (payment.amountCents / 100).toFixed(2);
  return `Stripe ${payment.currency} ${amount}`;
}

/**
 * Instance-side marketplace orchestration.
 *
 * The broker is the source of truth for payments; this service only pulls
 * signed events and writes the local wallet. A browser redirect never credits
 * anything: the same `creditWalletFromPayment` idempotency guard covers a
 * duplicated webhook, a replayed event and a manual reconciliation.
 */
export class PaymentsService {
  private readonly store: AccountStore;
  private readonly credentialsPath: string;
  private readonly configuredBrokerUrl?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private credentials: PaymentsCredentials | null | undefined;
  private syncing: Promise<{ applied: number; cursor: number }> | null = null;

  constructor(options: PaymentsServiceOptions) {
    this.store = options.store;
    this.credentialsPath = options.credentialsPath;
    this.configuredBrokerUrl = options.brokerUrl?.replace(/\/+$/, "") || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? MARKETPLACE_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (this.credentials !== undefined) return;
    this.credentials = await readCredentials(this.credentialsPath);
  }

  private async credentialsValue(): Promise<PaymentsCredentials | null> {
    await this.load();
    return this.credentials ?? null;
  }

  async settings(): Promise<PaymentsSettings> {
    const settings = await this.store.getSettings();
    return (
      settings.payments ?? {
        enabled: false,
        currency: "EUR",
        packs: DEFAULT_PACKS,
      }
    );
  }

  private async patchSettings(patch: Partial<PaymentsSettings>): Promise<PaymentsSettings> {
    const current = await this.settings();
    const next: PaymentsSettings = {
      ...current,
      ...patch,
      currency: (patch.currency ?? current.currency ?? "EUR").toUpperCase(),
      packs: patch.packs ?? current.packs ?? [],
    };
    const settings = await this.store.patchSettings({ payments: next } as Partial<StoreSettings>);
    return settings.payments ?? next;
  }

  async brokerUrl(): Promise<string | undefined> {
    const credentials = await this.credentialsValue();
    return (
      credentials?.brokerUrl ||
      this.configuredBrokerUrl ||
      (await this.settings()).brokerUrl ||
      undefined
    );
  }

  private async client(): Promise<BrokerClient> {
    const credentials = await this.credentialsValue();
    if (!credentials?.secret || !credentials.instanceId) {
      throw new PaymentsError(409, "not_enrolled", "Connect this instance to the marketplace first.");
    }
    return new BrokerClient({
      baseUrl: credentials.brokerUrl,
      secret: credentials.secret,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
  }

  /** Settings plus live-only metadata, safe for the admin dashboard. */
  async adminStatus() {
    const [settings, credentials] = await Promise.all([
      this.settings(),
      this.credentialsValue(),
    ]);
    return {
      ...settings,
      brokerConfigured: Boolean(await this.brokerUrl()),
      secretConfigured: Boolean(credentials?.instanceId && credentials.secret),
      pendingEnrollment: credentials?.pending
        ? {
            code: credentials.pending.code,
            verificationUrl: credentials.pending.verificationUrl,
            expiresAt: credentials.pending.expiresAt,
          }
        : undefined,
      connect: credentials?.secret
        ? await this.refreshConnect().catch(() => settings.connect ?? emptyConnect())
        : settings.connect ?? emptyConnect(),
    };
  }

  // --- Enrollment ----------------------------------------------------------

  async startEnrollment(): Promise<{
    code: string;
    deviceCode: string;
    verificationUrl: string;
    expiresAt: number;
  }> {
    const brokerUrl = await this.brokerUrl();
    if (!brokerUrl) {
      throw new PaymentsError(
        400,
        "broker_url_required",
        "Set MULTIVIBE_MARKETPLACE_URL or the broker URL in the payments settings.",
      );
    }
    const ticket = await startBrokerEnrollment(brokerUrl, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    const pending: PendingEnrollment = {
      code: ticket.code,
      deviceCode: ticket.deviceCode,
      expiresAt: ticket.expiresAt,
      verificationUrl: ticket.verificationUrl,
    };
    this.credentials = {
      version: 1,
      brokerUrl,
      ...(this.credentials?.instanceId ? { instanceId: this.credentials.instanceId } : {}),
      ...(this.credentials?.secret ? { secret: this.credentials.secret } : {}),
      pending,
    };
    await writeCredentials(this.credentialsPath, this.credentials);
    return {
      code: ticket.code,
      // The device code stays server-side: the browser only needs the short code.
      deviceCode: "",
      verificationUrl: ticket.verificationUrl,
      expiresAt: ticket.expiresAt,
    };
  }

  async pollEnrollment(): Promise<{
    status: "pending" | "enrolled";
    instanceId?: string;
    name?: string;
    expiresAt?: number;
  }> {
    const credentials = await this.credentialsValue();
    if (!credentials?.pending) {
      throw new PaymentsError(409, "no_pending_enrollment", "Start an enrollment first.");
    }
    const pending = credentials.pending;
    let result: Awaited<ReturnType<typeof pollBrokerEnrollment>>;
    try {
      result = await pollBrokerEnrollment(credentials.brokerUrl, pending.code, pending.deviceCode, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof BrokerClientError && error.code === "enrollment_expired") {
        await this.clearEnrollment();
      }
      throw error;
    }
    if (result.status === "pending") {
      return { status: "pending", expiresAt: result.expiresAt };
    }
    if (result.consumed || !result.instanceSecret) {
      throw new PaymentsError(
        409,
        "enrollment_consumed",
        "The broker already handed out this secret. Restart the enrollment if it was lost.",
      );
    }
    this.credentials = {
      version: 1,
      brokerUrl: credentials.brokerUrl,
      instanceId: result.instanceId,
      secret: result.instanceSecret,
    };
    await writeCredentials(this.credentialsPath, this.credentials);
    const client = new BrokerClient({
      baseUrl: credentials.brokerUrl,
      secret: result.instanceSecret,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    const instance = await client.getInstance().catch(() => undefined);
    await this.patchSettings({
      enabled: true,
      brokerUrl: credentials.brokerUrl,
      instanceId: result.instanceId,
      ...(instance ? { commissionBps: instance.instance.commissionBps, currency: instance.instance.currency } : {}),
    });
    return {
      status: "enrolled",
      instanceId: result.instanceId,
      ...(instance ? { name: instance.instance.name } : {}),
    };
  }

  async clearEnrollment(): Promise<void> {
    const credentials = await this.credentialsValue();
    if (!credentials) return;
    if (credentials.secret && credentials.instanceId) {
      const { pending: _pending, ...rest } = credentials;
      this.credentials = rest;
      await writeCredentials(this.credentialsPath, rest);
      return;
    }
    // Only a pending enrollment exists: remove the file instead of leaving a
    // record that `readCredentials` would reject on the next start.
    this.credentials = null;
    await deleteCredentials(this.credentialsPath);
  }

  /** Forget the instance credentials (disconnect). */
  async disconnect(): Promise<void> {
    this.credentials = null;
    await deleteCredentials(this.credentialsPath);
    await this.patchSettings({
      enabled: false,
      instanceId: undefined,
      connect: undefined,
    });
  }

  // --- Connect -------------------------------------------------------------

  async connectOnboarding(
    options: { email?: string; origin?: string } = {},
  ): Promise<{ url: string }> {
    const client = await this.client();
    const base = options.origin?.replace(/\/+$/, "");
    const result = await client.connectOnboarding({
      ...(base
        ? {
            returnUrl: `${base}/?tab=payments&connect=return`,
            refreshUrl: `${base}/?tab=payments&connect=refresh`,
          }
        : {}),
      ...(options.email ? { email: options.email } : {}),
    });
    await this.patchSettings({
      enabled: true,
      connect: {
        status: "pending",
        chargesEnabled: false,
        payoutsEnabled: false,
        requirementsDue: [],
        accountId: result.accountId,
        updatedAt: this.now(),
      },
    });
    return { url: result.url };
  }

  async refreshConnect(options: { loginLink?: boolean } = {}): Promise<BrokerConnectStatus> {
    const credentials = await this.credentialsValue();
    if (!credentials?.secret) return emptyConnect();
    const client = await this.client();
    const status = await client.connectStatus({
      refresh: true,
      loginLink: options.loginLink === true,
    });
    await this.patchSettings({
      connect: {
        status: status.status,
        chargesEnabled: status.chargesEnabled,
        payoutsEnabled: status.payoutsEnabled,
        requirementsDue: status.requirementsDue,
        ...(status.accountId ? { accountId: status.accountId } : {}),
        updatedAt: status.updatedAt ?? this.now(),
      },
      ...(status.chargesEnabled ? { enabled: true } : {}),
    });
    return status;
  }

  // --- Packs ---------------------------------------------------------------

  async listPacks(): Promise<PaymentPack[]> {
    const settings = await this.settings();
    return (settings.packs ?? []).filter((pack) => pack.enabled !== false);
  }

  async setPacks(packs: PaymentPack[]): Promise<PaymentPack[]> {
    const settings = await this.patchSettings({ packs });
    return settings.packs;
  }

  /** Admin-editable settings (packs, currency, broker URL, master switch). */
  async updateSettings(patch: Partial<PaymentsSettings>): Promise<PaymentsSettings> {
    return this.patchSettings(patch);
  }

  // --- Checkout ------------------------------------------------------------

  async checkout(
    userId: string,
    packId: string,
    origin: string,
  ): Promise<{
    url: string;
    sessionId: string;
    paymentId: string;
    amountCents: number;
    feeCents: number;
    netCents: number;
    currency: string;
  }> {
    const settings = await this.settings();
    if (!settings.enabled) {
      throw new PaymentsError(409, "payments_disabled", "Marketplace billing is disabled.");
    }
    const user = await this.store.findUser(userId);
    if (!user || user.status !== "active") {
      throw new PaymentsError(403, "inactive_user", "This account cannot buy credit.");
    }
    const pack = (settings.packs ?? []).find(
      (candidate) => candidate.id === packId && candidate.enabled !== false,
    );
    if (!pack) throw new PaymentsError(404, "pack_not_found", "Unknown credit pack.");
    if (
      !Number.isInteger(pack.amountCents) ||
      pack.amountCents < 50 ||
      pack.amountCents > 1_000_000 ||
      !Number.isFinite(pack.creditUsd) ||
      pack.creditUsd <= 0
    ) {
      throw new PaymentsError(400, "invalid_pack", "This pack is misconfigured.");
    }
    const client = await this.client();
    const base = origin.replace(/\/+$/, "");
    const request: CheckoutRequest = {
      packId: pack.id,
      amountCents: pack.amountCents,
      currency: (pack.currency || settings.currency || "EUR").toUpperCase(),
      creditUsd: pack.creditUsd + (pack.bonusUsd ?? 0),
      userRef: user.id,
      ...(user.email ? { customerEmail: user.email } : {}),
      successUrl: `${base}/?tab=billing&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/?tab=billing&checkout=cancelled`,
      kind: "topup",
      productName: pack.label || `${pack.creditUsd.toFixed(2)} USD credit`,
    };
    return client.createCheckout(request);
  }

  // --- Events and credit ---------------------------------------------------

  async syncEvents(): Promise<{ applied: number; cursor: number }> {
    if (this.syncing) return this.syncing;
    this.syncing = this.syncEventsOnce().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async syncEventsOnce(): Promise<{ applied: number; cursor: number }> {
    const settings = await this.settings();
    if (!settings.enabled) return { applied: 0, cursor: settings.lastEventCursor ?? 0 };
    const credentials = await this.credentialsValue();
    if (!credentials?.secret) return { applied: 0, cursor: settings.lastEventCursor ?? 0 };
    const client = await this.client();
    let cursor = settings.lastEventCursor ?? 0;
    let applied = 0;
    let failure: unknown;
    for (let page = 0; page < 20; page += 1) {
      let batch: Awaited<ReturnType<BrokerClient["listEvents"]>>;
      try {
        batch = await client.listEvents(cursor, 100);
      } catch (error) {
        failure = error;
        break;
      }
      for (const event of batch.events) {
        if (event.seq <= cursor) continue;
        try {
          await this.applyEvent(event);
        } catch (error) {
          failure = error;
          break;
        }
        cursor = event.seq;
        applied += 1;
      }
      if (failure || !batch.hasMore) break;
    }
    await this.patchSettings({ lastEventCursor: cursor, lastSyncAt: this.now() });
    if (failure) throw failure;
    return { applied, cursor };
  }

  private async applyEvent(event: BrokerEvent): Promise<void> {
    const payload = event.payload;
    switch (event.type) {
      case "payment.succeeded": {
        const userId = String(payload.userRef ?? "");
        const paymentId = String(payload.paymentId ?? "");
        const creditUsd = Number(payload.creditUsd ?? 0);
        if (!userId || !paymentId || !Number.isFinite(creditUsd) || creditUsd <= 0) return;
        const user = await this.store.findUser(userId);
        if (!user) return;
        await this.store.creditWalletFromPayment(userId, {
          paymentId,
          creditUsd,
          actor: "stripe",
          note: moneyNote({
            amountCents: Number(payload.amountCents ?? 0),
            currency: String(payload.currency ?? "EUR"),
          }),
        });
        return;
      }
      case "payment.refunded":
      case "payment.disputed": {
        const userId = String(payload.userRef ?? "");
        const paymentId = String(payload.paymentId ?? "");
        const amountCents = Number(payload.amountCents ?? 0);
        const refundedCents = Number(payload.refundedCents ?? 0);
        if (!userId || !paymentId || !Number.isFinite(amountCents) || amountCents <= 0) return;
        const user = await this.store.findUser(userId);
        if (!user) return;
        await this.store.refundWalletFromPayment(userId, {
          paymentId,
          amountCents,
          refundedCents,
          disputed: event.type === "payment.disputed",
          actor: "stripe",
          note: event.type === "payment.disputed" ? "Stripe dispute" : "Stripe refund",
        });
        return;
      }
      case "connect.updated": {
        const chargesEnabled = payload.chargesEnabled === true;
        await this.patchSettings({
          connect: {
            status:
              payload.status === "active" || payload.status === "restricted" || payload.status === "pending"
                ? payload.status
                : chargesEnabled
                  ? "active"
                  : "pending",
            chargesEnabled,
            payoutsEnabled: payload.payoutsEnabled === true,
            requirementsDue: Array.isArray(payload.requirementsDue)
              ? payload.requirementsDue.map(String)
              : [],
            updatedAt: this.now(),
          },
          ...(chargesEnabled ? { enabled: true } : {}),
        });
        return;
      }
      default:
        // checkout.expired and unknown future events need no local write.
        return;
    }
  }

  /**
   * Verified status of one checkout. The browser return calls this instead of
   * trusting the redirect: any paid-but-uncredited state is applied through
   * the same idempotent path.
   */
  async paymentStatus(sessionId: string, expectedUserId?: string): Promise<{
    payment: PublicPayment;
    walletUsd: number;
  }> {
    const client = await this.client();
    let result: { payment: BrokerPayment };
    try {
      result = await client.getPayment(sessionId);
    } catch (error) {
      if (error instanceof BrokerClientError && error.status === 404) {
        throw new PaymentsError(404, "not_found", "Unknown checkout session.");
      }
      throw error;
    }
    if (expectedUserId && result.payment.userRef !== expectedUserId) {
      throw new PaymentsError(404, "not_found", "Unknown checkout session.");
    }
    if (result.payment.status === "paid" && result.payment.creditUsd) {
      const user = await this.store.findUser(result.payment.userRef);
      if (user) {
        await this.store.creditWalletFromPayment(result.payment.userRef, {
          paymentId: result.payment.paymentId,
          creditUsd: result.payment.creditUsd,
          actor: "stripe",
          note: moneyNote(result.payment),
        });
      }
    }
    await this.syncEvents();
    const user = await this.store.findUser(result.payment.userRef);
    return {
      payment: publicPayment(result.payment),
      walletUsd: user?.walletUsd ?? 0,
    };
  }

  async history(userId: string, limit = 25): Promise<PublicPayment[]> {
    const credentials = await this.credentialsValue();
    if (!credentials?.secret) return [];
    const client = await this.client();
    const { payments } = await client.listPayments(0, 200);
    return payments
      .filter((payment) => payment.userRef === userId)
      .slice(0, limit)
      .map(publicPayment);
  }

  async memberBilling(user: User): Promise<MemberBilling> {
    const settings = await this.settings();
    const view: PublicUser = publicUser(user);
    return {
      enabled: settings.enabled,
      connected: Boolean(settings.connect?.chargesEnabled),
      currency: settings.currency,
      walletUsd: view.walletUsd ?? 0,
      ...(view.usage.remainingCreditUsd !== undefined
        ? { remainingCreditUsd: view.usage.remainingCreditUsd }
        : {}),
      packs: settings.enabled ? await this.listPacks() : [],
      payments: await this.history(user.id).catch(() => []),
      connect: settings.connect ?? emptyConnect(),
    };
  }

  // --- Admin operations ----------------------------------------------------

  async refund(
    paymentId: string,
    options: { amountCents?: number; refundApplicationFee?: boolean } = {},
  ): Promise<{ payment: PublicPayment; refundId: string; amountCents: number }> {
    const client = await this.client();
    const result = await client.refund({
      paymentId,
      ...(options.amountCents ? { amountCents: options.amountCents } : {}),
      refundApplicationFee: options.refundApplicationFee === true,
    });
    await this.syncEvents().catch(() => undefined);
    return {
      payment: publicPayment(result.payment),
      refundId: result.refundId,
      amountCents: result.amountCents,
    };
  }

  async earnings(): Promise<Awaited<ReturnType<BrokerClient["earnings"]>>> {
    const client = await this.client();
    return client.earnings();
  }

  async listPayments(limit = 50): Promise<PublicPayment[]> {
    const client = await this.client();
    const { payments } = await client.listPayments(0, limit);
    return payments.map(publicPayment);
  }

  /**
   * Daily safety net: re-read recent sessions so a missed event or a lost
   * cursor cannot leave a paid member uncredited. Every write is idempotent.
   */
  async reconcile(): Promise<{ checked: number; credited: number; refunded: number }> {
    const credentials = await this.credentialsValue();
    if (!credentials?.secret) return { checked: 0, credited: 0, refunded: 0 };
    const client = await this.client();
    const since = this.now() - 7 * 24 * 60 * 60 * 1000;
    const { payments } = await client.listPayments(since, 500);
    let credited = 0;
    let refunded = 0;
    for (const payment of payments) {
      const user = await this.store.findUser(payment.userRef);
      if (!user) continue;
      if (payment.status === "paid" && payment.creditUsd) {
        const result = await this.store.creditWalletFromPayment(payment.userRef, {
          paymentId: payment.paymentId,
          creditUsd: payment.creditUsd,
          actor: "stripe-reconcile",
          note: moneyNote(payment),
        });
        if (result?.applied) credited += 1;
      }
      if (
        (payment.status === "refunded" || payment.status === "disputed") &&
        (payment.refundedCents ?? 0) > 0
      ) {
        const result = await this.store.refundWalletFromPayment(payment.userRef, {
          paymentId: payment.paymentId,
          amountCents: payment.amountCents,
          refundedCents: payment.refundedCents ?? payment.amountCents,
          disputed: payment.status === "disputed",
          actor: "stripe-reconcile",
          note: payment.status === "disputed" ? "Stripe dispute" : "Stripe refund",
        });
        if (result?.applied) refunded += 1;
      }
    }
    await this.syncEvents().catch(() => undefined);
    await this.patchSettings({ lastSyncAt: this.now() });
    return { checked: payments.length, credited, refunded };
  }

  /** `true` when the poller has work to do. */
  async shouldPoll(): Promise<boolean> {
    const settings = await this.settings();
    if (!settings.enabled) return false;
    const credentials = await this.credentialsValue();
    return Boolean(credentials?.secret);
  }
}

export function publicPayment(payment: BrokerPayment): PublicPayment {
  return {
    paymentId: payment.paymentId,
    ...(payment.sessionId ? { sessionId: payment.sessionId } : {}),
    userRef: payment.userRef,
    kind: payment.kind,
    status: payment.status,
    amountCents: payment.amountCents,
    feeCents: payment.feeCents,
    netCents: payment.netCents,
    currency: payment.currency,
    ...(payment.creditUsd !== undefined ? { creditUsd: payment.creditUsd } : {}),
    ...(payment.planRef ? { planRef: payment.planRef } : {}),
    createdAt: payment.createdAt,
    ...(payment.paidAt ? { paidAt: payment.paidAt } : {}),
    ...(payment.refundedCents ? { refundedCents: payment.refundedCents } : {}),
  };
}

export function emptyConnect(): BrokerConnectStatus {
  return {
    status: "not_connected",
    chargesEnabled: false,
    payoutsEnabled: false,
    requirementsDue: [],
  };
}

/** Background outbox poller. Timers are unref'd so tests and CLIs can exit. */
export function startPaymentsPoller(
  service: PaymentsService,
  options: { intervalMs?: number; now?: () => number } = {},
): { stop: () => void; tick: () => Promise<void> } {
  const intervalMs = options.intervalMs ?? MARKETPLACE_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let lastReconcile = 0;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!(await service.shouldPoll())) return;
      await service.syncEvents();
      if (now() - lastReconcile > 24 * 60 * 60 * 1000) {
        lastReconcile = now();
        await service.reconcile();
      }
    } catch (error) {
      console.warn(
        `[payments] sync failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
