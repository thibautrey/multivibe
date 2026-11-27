import crypto from "node:crypto";
import { bodySignature, safeEqual, sha256 } from "./signing.js";

/**
 * Signed client for the marketplace broker.
 *
 * The instance never talks to Stripe. Every call is HMAC-signed with the
 * instance secret and every response is verified, so a compromised network
 * position cannot forge a "payment succeeded" event.
 */

export class BrokerClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerClientError";
  }
}

export type BrokerClientOptions = {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type BrokerPayment = {
  paymentId: string;
  sessionId?: string;
  kind: "topup" | "subscription";
  status: "open" | "paid" | "expired" | "refunded" | "disputed";
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
  paymentIntentId?: string;
  subscriptionId?: string;
};

export type BrokerEvent = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type BrokerConnectStatus = {
  status: "not_connected" | "pending" | "restricted" | "active";
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  accountId?: string;
  dashboardUrl?: string;
  updatedAt?: number;
};

export type BrokerInstance = {
  id: string;
  name: string;
  status: "pending_connect" | "active" | "suspended";
  commissionBps: number;
  currency: string;
  country: string;
  chargeMode: "direct" | "destination";
  livemode: boolean;
  createdAt: number;
};

export type CheckoutRequest = {
  packId?: string;
  amountCents: number;
  currency: string;
  creditUsd?: number;
  userRef: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  kind?: "topup" | "subscription";
  planRef?: string;
  interval?: "month" | "year";
  productName?: string;
};

export class BrokerClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BrokerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.secret = options.secret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async raw(
    method: string,
    path: string,
    options: { body?: string; headers?: Record<string, string>; signed: boolean },
  ): Promise<{ status: number; raw: string; headers: Headers }> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...options.headers,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.signed) {
      const timestamp = String(Date.now());
      const digest = sha256(options.body ?? "");
      const signature = crypto
        .createHmac("sha256", this.secret)
        .update(`${timestamp}.${method.toUpperCase()}.${path}.${digest}`)
        .digest("hex");
      headers.authorization = `Bearer ${this.secret}`;
      headers["x-multivibe-timestamp"] = timestamp;
      headers["x-multivibe-signature"] = signature;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await response.text();
    return { status: response.status, raw, headers: response.headers };
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const rawBody = options.body === undefined ? "" : JSON.stringify(options.body);
    const result = await this.raw(method, path, {
      body: options.body === undefined ? undefined : rawBody,
      signed: true,
      headers: options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {},
    });
    const payload = result.raw ? safeJson(result.raw) : undefined;
    const signature = result.headers.get("x-multivibe-signature");
    if (result.status >= 200 && result.status < 300) {
      if (!signature || !safeEqual(signature, bodySignature(this.secret, result.raw))) {
        throw new BrokerClientError(502, "invalid_broker_signature", "The broker response is not signed correctly.");
      }
    }
    if (result.status < 200 || result.status >= 300) {
      const error = (payload ?? {}) as { error?: string; message?: string };
      throw new BrokerClientError(
        result.status,
        error.error ?? "broker_error",
        error.message ?? `Broker request failed (${result.status})`,
      );
    }
    return payload as T;
  }

  async getInstance(): Promise<{ instance: BrokerInstance }> {
    return this.call("GET", "/v1/instance");
  }

  async connectOnboarding(input: {
    returnUrl?: string;
    refreshUrl?: string;
    email?: string;
  }): Promise<{ url: string; accountId: string; expiresAt?: number }> {
    return this.call("POST", "/v1/connect/onboarding", {
      body: input,
      // Onboarding links expire after a few minutes: bucket the key so a click
      // hours later creates a fresh link instead of replaying a dead one.
      idempotencyKey: idempotency("connect", { ...input, bucket: timeBucket() }),
    });
  }

  async connectStatus(options: {
    refresh?: boolean;
    loginLink?: boolean;
  } = {}): Promise<BrokerConnectStatus> {
    const query = new URLSearchParams();
    if (options.refresh) query.set("refresh", "1");
    if (options.loginLink) query.set("loginLink", "1");
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.call("GET", `/v1/connect${suffix}`);
  }

  async createCheckout(input: CheckoutRequest): Promise<{
    url: string;
    sessionId: string;
    paymentId: string;
    amountCents: number;
    feeCents: number;
    netCents: number;
    currency: string;
    expiresAt?: number;
  }> {
    return this.call("POST", "/v1/checkout", {
      body: input,
      // Stripe closes a Checkout session after 24 hours. A deterministic key
      // would replay that dead session on every later click, so retries are
      // only deduplicated inside a short window.
      idempotencyKey: idempotency("checkout", { ...input, bucket: timeBucket() }),
    });
  }

  async getPayment(sessionId: string): Promise<{ payment: BrokerPayment }> {
    return this.call("GET", `/v1/payments/${encodeURIComponent(sessionId)}`);
  }

  async listPayments(since = 0, limit = 100): Promise<{ payments: BrokerPayment[] }> {
    return this.call("GET", `/v1/payments?since=${since}&limit=${limit}`);
  }

  async listEvents(after: number, limit = 100): Promise<{
    events: BrokerEvent[];
    cursor: number;
    hasMore: boolean;
  }> {
    return this.call("GET", `/v1/events?after=${after}&limit=${limit}`);
  }

  async refund(input: {
    paymentId?: string;
    sessionId?: string;
    amountCents?: number;
    refundApplicationFee?: boolean;
    reason?: string;
  }): Promise<{ payment: BrokerPayment; refundId: string; amountCents: number }> {
    return this.call("POST", "/v1/refunds", {
      body: input,
      idempotencyKey: idempotency("refund", input),
    });
  }

  async earnings(): Promise<{
    currency: string;
    grossCents: number;
    feeCents: number;
    netCents: number;
    refundedCents: number;
    paidCount: number;
    payments: BrokerPayment[];
    refunds: { refundId: string; paymentId: string; amountCents: number; createdAt: number }[];
  }> {
    return this.call("GET", "/v1/earnings");
  }
}

/** Public enrollment calls do not have a secret yet. */
export async function startEnrollment(
  baseUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ code: string; deviceCode: string; verificationUrl: string; expiresAt: number }> {
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/v1/enrollments`, {
    method: "POST",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const raw = await response.text();
  const payload = raw ? safeJson(raw) : {};
  if (!response.ok) {
    throw new BrokerClientError(response.status, "enrollment_failed", "The broker refused the enrollment.");
  }
  return payload as { code: string; deviceCode: string; verificationUrl: string; expiresAt: number };
}

export async function pollEnrollment(
  baseUrl: string,
  code: string,
  deviceCode: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<
  | { status: "pending"; expiresAt: number }
  | { status: "approved"; consumed: boolean; instanceId: string; instanceSecret?: string }
> {
  const response = await (options.fetchImpl ?? fetch)(
    `${baseUrl.replace(/\/+$/, "")}/v1/enrollments/${encodeURIComponent(code)}`,
    {
      headers: { accept: "application/json", authorization: `Bearer ${deviceCode}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    },
  );
  const raw = await response.text();
  const payload = raw ? safeJson(raw) : {};
  if (!response.ok) {
    const error = payload as { error?: string; message?: string };
    throw new BrokerClientError(
      response.status,
      error.error ?? "enrollment_failed",
      error.message ?? "Enrollment polling failed.",
    );
  }
  return payload as
    | { status: "pending"; expiresAt: number }
    | { status: "approved"; consumed: boolean; instanceId: string; instanceSecret?: string };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Ten-minute window for actions whose result expires. */
function timeBucket(now = Date.now()): number {
  return Math.floor(now / 600_000);
}

function idempotency(prefix: string, input: unknown): string {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${hash}`;
}
