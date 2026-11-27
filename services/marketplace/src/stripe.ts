/**
 * Minimal Stripe client.
 *
 * The broker only needs a handful of calls, so it uses the REST API directly
 * instead of shipping the SDK: fewer dependencies in a service that must run
 * next to self-hosted instances. The interface is also what the tests fake.
 */

export type StripeAccount = {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements: { currently_due: string[] };
  country?: string;
  livemode: boolean;
};

export type StripeAccountLink = {
  url: string;
  expires_at?: number;
};

export type StripeCheckoutSession = {
  id: string;
  url: string;
  expires_at?: number;
  amount_total?: number;
  payment_status?: "paid" | "unpaid" | "no_payment_required";
  status?: "open" | "complete" | "expired";
  payment_intent?: string;
  subscription?: string;
  live_mode?: boolean;
  livemode?: boolean;
};

export type StripeRefund = {
  id: string;
  amount: number;
  status: string;
  charge?: string;
  payment_intent?: string;
};

export type CreateAccountInput = {
  email?: string;
  displayName: string;
  country: string;
  currency: string;
  instanceId: string;
  livemode: boolean;
};

export type CreateCheckoutInput = {
  instanceId: string;
  paymentId: string;
  amountCents: number;
  feeCents: number;
  commissionBps: number;
  currency: string;
  productName: string;
  productDescription?: string;
  kind: "topup" | "subscription";
  interval?: "month" | "year";
  userRef: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  applicationFeePercent?: number;
  metadata: Record<string, string>;
};

export type CreateRefundInput = {
  paymentIntentId: string;
  amountCents?: number;
  refundApplicationFee: boolean;
  reason?: string;
  metadata?: Record<string, string>;
};

export interface StripeGateway {
  createAccount(input: CreateAccountInput, idempotencyKey: string): Promise<StripeAccount>;
  createAccountLink(
    accountId: string,
    input: { returnUrl: string; refreshUrl: string },
  ): Promise<StripeAccountLink>;
  createLoginLink(accountId: string): Promise<{ url: string }>;
  retrieveAccount(accountId: string): Promise<StripeAccount>;
  createCheckoutSession(
    input: CreateCheckoutInput,
    stripeAccountId: string | undefined,
    idempotencyKey: string,
  ): Promise<StripeCheckoutSession>;
  retrieveCheckoutSession(
    sessionId: string,
    stripeAccountId?: string,
  ): Promise<StripeCheckoutSession>;
  createRefund(
    input: CreateRefundInput,
    stripeAccountId: string | undefined,
    idempotencyKey: string,
  ): Promise<StripeRefund>;
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

function flatten(
  value: unknown,
  prefix: string,
  output: URLSearchParams,
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, `${prefix}[${index}]`, output));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      flatten(entry, prefix ? `${prefix}[${key}]` : key, output);
    }
    return;
  }
  output.append(prefix, String(value));
}

function formBody(value: Record<string, unknown>): string {
  const output = new URLSearchParams();
  flatten(value, "", output);
  return output.toString();
}

export type StripeClientOptions = {
  secretKey: string;
  apiVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class StripeRestClient implements StripeGateway {
  private readonly secretKey: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StripeClientOptions) {
    this.secretKey = options.secretKey;
    this.apiVersion = options.apiVersion ?? "2026-11-18.preview";
    this.baseUrl = (options.baseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: Record<string, unknown>;
      stripeAccount?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      "stripe-version": this.apiVersion,
    };
    if (options.stripeAccount) headers["stripe-account"] = options.stripeAccount;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    let body: string | undefined;
    if (options.body) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = formBody(options.body);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body,
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = (payload.error ?? {}) as { message?: string; code?: string };
      throw new StripeError(
        response.status,
        error.code,
        error.message ?? `Stripe request failed (${response.status})`,
      );
    }
    return payload as T;
  }

  async createAccount(
    input: CreateAccountInput,
    idempotencyKey: string,
  ): Promise<StripeAccount> {
    const payload = await this.request<Record<string, unknown>>("POST", "/v2/core/accounts", {
      idempotencyKey,
      body: {
        display_name: input.displayName.slice(0, 120),
        ...(input.email ? { contact_email: input.email } : {}),
        dashboard: "express",
        identity: { country: input.country },
        configuration: {
          merchant: { capabilities: { card_payments: { requested: true } } },
        },
        defaults: {
          currency: input.currency.toLowerCase(),
          responsibilities: {
            fees_collector: "stripe",
            losses_collector: "stripe",
          },
          locales: ["fr-FR", "en-US"],
        },
        metadata: { instance_id: input.instanceId, platform: "multivibe" },
        include: [
          "configuration.merchant",
          "identity",
          "requirements",
        ],
      },
    });
    return normalizeAccount(payload, input.livemode);
  }

  async createAccountLink(
    accountId: string,
    input: { returnUrl: string; refreshUrl: string },
  ): Promise<StripeAccountLink> {
    const payload = await this.request<Record<string, unknown>>(
      "POST",
      "/v2/core/account_links",
      {
        body: {
          account: accountId,
          use_case: {
            type: "account_onboarding",
            account_onboarding: {
              configurations: ["merchant"],
              return_url: input.returnUrl,
              refresh_url: input.refreshUrl,
            },
          },
        },
      },
    );
    return {
      url: String(payload.url ?? ""),
      ...(typeof payload.expires_at === "number" ? { expires_at: payload.expires_at } : {}),
    };
  }

  async createLoginLink(accountId: string): Promise<{ url: string }> {
    const payload = await this.request<Record<string, unknown>>(
      "POST",
      `/v1/accounts/${encodeURIComponent(accountId)}/login_links`,
    );
    return { url: String(payload.url ?? "") };
  }

  async retrieveAccount(accountId: string): Promise<StripeAccount> {
    const payload = await this.request<Record<string, unknown>>(
      "GET",
      `/v2/core/accounts/${encodeURIComponent(accountId)}?include[]=configuration.merchant&include[]=requirements&include[]=identity`,
    );
    return normalizeAccount(payload, Boolean(payload.livemode));
  }

  async createCheckoutSession(
    input: CreateCheckoutInput,
    stripeAccountId: string | undefined,
    idempotencyKey: string,
  ): Promise<StripeCheckoutSession> {
    const metadata: Record<string, string> = { ...input.metadata };
    const lineItem = {
      quantity: 1,
      price_data: {
        currency: input.currency.toLowerCase(),
        unit_amount: input.amountCents,
        product_data: {
          name: input.productName.slice(0, 250),
          ...(input.productDescription
            ? { description: input.productDescription.slice(0, 500) }
            : {}),
        },
        ...(input.kind === "subscription"
          ? { recurring: { interval: input.interval ?? "month" } }
          : {}),
      },
    };
    const body: Record<string, unknown> = {
      mode: input.kind === "subscription" ? "subscription" : "payment",
      line_items: [lineItem],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.userRef,
      metadata,
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    };
    if (input.kind === "subscription") {
      body.subscription_data = {
        metadata,
        ...(input.applicationFeePercent !== undefined
          ? { application_fee_percent: input.applicationFeePercent }
          : {}),
      };
    } else {
      body.payment_intent_data = {
        metadata,
        ...(input.feeCents > 0 ? { application_fee_amount: input.feeCents } : {}),
      };
    }
    const payload = await this.request<Record<string, unknown>>(
      "POST",
      "/v1/checkout/sessions",
      { body, stripeAccount: stripeAccountId, idempotencyKey },
    );
    return normalizeSession(payload);
  }

  async retrieveCheckoutSession(
    sessionId: string,
    stripeAccountId?: string,
  ): Promise<StripeCheckoutSession> {
    const payload = await this.request<Record<string, unknown>>(
      "GET",
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { stripeAccount: stripeAccountId },
    );
    return normalizeSession(payload);
  }

  async createRefund(
    input: CreateRefundInput,
    stripeAccountId: string | undefined,
    idempotencyKey: string,
  ): Promise<StripeRefund> {
    const payload = await this.request<Record<string, unknown>>("POST", "/v1/refunds", {
      stripeAccount: stripeAccountId,
      idempotencyKey,
      body: {
        payment_intent: input.paymentIntentId,
        ...(input.amountCents ? { amount: input.amountCents } : {}),
        ...(input.refundApplicationFee ? { refund_application_fee: true } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    });
    return {
      id: String(payload.id ?? ""),
      amount: Number(payload.amount ?? 0),
      status: String(payload.status ?? "pending"),
      ...(typeof payload.charge === "string" ? { charge: payload.charge } : {}),
      ...(typeof payload.payment_intent === "string"
        ? { payment_intent: payload.payment_intent }
        : {}),
    };
  }
}

function normalizeSession(payload: Record<string, unknown>): StripeCheckoutSession {
  return {
    id: String(payload.id ?? ""),
    url: String(payload.url ?? ""),
    ...(typeof payload.expires_at === "number" ? { expires_at: payload.expires_at } : {}),
    ...(typeof payload.amount_total === "number" ? { amount_total: payload.amount_total } : {}),
    ...(payload.payment_status
      ? { payment_status: payload.payment_status as StripeCheckoutSession["payment_status"] }
      : {}),
    ...(payload.status ? { status: payload.status as StripeCheckoutSession["status"] } : {}),
    ...(typeof payload.payment_intent === "string"
      ? { payment_intent: payload.payment_intent }
      : {}),
    ...(typeof payload.subscription === "string" ? { subscription: payload.subscription } : {}),
    livemode: Boolean(payload.livemode),
  };
}

function normalizeAccount(payload: Record<string, unknown>, fallbackLivemode: boolean): StripeAccount {
  const configuration = (payload.configuration ?? {}) as Record<string, unknown>;
  const merchant = (configuration.merchant ?? {}) as Record<string, unknown>;
  const capabilities = (merchant.capabilities ?? {}) as Record<string, unknown>;
  const card = (capabilities.card_payments ?? {}) as Record<string, unknown>;
  const requirements = (payload.requirements ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(requirements.entries)
    ? (requirements.entries as Record<string, unknown>[])
    : [];
  const due: string[] = [];
  for (const entry of entries) {
    const impacted = Array.isArray(entry.impacted_capabilities)
      ? (entry.impacted_capabilities as unknown[]).map(String)
      : [];
    if (entry.awaiting_action && impacted.includes("card_payments")) {
      due.push(String(entry.description ?? entry.code ?? "requirement"));
    }
  }
  const chargesEnabled =
    card.status === "active" ||
    (payload.charges_enabled === true);
  return {
    id: String(payload.id ?? ""),
    charges_enabled: chargesEnabled,
    payouts_enabled: Boolean(payload.payouts_enabled ?? meridianPayouts(card)),
    requirements: { currently_due: due },
    ...(typeof payload.country === "string"
      ? { country: payload.country }
      : typeof (payload.identity as Record<string, unknown> | undefined)?.country === "string"
        ? { country: String((payload.identity as Record<string, unknown>).country) }
        : {}),
    livemode: Boolean(payload.livemode ?? fallbackLivemode),
  };
}

/** v2 exposes payouts through the merchant configuration's status. */
function meridianPayouts(card: Record<string, unknown>): boolean {
  const statusDetails = (card.status_details ?? {}) as Record<string, unknown>;
  return statusDetails.payouts_enabled === true;
}
