import assert from "node:assert/strict";
import test from "node:test";
import { FakeStripe } from "./fake-stripe.js";
import { MarketplaceBroker } from "./service.js";
import { MarketplaceStore } from "./store.js";
import { instanceView } from "./service.js";
import type { Instance } from "./types.js";

const NOW = 1_760_000_000_000;

function setup() {
  const store = new MarketplaceStore();
  const stripe = new FakeStripe();
  const broker = new MarketplaceBroker({
    store,
    stripe,
    publicUrl: "https://broker.test",
    livemode: false,
    now: () => NOW,
  });
  return { store, stripe, broker };
}

async function onboarded(
  broker: MarketplaceBroker,
  stripe: FakeStripe,
  instance: Instance,
): Promise<string> {
  const onboarding = await broker.connectOnboarding(instance, {});
  stripe.enableCharges(onboarding.accountId);
  // Stripe reports capabilities asynchronously through webhooks; the instance
  // refreshes once before selling.
  await broker.connectStatus(instance, { refresh: true });
  return onboarding.accountId;
}

async function enrolled(broker: MarketplaceBroker) {
  const ticket = await broker.startEnrollment();
  await broker.claimEnrollment(ticket.code, { name: "Atelier", country: "FR", currency: "EUR" });
  const polled = await broker.pollEnrollment(ticket.code, ticket.deviceCode);
  assert.equal(polled.status, "approved");
  if (polled.status !== "approved" || !polled.instanceSecret) throw new Error("missing secret");
  const instance = broker.requireInstance(polled.instanceSecret);
  return { ticket, secret: polled.instanceSecret, instance };
}

test("enrollment hands the secret out exactly once", async () => {
  const { broker } = setup();
  const ticket = await broker.startEnrollment();
  assert.match(ticket.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const pending = await broker.pollEnrollment(ticket.code, ticket.deviceCode);
  assert.equal(pending.status, "pending");
  await assert.rejects(
    broker.pollEnrollment(ticket.code, "wrong-device-code"),
    /Invalid device code/,
  );
  await broker.claimEnrollment(ticket.code, { name: "Atelier", country: "FR", currency: "EUR" });
  const first = await broker.pollEnrollment(ticket.code, ticket.deviceCode);
  assert.equal(first.status, "approved");
  if (first.status !== "approved") return;
  assert.equal(first.consumed, false);
  assert.ok(first.instanceSecret);
  const second = await broker.pollEnrollment(ticket.code, ticket.deviceCode);
  assert.equal(second.status, "approved");
  if (second.status !== "approved") return;
  assert.equal(second.consumed, true);
  assert.equal(second.instanceSecret, undefined);
  await assert.rejects(
    broker.claimEnrollment(ticket.code, { name: "Other" }),
    /already used/,
  );
});

test("expired enrollment codes are refused", async () => {
  const { broker } = setup();
  const ticket = await broker.startEnrollment();
  const later = new MarketplaceBroker({
    store: (broker as unknown as { store: MarketplaceStore }).store,
    stripe: new FakeStripe(),
    publicUrl: "https://broker.test",
    livemode: false,
    now: () => NOW + 11 * 60 * 1000,
  });
  await assert.rejects(
    later.pollEnrollment(ticket.code, ticket.deviceCode),
    /expired/,
  );
});

test("connect onboarding creates a direct-charge account and reuses it", async () => {
  const { broker, stripe } = setup();
  const { instance } = await enrolled(broker);
  const first = await broker.connectOnboarding(instance, {});
  assert.match(first.url, /connect\.stripe\.test/);
  const second = await broker.connectOnboarding(instance, {});
  assert.equal(second.accountId, first.accountId);
  assert.equal(stripe.accountLinks, 2);

  let status = await broker.connectStatus(instance);
  assert.equal(status.status, "restricted");
  assert.deepEqual(status.requirementsDue, ["business_profile.url"]);

  stripe.enableCharges(first.accountId);
  status = await broker.connectStatus(instance, { refresh: true, loginLink: true });
  assert.equal(status.status, "active");
  assert.equal(status.chargesEnabled, true);
  assert.match(status.dashboardUrl ?? "", /dashboard\.stripe\.test/);
});

test("checkout requires an onboarded account and charges the marketplace commission", async () => {
  const { broker, stripe } = setup();
  const { instance } = await enrolled(broker);
  await assert.rejects(
    broker.createCheckout(instance, {
      amountCents: 1000,
      creditUsd: 10,
      userRef: "usr_1",
      successUrl: "https://instance.test/billing/return",
    }),
    /Connect Stripe/,
  );

  const accountId = await onboarded(broker, stripe, instance);
  const checkout = await broker.createCheckout(instance, {
    amountCents: 1000,
    creditUsd: 10,
    userRef: "usr_1",
    successUrl: "https://instance.test/billing/return",
    customerEmail: "sam@example.com",
    packId: "pack_10",
  });
  assert.equal(checkout.feeCents, 50);
  assert.equal(checkout.netCents, 950);
  assert.equal(checkout.currency, "EUR");
  assert.equal(stripe.checkoutCalls.length, 1);
  assert.equal(stripe.checkoutCalls[0]?.account, accountId);
  assert.equal(stripe.checkoutCalls[0]?.input.feeCents, 50);
  assert.deepEqual(stripe.checkoutCalls[0]?.input.metadata, {
    instance_id: instance.id,
    payment_id: checkout.paymentId,
    user_ref: "usr_1",
    kind: "topup",
    credit_usd: "10",
  });
});

test("checkout validates amount, currency, credit and plan", async () => {
  const { broker, stripe } = setup();
  const { instance } = await enrolled(broker);
  const accountId = await onboarded(broker, stripe, instance);
  const base = {
    amountCents: 1000,
    creditUsd: 10,
    userRef: "usr_1",
    successUrl: "https://instance.test/billing",
  };
  await assert.rejects(broker.createCheckout(instance, { ...base, amountCents: 10 }), /Amount/);
  await assert.rejects(broker.createCheckout(instance, { ...base, currency: "USD" }), /currency/);
  await assert.rejects(broker.createCheckout(instance, { ...base, creditUsd: 0 }), /Credit/);
  await assert.rejects(broker.createCheckout(instance, { ...base, userRef: "" }), /member/);
  await assert.rejects(
    broker.createCheckout(instance, { ...base, kind: "subscription" }),
    /plan reference/,
  );
  const subscription = await broker.createCheckout(instance, {
    ...base,
    kind: "subscription",
    planRef: "plan_pro",
    interval: "month",
  });
  assert.equal(subscription.feeCents, 50);
  assert.equal(stripe.checkoutCalls.at(-1)?.input.applicationFeePercent, 5);
});

test("an unpaid checkout is not credited, a paid one is emitted once", async () => {
  const { broker, stripe, store } = setup();
  const { instance } = await enrolled(broker);
  const accountId = await onboarded(broker, stripe, instance);
  const checkout = await broker.createCheckout(instance, {
    amountCents: 2000,
    creditUsd: 20,
    userRef: "usr_1",
    successUrl: "https://instance.test/billing",
  });

  let status = await broker.paymentStatus(instance, checkout.sessionId);
  assert.equal(status.status, "open");

  stripe.markPaid(checkout.sessionId);
  status = await broker.paymentStatus(instance, checkout.sessionId);
  assert.equal(status.status, "paid");
  assert.equal(status.netCents, 1900);

  const events = broker.listEvents(instance.id, 0, 50);
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0]?.type, "payment.succeeded");
  assert.equal(events.events[0]?.payload.creditUsd, 20);
  assert.equal(events.events[0]?.payload.userRef, "usr_1");
  assert.equal(events.cursor, 1);

  // A repeated status poll never emits a second credit event.
  await broker.paymentStatus(instance, checkout.sessionId);
  assert.equal(broker.listEvents(instance.id, 0, 50).events.length, 1);
  assert.equal(store.findPayment(checkout.paymentId)?.status, "paid");
});

test("webhooks are idempotent and scoped to the right Stripe mode", async () => {
  const { broker, stripe } = setup();
  const { instance } = await enrolled(broker);
  const accountId = await onboarded(broker, stripe, instance);
  const checkout = await broker.createCheckout(instance, {
    amountCents: 1000,
    creditUsd: 10,
    userRef: "usr_1",
    successUrl: "https://instance.test/billing",
  });
  const event = {
    id: "evt_1",
    type: "checkout.session.completed",
    account: accountId,
    livemode: false,
    data: {
      object: {
        id: checkout.sessionId,
        payment_status: "paid",
        payment_intent: "pi_1",
      },
    },
  };
  const first = await broker.handleStripeEvent(event, "connect");
  assert.equal(first.handled, true);
  const replay = await broker.handleStripeEvent(event, "connect");
  assert.equal(replay.duplicate, true);
  assert.equal(broker.listEvents(instance.id, 0, 10).events.length, 1);

  const live = await broker.handleStripeEvent({ ...event, id: "evt_live", livemode: true }, "connect");
  assert.equal(live.handled, false);
  assert.equal(live.reason, "wrong_mode");

  const missingAccount = await broker.handleStripeEvent(
    { ...event, id: "evt_2", account: undefined },
    "connect",
  );
  assert.equal(missingAccount.reason, "missing_account");
});

test("expired checkouts emit checkout.expired and never credit", async () => {
  const { broker, stripe, store } = setup();
  const { instance } = await enrolled(broker);
  const accountId = await onboarded(broker, stripe, instance);
  const checkout = await broker.createCheckout(instance, {
    amountCents: 1000,
    creditUsd: 10,
    userRef: "usr_1",
    successUrl: "https://instance.test/billing",
  });
  const session = stripe.sessions.get(checkout.sessionId);
  if (session) session.status = "expired";
  const status = await broker.paymentStatus(instance, checkout.sessionId);
  assert.equal(status.status, "expired");
  const events = broker.listEvents(instance.id, 0, 10);
  assert.equal(events.events.at(-1)?.type, "checkout.expired");
  assert.equal(events.events.some((event) => event.type === "payment.succeeded"), false);
  assert.equal(store.findPayment(checkout.paymentId)?.status, "expired");
});

test("refunds are partial then full and emit a single event", async () => {
  const { broker, stripe, store } = setup();
  const { instance } = await enrolled(broker);
  const accountId = await onboarded(broker, stripe, instance);
  const checkout = await broker.createCheckout(instance, {
    amountCents: 5000,
    creditUsd: 50,
    userRef: "usr_1",
    successUrl: "https://instance.test/billing",
  });
  const payment = store.findPayment(checkout.paymentId);
  if (!payment) throw new Error("missing payment");
  stripe.markPaid(checkout.sessionId);
  await broker.paymentStatus(instance, checkout.sessionId);
  const paid = store.findPayment(checkout.paymentId);
  assert.ok(paid);
  // The fake Stripe echoes the requested amount.
  stripe.createRefund = async (input) => {
    stripe.refundCalls.push({ input, account: accountId });
    return {
      id: `re_${stripe.refundCalls.length}`,
      amount: input.amountCents ?? 5000,
      status: "succeeded",
      payment_intent: input.paymentIntentId,
    };
  };

  const first = await broker.refund(instance, {
    paymentId: checkout.paymentId,
    amountCents: 2000,
    refundApplicationFee: true,
  });
  assert.equal(first.amountCents, 2000);
  assert.equal(first.payment.status, "paid");
  assert.equal(first.payment.refundedCents, 2000);
  assert.equal(stripe.refundCalls[0]?.input.refundApplicationFee, true);

  const second = await broker.refund(instance, { paymentId: checkout.paymentId });
  assert.equal(second.payment.status, "refunded");
  assert.equal(second.payment.refundedCents, 5000);
  const refundEvents = broker
    .listEvents(instance.id, 0, 50)
    .events.filter((event) => event.type === "payment.refunded");
  assert.equal(refundEvents.length, 2);
  assert.equal(refundEvents.at(-1)?.payload.refundedCents, 5000);
  await assert.rejects(broker.refund(instance, { paymentId: checkout.paymentId }), /fully refunded/);
});

test("earnings net out commission and refunds", async () => {
  const { broker, stripe, store } = setup();
  const { instance } = await enrolled(broker);
  const accountId = await onboarded(broker, stripe, instance);
  const checkout = await broker.createCheckout(instance, {
    amountCents: 10_000,
    creditUsd: 100,
    userRef: "usr_1",
    successUrl: "https://instance.test/billing",
  });
  stripe.markPaid(checkout.sessionId);
  await broker.paymentStatus(instance, checkout.sessionId);
  stripe.createRefund = async (input) => ({
    id: "re_1",
    amount: input.amountCents ?? 10_000,
    status: "succeeded",
    payment_intent: input.paymentIntentId,
  });
  await broker.refund(instance, { paymentId: checkout.paymentId, amountCents: 1000 });
  const earnings = broker.earnings(instance);
  assert.equal(earnings.grossCents, 10_000);
  assert.equal(earnings.feeCents, 500);
  assert.equal(earnings.refundedCents, 1000);
  assert.equal(earnings.netCents, 8500);
  assert.equal(earnings.paidCount, 1);
  assert.equal(store.findPayment(checkout.paymentId)?.status, "paid");
});

test("a rotated secret keeps working during the overlap window", async () => {
  const { broker } = setup();
  const { instance, secret } = await enrolled(broker);
  const rotated = await broker.rotateSecret(instance);
  assert.notEqual(rotated.instanceSecret, secret);
  assert.ok(broker.authenticate(secret));
  assert.ok(broker.authenticate(rotated.instanceSecret));
  const later = new MarketplaceBroker({
    store: (broker as unknown as { store: MarketplaceStore }).store,
    stripe: new FakeStripe(),
    publicUrl: "https://broker.test",
    livemode: false,
    now: () => NOW + 25 * 60 * 60 * 1000,
  });
  assert.equal(later.authenticate(secret), undefined);
  assert.ok(later.authenticate(rotated.instanceSecret));
});

test("instance view never exposes the secret", async () => {
  const { broker } = setup();
  const { instance } = await enrolled(broker);
  const view = instanceView(instance) as unknown as Record<string, unknown>;
  assert.equal(view.secretHash, undefined);
  assert.equal(view.secretSealed, undefined);
  assert.equal(view.commissionBps, 500);
});
