import crypto from "node:crypto";
import {
  bodySignature,
  enrollmentCode,
  openSecret,
  randomToken,
  sealSecret,
  sha256,
} from "./crypto.js";
import { MarketplaceStore, newId } from "./store.js";
import type { StripeGateway, StripeCheckoutSession } from "./stripe.js";
import type {
  ConnectAccount,
  Enrollment,
  Instance,
  InstanceView,
  Payment,
  PaymentKind,
  StripeEventRecord,
} from "./types.js";

export const DEFAULT_COMMISSION_BPS = 500;
export const MIN_TOPUP_CENTS = 50;
export const MAX_TOPUP_CENTS = 1_000_000;
export const MAX_CREDIT_USD = 100_000;
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export type BrokerOptions = {
  store: MarketplaceStore;
  stripe: StripeGateway;
  publicUrl: string;
  livemode: boolean;
  encryptionKey?: string;
  commissionBps?: number;
  now?: () => number;
};

export type EnrollmentTicket = {
  code: string;
  deviceCode: string;
  verificationUrl: string;
  expiresAt: number;
};

export type ConnectStatus = {
  status: "not_connected" | "pending" | "restricted" | "active";
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  accountId?: string;
  dashboardUrl?: string;
  updatedAt?: number;
};

export type PaymentView = {
  paymentId: string;
  sessionId?: string;
  kind: PaymentKind;
  status: Payment["status"];
  amountCents: number;
  feeCents: number;
  netCents: number;
  currency: string;
  creditUsd?: number;
  userRef: string;
  planRef?: string;
  interval?: "month" | "year";
  packId?: string;
  livemode: boolean;
  createdAt: number;
  paidAt?: number;
  refundedCents?: number;
};

const round = (value: number) => Math.round(value);

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function instanceView(instance: Instance): InstanceView {
  return {
    id: instance.id,
    name: instance.name,
    status: instance.status,
    commissionBps: instance.commissionBps,
    currency: instance.currency,
    country: instance.country,
    chargeMode: instance.chargeMode,
    livemode: instance.livemode,
    createdAt: instance.createdAt,
  };
}

export function paymentView(payment: Payment): PaymentView {
  return {
    paymentId: payment.id,
    ...(payment.sessionId ? { sessionId: payment.sessionId } : {}),
    kind: payment.kind,
    status: payment.status,
    amountCents: payment.amountCents,
    feeCents: payment.feeCents,
    netCents: payment.amountCents - payment.feeCents,
    currency: payment.currency,
    ...(payment.creditUsd !== undefined ? { creditUsd: payment.creditUsd } : {}),
    userRef: payment.userRef,
    ...(payment.planRef ? { planRef: payment.planRef } : {}),
    ...(payment.interval ? { interval: payment.interval } : {}),
    ...(payment.packId ? { packId: payment.packId } : {}),
    livemode: payment.livemode,
    createdAt: payment.createdAt,
    ...(payment.paidAt ? { paidAt: payment.paidAt } : {}),
    ...(payment.refundedCents ? { refundedCents: payment.refundedCents } : {}),
  };
}

export class MarketplaceBroker {
  private readonly store: MarketplaceStore;
  private readonly stripe: StripeGateway;
  private readonly publicUrl: string;
  private readonly livemode: boolean;
  private readonly encryptionKey?: string;
  private readonly defaultCommissionBps: number;
  private readonly now: () => number;

  constructor(options: BrokerOptions) {
    this.store = options.store;
    this.stripe = options.stripe;
    this.publicUrl = options.publicUrl.replace(/\/+$/, "");
    this.livemode = options.livemode;
    this.encryptionKey = options.encryptionKey;
    this.defaultCommissionBps = options.commissionBps ?? DEFAULT_COMMISSION_BPS;
    this.now = options.now ?? Date.now;
  }

  // --- Enrollment ----------------------------------------------------------

  async startEnrollment(): Promise<EnrollmentTicket> {
    const now = this.now();
    const code = enrollmentCode();
    const deviceCode = randomToken(32);
    const enrollment: Enrollment = {
      id: newId("enr"),
      code,
      deviceCodeHash: sha256(deviceCode),
      status: "pending",
      expiresAt: now + ENROLLMENT_TTL_MS,
      createdAt: now,
    };
    await this.store.createEnrollment(enrollment);
    return {
      code,
      deviceCode,
      verificationUrl: `${this.publicUrl}/enroll?code=${encodeURIComponent(code)}`,
      expiresAt: enrollment.expiresAt,
    };
  }

  /** Operator action from the browser page. */
  async claimEnrollment(
    code: string,
    input: { name: string; email?: string; country?: string; currency?: string },
  ): Promise<{ instanceId: string; name: string; status: string }> {
    const now = this.now();
    const enrollment = this.store.findEnrollmentByCode(code.trim().toUpperCase());
    if (!enrollment) throw new BrokerError(404, "enrollment_not_found", "Unknown code.");
    if (enrollment.status !== "pending") {
      throw new BrokerError(409, "enrollment_already_claimed", "This code was already used.");
    }
    if (enrollment.expiresAt < now) {
      throw new BrokerError(410, "enrollment_expired", "This code has expired.");
    }
    const name = clampText(input.name, 120) ?? "MultiVibe";
    const country = (clampText(input.country, 2) ?? "FR").toUpperCase();
    const currency = (clampText(input.currency, 3) ?? "EUR").toUpperCase();
    const secret = randomToken(32);
    const instance: Instance = {
      id: newId("ins"),
      name,
      ...(clampText(input.email, 200) ? { ownerEmail: clampText(input.email, 200) } : {}),
      secretHash: sha256(secret),
      secretSealed: sealSecret(secret, this.encryptionKey),
      status: "active",
      chargeMode: "direct",
      commissionBps: this.defaultCommissionBps,
      currency,
      country,
      livemode: this.livemode,
      createdAt: now,
    };
    await this.store.createInstance(instance);
    await this.store.updateEnrollment(enrollment.id, {
      status: "approved",
      instanceId: instance.id,
      secretSealed: sealSecret(secret, this.encryptionKey),
      requestedName: name,
      approvedAt: now,
    });
    return { instanceId: instance.id, name, status: "approved" };
  }

  /**
   * The instance polls with its long device code. The secret is handed out
   * exactly once; afterwards polling only reports the identity.
   */
  async pollEnrollment(
    code: string,
    deviceCode: string,
  ): Promise<
    | { status: "pending"; expiresAt: number }
    | { status: "approved"; consumed: boolean; instanceId: string; instanceSecret?: string }
  > {
    const enrollment = this.store.findEnrollmentByCode(code.trim().toUpperCase());
    if (!enrollment) throw new BrokerError(404, "enrollment_not_found", "Unknown code.");
    if (enrollment.deviceCodeHash !== sha256(deviceCode)) {
      throw new BrokerError(403, "invalid_device_code", "Invalid device code.");
    }
    if (enrollment.status === "pending") {
      if (enrollment.expiresAt < this.now()) {
        throw new BrokerError(410, "enrollment_expired", "This code has expired.");
      }
      return { status: "pending", expiresAt: enrollment.expiresAt };
    }
    if (!enrollment.instanceId) {
      throw new BrokerError(409, "enrollment_incomplete", "Enrollment is incomplete.");
    }
    if (enrollment.status === "consumed" || enrollment.consumedAt) {
      return { status: "approved", consumed: true, instanceId: enrollment.instanceId };
    }
    const secret = enrollment.secretSealed
      ? openSecret(enrollment.secretSealed, this.encryptionKey)
      : "";
    await this.store.updateEnrollment(enrollment.id, {
      status: "consumed",
      secretSealed: undefined,
      consumedAt: this.now(),
    });
    return {
      status: "approved",
      consumed: false,
      instanceId: enrollment.instanceId,
      instanceSecret: secret,
    };
  }

  // --- Instance authentication --------------------------------------------

  authenticate(secret: string): Instance | undefined {
    const hash = sha256(secret);
    const direct = this.store.findInstanceBySecretHash(hash);
    if (direct) return direct;
    const rotated = this.store
      .listInstances()
      .find(
        (instance) =>
          instance.prevSecretHash === hash &&
          (instance.prevSecretUntil ?? 0) > this.now(),
      );
    return rotated;
  }

  requireInstance(secret: string): Instance {
    const instance = this.authenticate(secret);
    if (!instance) throw new BrokerError(401, "unauthorized", "Unknown instance secret.");
    if (instance.livemode !== this.livemode) {
      throw new BrokerError(403, "wrong_mode", "This secret belongs to the other Stripe mode.");
    }
    return instance;
  }

  requireActiveInstance(secret: string): Instance {
    const instance = this.requireInstance(secret);
    if (instance.status !== "active") {
      throw new BrokerError(403, "instance_suspended", "This instance is suspended.");
    }
    return instance;
  }

  async rotateSecret(instance: Instance): Promise<{ instanceSecret: string; previousValidUntil: number }> {
    const secret = randomToken(32);
    const previousValidUntil = this.now() + ROTATION_WINDOW_MS;
    await this.store.updateInstance(instance.id, {
      secretHash: sha256(secret),
      secretSealed: sealSecret(secret, this.encryptionKey),
      prevSecretHash: instance.secretHash,
      prevSecretSealed: instance.secretSealed,
      prevSecretUntil: previousValidUntil,
    });
    return { instanceSecret: secret, previousValidUntil };
  }

  // --- Connect -------------------------------------------------------------

  async connectOnboarding(
    instance: Instance,
    input: { returnUrl?: string; refreshUrl?: string; email?: string },
  ): Promise<{ url: string; accountId: string; expiresAt?: number }> {
    let account = this.store.findAccountByInstance(instance.id);
    if (!account) {
      const created = await this.stripe.createAccount(
        {
          displayName: instance.name,
          country: instance.country,
          currency: instance.currency,
          instanceId: instance.id,
          livemode: instance.livemode,
          ...(clampText(input.email, 200) ?? instance.ownerEmail
            ? { email: clampText(input.email, 200) ?? instance.ownerEmail }
            : {}),
        },
        `connect-account-${instance.id}`,
      );
      account = {
        instanceId: instance.id,
        stripeAccountId: created.id,
        chargesEnabled: created.charges_enabled,
        payoutsEnabled: created.payouts_enabled,
        requirementsDue: created.requirements.currently_due,
        ...(created.country ? { country: created.country } : {}),
        livemode: instance.livemode,
        updatedAt: this.now(),
      };
      await this.store.upsertAccount(account);
    }
    const link = await this.stripe.createAccountLink(account.stripeAccountId, {
      returnUrl:
        clampText(input.returnUrl, 500) ??
        `${this.publicUrl}/connect/return?instance=${encodeURIComponent(instance.id)}`,
      refreshUrl:
        clampText(input.refreshUrl, 500) ??
        `${this.publicUrl}/connect/refresh?instance=${encodeURIComponent(instance.id)}`,
    });
    return {
      url: link.url,
      accountId: account.stripeAccountId,
      ...(link.expires_at ? { expiresAt: link.expires_at } : {}),
    };
  }

  async connectStatus(
    instance: Instance,
    options: { loginLink?: boolean; refresh?: boolean } = {},
  ): Promise<ConnectStatus> {
    let account = this.store.findAccountByInstance(instance.id);
    if (account && options.refresh) {
      try {
        const remote = await this.stripe.retrieveAccount(account.stripeAccountId);
        account = {
          ...account,
          chargesEnabled: remote.charges_enabled,
          payoutsEnabled: remote.payouts_enabled,
          requirementsDue: remote.requirements.currently_due,
          ...(remote.country ? { country: remote.country } : {}),
          livemode: instance.livemode,
          updatedAt: this.now(),
        };
        await this.store.upsertAccount(account);
      } catch {
        // Keep the last known state: a network blip must not revoke billing.
      }
    }
    if (!account) {
      return {
        status: "not_connected",
        chargesEnabled: false,
        payoutsEnabled: false,
        requirementsDue: [],
      };
    }
    let dashboardUrl: string | undefined;
    if (options.loginLink && account.chargesEnabled) {
      try {
        dashboardUrl = (await this.stripe.createLoginLink(account.stripeAccountId)).url;
      } catch {
        dashboardUrl = undefined;
      }
    }
    return {
      status: account.chargesEnabled
        ? "active"
        : account.requirementsDue.length
          ? "restricted"
          : "pending",
      chargesEnabled: account.chargesEnabled,
      payoutsEnabled: account.payoutsEnabled,
      requirementsDue: account.requirementsDue,
      accountId: account.stripeAccountId,
      ...(dashboardUrl ? { dashboardUrl } : {}),
      updatedAt: account.updatedAt,
    };
  }

  /** Resolve the connected account from our database, never from the caller. */
  private requireChargesEnabled(instance: Instance): ConnectAccount {
    const account = this.store.findAccountByInstance(instance.id);
    if (!account) {
      throw new BrokerError(409, "connect_required", "Connect Stripe before selling credit.");
    }
    if (!account.chargesEnabled) {
      throw new BrokerError(
        409,
        "connect_restricted",
        "Stripe onboarding is incomplete: card payments are not enabled yet.",
      );
    }
    return account;
  }

  // --- Checkout ------------------------------------------------------------

  async createCheckout(
    instance: Instance,
    input: unknown,
  ): Promise<{
    url: string;
    sessionId: string;
    paymentId: string;
    amountCents: number;
    feeCents: number;
    netCents: number;
    currency: string;
    expiresAt?: number;
  }> {
    const body = (input ?? {}) as Record<string, unknown>;
    const account = this.requireChargesEnabled(instance);
    const amountCents = Number(body.amountCents);
    if (
      !Number.isInteger(amountCents) ||
      amountCents < MIN_TOPUP_CENTS ||
      amountCents > MAX_TOPUP_CENTS
    ) {
      throw new BrokerError(
        400,
        "invalid_amount",
        `Amount must be an integer between ${MIN_TOPUP_CENTS} and ${MAX_TOPUP_CENTS} cents.`,
      );
    }
    const currency = String(body.currency ?? instance.currency).toUpperCase();
    if (currency !== instance.currency.toUpperCase()) {
      throw new BrokerError(400, "invalid_currency", "This instance sells in another currency.");
    }
    const kind: PaymentKind = body.kind === "subscription" ? "subscription" : "topup";
    const interval = body.interval === "year" ? "year" : "month";
    const userRef = clampText(body.userRef, 120);
    if (!userRef) throw new BrokerError(400, "invalid_user", "A member reference is required.");
    const creditUsd = body.creditUsd === undefined ? undefined : Number(body.creditUsd);
    if (
      creditUsd !== undefined &&
      (!Number.isFinite(creditUsd) || creditUsd <= 0 || creditUsd > MAX_CREDIT_USD)
    ) {
      throw new BrokerError(400, "invalid_credit", "Credit must be a positive amount.");
    }
    const planRef = clampText(body.planRef, 120);
    if (kind === "subscription" && !planRef) {
      throw new BrokerError(400, "invalid_plan", "A plan reference is required.");
    }
    if (kind === "topup" && creditUsd === undefined) {
      throw new BrokerError(400, "invalid_credit", "A top-up must grant credit.");
    }
    const successUrl = clampText(body.successUrl, 500);
    if (!successUrl) throw new BrokerError(400, "invalid_url", "A success URL is required.");
    const cancelUrl = clampText(body.cancelUrl, 500) ?? successUrl;
    const paymentId = newId("pay");
    const feeCents = round((amountCents * instance.commissionBps) / 10_000);
    const payment: Payment = {
      id: paymentId,
      instanceId: instance.id,
      kind,
      status: "open",
      amountCents,
      feeCents,
      currency,
      ...(creditUsd !== undefined ? { creditUsd } : {}),
      userRef,
      ...(planRef ? { planRef } : {}),
      ...(kind === "subscription" ? { interval } : {}),
      ...(clampText(body.packId, 120) ? { packId: clampText(body.packId, 120) } : {}),
      successUrl,
      cancelUrl,
      idempotencyKey: `checkout-${paymentId}`,
      livemode: instance.livemode,
      createdAt: this.now(),
    };
    await this.store.createCheckoutIntent(payment);
    let session: StripeCheckoutSession;
    try {
      session = await this.stripe.createCheckoutSession(
        {
          instanceId: instance.id,
          paymentId,
          amountCents,
          feeCents,
          commissionBps: instance.commissionBps,
          currency,
          productName: clampText(body.productName, 120) ?? "MultiVibe credit",
          ...(clampText(body.productDescription, 300)
            ? { productDescription: clampText(body.productDescription, 300) }
            : {}),
          kind,
          ...(kind === "subscription" ? { interval } : {}),
          userRef,
          ...(clampText(body.customerEmail, 200)
            ? { customerEmail: clampText(body.customerEmail, 200) }
            : {}),
          successUrl: `${this.publicUrl}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${this.publicUrl}/checkout/cancel?session_id={CHECKOUT_SESSION_ID}`,
          ...(kind === "subscription"
            ? { applicationFeePercent: Math.round((instance.commissionBps / 100) * 100) / 100 }
            : {}),
          metadata: {
            instance_id: instance.id,
            payment_id: paymentId,
            user_ref: userRef,
            kind,
            ...(creditUsd !== undefined ? { credit_usd: String(creditUsd) } : {}),
            ...(planRef ? { plan_ref: planRef } : {}),
          },
        },
        instance.chargeMode === "direct" ? account.stripeAccountId : undefined,
        `checkout-${paymentId}`,
      );
    } catch (error) {
      await this.store.updatePayment(paymentId, { status: "expired" });
      throw error;
    }
    await this.store.updatePayment(paymentId, { sessionId: session.id });
    return {
      url: session.url,
      sessionId: session.id,
      paymentId,
      amountCents,
      feeCents,
      netCents: amountCents - feeCents,
      currency,
      ...(session.expires_at ? { expiresAt: session.expires_at } : {}),
    };
  }

  findPayment(instance: Instance, paymentId: string): Payment {
    const payment = this.store.findPayment(paymentId);
    if (!payment || payment.instanceId !== instance.id) {
      throw new BrokerError(404, "payment_not_found", "Unknown payment.");
    }
    return payment;
  }

  /**
   * Verified status for one session. When the webhook never arrived (outage,
   * local Stripe CLI not running) the broker asks Stripe directly, as the
   * connected account for a direct charge.
   */
  async paymentStatus(instance: Instance, sessionId: string): Promise<PaymentView> {
    let payment = this.store.findPaymentBySession(sessionId);
    if (!payment || payment.instanceId !== instance.id) {
      throw new BrokerError(404, "payment_not_found", "Unknown checkout session.");
    }
    if (payment.status === "open") {
      const account = this.store.findAccountByInstance(instance.id);
      try {
        const session = await this.stripe.retrieveCheckoutSession(
          sessionId,
          instance.chargeMode === "direct" ? account?.stripeAccountId : undefined,
        );
        if (session.payment_status === "paid") {
          payment = (await this.markPaid(payment, session)) ?? payment;
        } else if (session.status === "expired") {
          payment = (await this.markExpired(payment)) ?? payment;
        }
      } catch {
        // Stripe unreachable: return the last known state, the poller retries.
      }
    }
    return paymentView(payment);
  }

  listPayments(instance: Instance, since: number, limit: number): PaymentView[] {
    return this.store.listPayments(instance.id, since, limit).map(paymentView);
  }

  // --- State transitions ---------------------------------------------------

  private async markPaid(payment: Payment, session: StripeCheckoutSession): Promise<Payment | undefined> {
    if (payment.status !== "open") return payment;
    const now = this.now();
    const updated = await this.store.updatePayment(payment.id, {
      status: "paid",
      paidAt: now,
      ...(session.payment_intent ? { paymentIntentId: session.payment_intent } : {}),
      ...(session.subscription ? { subscriptionId: session.subscription } : {}),
    });
    if (!updated) return undefined;
    await this.store.appendEvent(
      payment.instanceId,
      "payment.succeeded",
      {
        ...paymentView(updated),
        ...(updated.paymentIntentId ? { paymentIntentId: updated.paymentIntentId } : {}),
        ...(updated.subscriptionId ? { subscriptionId: updated.subscriptionId } : {}),
      },
      session.id,
      now,
    );
    return updated;
  }

  private async markExpired(payment: Payment): Promise<Payment | undefined> {
    if (payment.status !== "open") return payment;
    const now = this.now();
    const updated = await this.store.updatePayment(payment.id, { status: "expired" });
    if (!updated) return undefined;
    await this.store.appendEvent(
      payment.instanceId,
      "checkout.expired",
      { paymentId: updated.id, sessionId: updated.sessionId, userRef: updated.userRef },
      updated.sessionId,
      now,
    );
    return updated;
  }

  private async emitRefund(payment: Payment): Promise<Payment> {
    const total = payment.refundedCents ?? 0;
    const emitted = payment.refundEventCents ?? 0;
    if (total <= emitted) return payment;
    const updated = await this.store.updatePayment(payment.id, { refundEventCents: total });
    if (!updated) return payment;
    await this.store.appendEvent(
      payment.instanceId,
      "payment.refunded",
      {
        ...paymentView(updated),
        refundedCents: total,
      },
      undefined,
      this.now(),
    );
    return updated;
  }

  // --- Refunds -------------------------------------------------------------

  async refund(
    instance: Instance,
    input: unknown,
  ): Promise<{ payment: PaymentView; refundId: string; amountCents: number }> {
    const body = (input ?? {}) as Record<string, unknown>;
    const paymentId = clampText(body.paymentId, 120);
    const sessionId = clampText(body.sessionId, 200);
    let payment = paymentId
      ? this.store.findPayment(paymentId)
      : sessionId
        ? this.store.findPaymentBySession(sessionId)
        : undefined;
    if (!payment || payment.instanceId !== instance.id) {
      throw new BrokerError(404, "payment_not_found", "Unknown payment.");
    }
    if (payment.status !== "paid" && payment.status !== "refunded") {
      throw new BrokerError(409, "not_refundable", "Only a paid payment can be refunded.");
    }
    if (!payment.paymentIntentId) {
      throw new BrokerError(409, "not_refundable", "This payment has no payment intent.");
    }
    const already = payment.refundedCents ?? 0;
    const remaining = payment.amountCents - already;
    if (remaining <= 0) {
      throw new BrokerError(409, "already_refunded", "This payment is fully refunded.");
    }
    const requested = body.amountCents === undefined ? remaining : Number(body.amountCents);
    if (!Number.isInteger(requested) || requested <= 0 || requested > remaining) {
      throw new BrokerError(400, "invalid_amount", "Refund amount exceeds the payment.");
    }
    const account = this.store.findAccountByInstance(instance.id);
    const refund = await this.stripe.createRefund(
      {
        paymentIntentId: payment.paymentIntentId,
        amountCents: requested,
        refundApplicationFee: body.refundApplicationFee === true,
        ...(body.reason === "duplicate" || body.reason === "fraudulent" || body.reason === "requested_by_customer"
          ? { reason: body.reason }
          : {}),
        metadata: { payment_id: payment.id, instance_id: instance.id },
      },
      instance.chargeMode === "direct" ? account?.stripeAccountId : undefined,
      `refund-${payment.id}-${already + requested}`,
    );
    await this.store.addRefund({
      id: newId("ref"),
      instanceId: instance.id,
      paymentId: payment.id,
      stripeRefundId: refund.id,
      amountCents: refund.amount,
      createdAt: this.now(),
    });
    const total = already + refund.amount;
    payment = (await this.store.updatePayment(payment.id, {
      refundedCents: total,
      status: total >= payment.amountCents ? "refunded" : "paid",
    })) ?? payment;
    payment = await this.emitRefund(payment);
    return { payment: paymentView(payment), refundId: refund.id, amountCents: refund.amount };
  }

  // --- Earnings ------------------------------------------------------------

  earnings(instance: Instance): {
    currency: string;
    grossCents: number;
    feeCents: number;
    netCents: number;
    refundedCents: number;
    paidCount: number;
    payments: PaymentView[];
    refunds: { refundId: string; paymentId: string; amountCents: number; createdAt: number }[];
  } {
    const payments = this.store.listPayments(instance.id, 0, 500);
    const paid = payments.filter(
      (payment) => payment.status === "paid" || payment.status === "refunded",
    );
    const grossCents = paid.reduce((total, payment) => total + payment.amountCents, 0);
    const feeCents = paid.reduce((total, payment) => total + payment.feeCents, 0);
    const refundedCents = paid.reduce(
      (total, payment) => total + (payment.refundedCents ?? 0),
      0,
    );
    return {
      currency: instance.currency,
      grossCents,
      feeCents,
      netCents: grossCents - feeCents - refundedCents,
      refundedCents,
      paidCount: paid.length,
      payments: paid.slice(0, 50).map(paymentView),
      refunds: this.store
        .listRefunds(instance.id)
        .slice(-50)
        .map((refund) => ({
          refundId: refund.stripeRefundId,
          paymentId: refund.paymentId,
          amountCents: refund.amountCents,
          createdAt: refund.createdAt,
        })),
    };
  }

  // --- Events outbox -------------------------------------------------------

  listEvents(instanceId: string, after: number, limit: number): {
    events: { seq: number; type: string; payload: Record<string, unknown>; createdAt: number }[];
    cursor: number;
    hasMore: boolean;
  } {
    const upTo = Math.min(200, Math.max(1, limit));
    const events = this.store.listEvents(instanceId, after, upTo + 1);
    const page = events.slice(0, upTo);
    return {
      events: page.map((event) => ({
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
      cursor: page.at(-1)?.seq ?? after,
      hasMore: events.length > upTo,
    };
  }

  signPayload(secret: string, body: string): string {
    return bodySignature(secret, body);
  }

  /** Raw secret is needed for response signing; only the broker can open it. */
  secretFor(instance: Instance): string {
    return openSecret(instance.secretSealed, this.encryptionKey);
  }

  // --- Stripe webhooks -----------------------------------------------------

  async handleStripeEvent(
    event: { id: string; type: string; account?: string; livemode?: boolean; data: { object: Record<string, unknown> } },
    scope: "platform" | "connect",
  ): Promise<{ handled: boolean; duplicate: boolean; reason?: string }> {
    const id = String(event.id ?? "");
    const type = String(event.type ?? "");
    if (!id || !type) throw new BrokerError(400, "invalid_event", "Malformed Stripe event.");
    const livemode = Boolean(event.livemode);
    if (livemode !== this.livemode) {
      const record: StripeEventRecord = {
        id,
        type,
        ...(event.account ? { account: event.account } : {}),
        livemode,
        receivedAt: this.now(),
      };
      await this.store.recordStripeEvent(record);
      return { handled: false, duplicate: false, reason: "wrong_mode" };
    }
    const inserted = await this.store.recordStripeEvent({
      id,
      type,
      ...(event.account ? { account: event.account } : {}),
      livemode,
      receivedAt: this.now(),
    });
    if (!inserted) return { handled: false, duplicate: true };
    const object = event.data?.object ?? {};
    if (scope === "connect" && !event.account) {
      return { handled: false, duplicate: false, reason: "missing_account" };
    }
    switch (type) {
      case "checkout.session.completed": {
        const payment = this.store.findPaymentBySession(String(object.id ?? ""));
        if (!payment) return { handled: false, duplicate: false, reason: "unknown_session" };
        if (object.payment_status && object.payment_status !== "paid") {
          return { handled: false, duplicate: false, reason: "not_paid" };
        }
        const session: StripeCheckoutSession = {
          id: String(object.id ?? ""),
          url: "",
          ...(typeof object.payment_intent === "string"
            ? { payment_intent: object.payment_intent }
            : {}),
          ...(typeof object.subscription === "string"
            ? { subscription: object.subscription }
            : {}),
        };
        await this.markPaid(payment, session);
        return { handled: true, duplicate: false };
      }
      case "checkout.session.expired": {
        const payment = this.store.findPaymentBySession(String(object.id ?? ""));
        if (!payment) return { handled: false, duplicate: false, reason: "unknown_session" };
        await this.markExpired(payment);
        return { handled: true, duplicate: false };
      }
      case "charge.refunded":
      case "charge.refund.updated": {
        const intent = String(object.payment_intent ?? "");
        const payment = intent ? this.store.findPaymentByIntent(intent) : undefined;
        if (!payment) return { handled: false, duplicate: false, reason: "unknown_payment" };
        const refunded = Number(object.amount_refunded ?? 0);
        const updated =
          (await this.store.updatePayment(payment.id, {
            refundedCents: refunded,
            status: refunded >= payment.amountCents ? "refunded" : "paid",
          })) ?? payment;
        await this.emitRefund(updated);
        return { handled: true, duplicate: false };
      }
      case "charge.dispute.created":
      case "charge.dispute.funds_withdrawn": {
        const intent = String(object.payment_intent ?? "");
        const payment = intent ? this.store.findPaymentByIntent(intent) : undefined;
        if (!payment) return { handled: false, duplicate: false, reason: "unknown_payment" };
        const updated =
          (await this.store.updatePayment(payment.id, { status: "disputed" })) ?? payment;
        await this.store.appendEvent(
          payment.instanceId,
          "payment.disputed",
          {
            ...paymentView(updated),
            reason: String(object.reason ?? "dispute"),
            amountCents: Number(object.amount ?? payment.amountCents),
          },
          id,
          this.now(),
        );
        return { handled: true, duplicate: false };
      }
      case "account.updated":
      case "capability.updated": {
        const accountId = event.account ?? String(object.account ?? object.id ?? "");
        const account = this.store.findAccountByStripeId(accountId);
        if (!account) return { handled: false, duplicate: false, reason: "unknown_account" };
        const capabilities = (object.capabilities ?? {}) as Record<string, unknown>;
        const card = (capabilities.card_payments ?? {}) as Record<string, unknown>;
        const chargesEnabled =
          object.charges_enabled === true || card.status === "active";
        const requirements = (object.requirements ?? {}) as Record<string, unknown>;
        const due = Array.isArray(requirements.currently_due)
          ? (requirements.currently_due as unknown[]).map(String)
          : account.requirementsDue;
        const updated: ConnectAccount = {
          ...account,
          chargesEnabled,
          payoutsEnabled: Boolean(object.payouts_enabled ?? account.payoutsEnabled),
          requirementsDue: due,
          updatedAt: this.now(),
        };
        await this.store.upsertAccount(updated);
        await this.store.appendEvent(
          account.instanceId,
          "connect.updated",
          {
            status: due.length ? "restricted" : chargesEnabled ? "active" : "pending",
            chargesEnabled,
            payoutsEnabled: updated.payoutsEnabled,
            requirementsDue: due,
          },
          id,
          this.now(),
        );
        return { handled: true, duplicate: false };
      }
      default:
        return { handled: false, duplicate: false, reason: "ignored" };
    }
  }

  // --- Operator ------------------------------------------------------------

  listInstances(): (InstanceView & { connected: boolean; chargesEnabled: boolean })[] {
    return this.store.listInstances().map((instance) => {
      const account = this.store.findAccountByInstance(instance.id);
      return {
        ...instanceView(instance),
        connected: Boolean(account),
        chargesEnabled: account?.chargesEnabled ?? false,
      };
    });
  }

  async setCommission(instanceId: string, commissionBps: number): Promise<InstanceView> {
    if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 3000) {
      throw new BrokerError(400, "invalid_commission", "Commission must be 0–3000 bps.");
    }
    const instance = await this.store.updateInstance(instanceId, { commissionBps });
    if (!instance) throw new BrokerError(404, "instance_not_found", "Unknown instance.");
    return instanceView(instance);
  }

  async setSuspended(instanceId: string, suspended: boolean): Promise<InstanceView> {
    const instance = suspended
      ? await this.store.suspendInstance(instanceId)
      : await this.store.resumeInstance(instanceId);
    if (!instance) throw new BrokerError(404, "instance_not_found", "Unknown instance.");
    return instanceView(instance);
  }

  operatorPayments(limit = 500): PaymentView[] {
    return this.store.listAllPayments(limit).map(paymentView);
  }

  /** Deep link the instance can display after the Stripe flow. */
  instanceReturnUrl(payment: Payment, outcome: "success" | "cancel"): string | undefined {
    if (outcome === "success") return payment.successUrl;
    return payment.cancelUrl;
  }

  findPaymentById(paymentId: string): Payment | undefined {
    return this.store.findPayment(paymentId);
  }

  /** Stable hash helper used by the app to build signatures in tests. */
  static requestHash(body: string): string {
    return crypto.createHash("sha256").update(body).digest("hex");
  }
}
