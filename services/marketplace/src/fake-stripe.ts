import crypto from "node:crypto";
import type {
  CreateAccountInput,
  CreateCheckoutInput,
  CreateRefundInput,
  StripeAccount,
  StripeAccountLink,
  StripeCheckoutSession,
  StripeGateway,
  StripeInvoice,
  StripeRefund,
} from "./stripe.js";

export function signature(secret: string, method: string, path: string, body = ""): {
  timestamp: string;
  signature: string;
} {
  const timestamp = String(Date.now());
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const value = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${method.toUpperCase()}.${path}.${digest}`)
    .digest("hex");
  return { timestamp, signature: value };
}

/** In-memory Stripe used by the broker tests; no network, no real keys. */
export class FakeStripe implements StripeGateway {
  accounts = new Map<string, StripeAccount>();
  sessions = new Map<string, StripeCheckoutSession>();
  invoices = new Map<string, StripeInvoice>();
  refunds = new Map<string, StripeRefund>();
  checkoutCalls: { input: CreateCheckoutInput; account?: string }[] = [];
  refundCalls: { input: CreateRefundInput; account?: string }[] = [];
  accountLinks = 0;
  private counter = 0;

  async createAccount(input: CreateAccountInput): Promise<StripeAccount> {
    const id = `acct_test_${++this.counter}`;
    const account: StripeAccount = {
      id,
      charges_enabled: false,
      payouts_enabled: false,
      requirements: { currently_due: ["business_profile.url"] },
      country: input.country,
      livemode: input.livemode,
    };
    this.accounts.set(id, account);
    return structuredClone(account);
  }

  async createAccountLink(accountId: string): Promise<StripeAccountLink> {
    this.accountLinks += 1;
    return { url: `https://connect.stripe.test/${accountId}`, expires_at: Date.now() + 300_000 };
  }

  async createLoginLink(accountId: string): Promise<{ url: string }> {
    return { url: `https://dashboard.stripe.test/${accountId}` };
  }

  async retrieveAccount(accountId: string): Promise<StripeAccount> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("no such account");
    return structuredClone(account);
  }

  async createCheckoutSession(
    input: CreateCheckoutInput,
    stripeAccountId: string | undefined,
  ): Promise<StripeCheckoutSession> {
    this.checkoutCalls.push({ input, account: stripeAccountId });
    const id = `cs_test_${++this.counter}`;
    const invoiceId = `in_test_${++this.counter}`;
    this.invoices.set(invoiceId, {
      id: invoiceId,
      hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
      invoice_pdf: `https://invoice.stripe.test/${invoiceId}.pdf`,
      status: "draft",
    });
    const session: StripeCheckoutSession = {
      id,
      url: `https://checkout.stripe.test/${id}`,
      expires_at: Date.now() + 3600_000,
      amount_total: input.amountCents,
      payment_status: "unpaid",
      status: "open",
      payment_intent: `pi_test_${this.counter}`,
      invoice: invoiceId,
      livemode: false,
    };
    this.sessions.set(id, session);
    return structuredClone(session);
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("no such session");
    return structuredClone(session);
  }

  async retrieveInvoice(invoiceId: string): Promise<StripeInvoice> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error("no such invoice");
    return structuredClone(invoice);
  }

  async createRefund(
    input: CreateRefundInput,
    stripeAccountId: string | undefined,
  ): Promise<StripeRefund> {
    this.refundCalls.push({ input, account: stripeAccountId });
    const id = `re_test_${++this.counter}`;
    const refund: StripeRefund = {
      id,
      amount: input.amountCents ?? 1000,
      status: "succeeded",
      payment_intent: input.paymentIntentId,
    };
    this.refunds.set(id, refund);
    return structuredClone(refund);
  }

  /** Simulate a completed card payment before the webhook arrives. */
  markPaid(sessionId: string): StripeCheckoutSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("no such session");
    session.payment_status = "paid";
    session.status = "complete";
    return structuredClone(session);
  }

  enableCharges(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("no such account");
    account.charges_enabled = true;
    account.payouts_enabled = true;
    account.requirements = { currently_due: [] };
  }
}
