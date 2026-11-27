/**
 * Marketplace broker data model.
 *
 * The broker is the durable source of truth for Connect accounts, checkout
 * intents, payments, refunds and the per-instance event outbox. Instances never
 * talk to Stripe and never need to be publicly reachable: they pull events.
 */

export type InstanceStatus = "pending_connect" | "active" | "suspended";

export type Instance = {
  id: string;
  name: string;
  ownerEmail?: string;
  /** SHA-256 of the instance secret, used to find the instance on each call. */
  secretHash: string;
  /** AES-256-GCM sealed secret, or `plain:<base64>` without an encryption key. */
  secretSealed: string;
  /** Previous secret during a rotation window. */
  prevSecretHash?: string;
  prevSecretSealed?: string;
  prevSecretUntil?: number;
  status: InstanceStatus;
  chargeMode: "direct" | "destination";
  /** Platform commission for this instance, in basis points (500 = 5%). */
  commissionBps: number;
  /** Sale currency for this instance (ISO 4217). */
  currency: string;
  country: string;
  livemode: boolean;
  createdAt: number;
  suspendedAt?: number;
};

export type InstanceView = {
  id: string;
  name: string;
  status: InstanceStatus;
  commissionBps: number;
  currency: string;
  country: string;
  chargeMode: "direct" | "destination";
  livemode: boolean;
  createdAt: number;
};

export type EnrollmentStatus = "pending" | "approved" | "consumed";

export type Enrollment = {
  id: string;
  /** Short human code typed on the broker approval page. */
  code: string;
  /** SHA-256 of the long device code kept by the instance. */
  deviceCodeHash: string;
  status: EnrollmentStatus;
  instanceId?: string;
  /** Secret handed to the instance once, sealed until pickup. */
  secretSealed?: string;
  /** Instance name typed by whoever approves the code. */
  requestedName?: string;
  expiresAt: number;
  createdAt: number;
  approvedAt?: number;
  consumedAt?: number;
};

export type ConnectAccount = {
  instanceId: string;
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  country?: string;
  livemode: boolean;
  updatedAt: number;
};

export type PaymentKind = "topup" | "subscription";
export type PaymentStatus = "open" | "paid" | "expired" | "refunded" | "disputed";

export type Payment = {
  id: string;
  instanceId: string;
  sessionId?: string;
  paymentIntentId?: string;
  subscriptionId?: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amountCents: number;
  feeCents: number;
  currency: string;
  /** Credit granted by a top-up, in USD. */
  creditUsd?: number;
  /** Opaque member reference chosen by the instance. */
  userRef: string;
  /** Opaque plan reference for a subscription. */
  planRef?: string;
  /** Billing interval for a subscription payment. */
  interval?: "month" | "year";
  /** Opaque pack reference, for the instance's own reconciliation. */
  packId?: string;
  /** Where the broker redirects the browser once Stripe is done. */
  successUrl?: string;
  cancelUrl?: string;
  idempotencyKey: string;
  livemode: boolean;
  createdAt: number;
  paidAt?: number;
  refundedCents?: number;
  /** Set once the refund event has been emitted to the outbox. */
  refundEventCents?: number;
};

export type RefundRecord = {
  id: string;
  instanceId: string;
  paymentId: string;
  stripeRefundId: string;
  amountCents: number;
  createdAt: number;
};

export type OutboxEvent = {
  /** Monotonic cursor per instance. */
  seq: number;
  instanceId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
  stripeEventId?: string;
};

export type StripeEventRecord = {
  id: string;
  type: string;
  account?: string;
  livemode: boolean;
  receivedAt: number;
};

export type IdempotencyRecord = {
  instanceId: string;
  key: string;
  requestHash: string;
  statusCode: number;
  body: unknown;
  createdAt: number;
};

export type MarketplaceData = {
  schemaVersion: 1;
  instances: Instance[];
  enrollments: Enrollment[];
  accounts: ConnectAccount[];
  payments: Payment[];
  refunds: RefundRecord[];
  outbox: OutboxEvent[];
  stripeEvents: StripeEventRecord[];
  idempotency: IdempotencyRecord[];
  /** Last event sequence handed out, per instance. */
  counters: Record<string, number>;
};

export function emptyData(): MarketplaceData {
  return {
    schemaVersion: 1,
    instances: [],
    enrollments: [],
    accounts: [],
    payments: [],
    refunds: [],
    outbox: [],
    stripeEvents: [],
    idempotency: [],
    counters: {},
  };
}
