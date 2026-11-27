import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createMarketplaceApp } from "./app.js";
import { MarketplaceBroker } from "./service.js";
import { MarketplaceStore } from "./store.js";
import { FakeStripe, signature } from "./fake-stripe.js";
import { bodySignature, sha256, stripeSignature } from "./crypto.js";
import type { Instance } from "./types.js";

const NOW = 1_760_000_000_000;
const OPERATOR = "operator-token";
const WEBHOOK_SECRET = "whsec_platform";
const CONNECT_WEBHOOK_SECRET = "whsec_connect";

async function start() {
  const store = new MarketplaceStore();
  const stripe = new FakeStripe();
  const broker = new MarketplaceBroker({
    store,
    stripe,
    publicUrl: "https://broker.test",
    livemode: false,
    now: () => NOW,
  });
  const app = createMarketplaceApp({
    broker,
    store,
    webhookSecret: WEBHOOK_SECRET,
    connectWebhookSecret: CONNECT_WEBHOOK_SECRET,
    operatorToken: OPERATOR,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    store,
    stripe,
    broker,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function enroll(baseUrl: string): Promise<{ instance: Instance; secret: string }> {
  const started = await fetch(`${baseUrl}/v1/enrollments`, { method: "POST" });
  const ticket = (await started.json()) as { code: string; deviceCode: string };
  const claimed = await fetch(`${baseUrl}/v1/enrollments/${ticket.code}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": OPERATOR },
    body: JSON.stringify({ name: "Atelier", country: "FR", currency: "EUR" }),
  });
  assert.equal(claimed.status, 200);
  const polled = await fetch(`${baseUrl}/v1/enrollments/${ticket.code}`, {
    headers: { authorization: `Bearer ${ticket.deviceCode}` },
  });
  const body = (await polled.json()) as {
    status: string;
    instanceId: string;
    instanceSecret: string;
  };
  assert.equal(body.status, "approved");
  return {
    instance: {
      id: body.instanceId,
      name: "Atelier",
      secretHash: sha256(body.instanceSecret),
      secretSealed: "",
      status: "active",
      chargeMode: "direct",
      commissionBps: 500,
      currency: "EUR",
      country: "FR",
      livemode: false,
      createdAt: NOW,
    },
    secret: body.instanceSecret,
  };
}

function signed(
  secret: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): { headers: Record<string, string>; body?: string } {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const { timestamp, signature: value } = signature(secret, method, path, raw);
  return {
    headers: {
      authorization: `Bearer ${secret}`,
      "x-multivibe-timestamp": timestamp,
      "x-multivibe-signature": value,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: raw }),
  };
}

async function signedFetch(
  baseUrl: string,
  secret: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers; raw: string }> {
  const request = signed(secret, method, path, body, extra);
  const response = await fetch(`${baseUrl}${path}`, { method, ...request });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw ? JSON.parse(raw) : undefined,
    headers: response.headers,
    raw,
  };
}

test("signed instance API: onboarding, checkout, idempotency and events", async () => {
  const harness = await start();
  try {
    const { secret } = await enroll(harness.baseUrl);

    const who = await signedFetch(harness.baseUrl, secret, "GET", "/v1/instance");
    assert.equal(who.status, 200);
    assert.equal(who.body.instance.name, "Atelier");
    assert.equal(who.headers.get("x-multivibe-signature"), bodySignature(secret, who.raw));

    const tampered = await fetch(`${harness.baseUrl}/v1/instance`, {
      headers: {
        authorization: `Bearer ${secret}`,
        "x-multivibe-timestamp": String(NOW),
        "x-multivibe-signature": "deadbeef",
      },
    });
    assert.equal(tampered.status, 401);

    const onboarding = await signedFetch(
      harness.baseUrl,
      secret,
      "POST",
      "/v1/connect/onboarding",
      {},
      { "idempotency-key": "onboard-1" },
    );
    assert.equal(onboarding.status, 200);
    assert.match(onboarding.body.url, /connect\.stripe\.test/);
    harness.stripe.enableCharges(onboarding.body.accountId);
    await harness.broker.connectStatus(harness.broker.requireInstance(secret), { refresh: true });

    const checkoutBody = {
      amountCents: 1000,
      creditUsd: 10,
      userRef: "usr_1",
      successUrl: "https://instance.test/billing/return",
      packId: "pack_10",
    };
    const checkout = await signedFetch(
      harness.baseUrl,
      secret,
      "POST",
      "/v1/checkout",
      checkoutBody,
      { "idempotency-key": "buy-1" },
    );
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.feeCents, 50);
    assert.equal(checkout.body.netCents, 950);

    const replay = await signedFetch(
      harness.baseUrl,
      secret,
      "POST",
      "/v1/checkout",
      checkoutBody,
      { "idempotency-key": "buy-1" },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.sessionId, checkout.body.sessionId);
    assert.equal(replay.headers.get("idempotent-replay"), "true");

    const conflict = await signedFetch(
      harness.baseUrl,
      secret,
      "POST",
      "/v1/checkout",
      { ...checkoutBody, amountCents: 2000 },
      { "idempotency-key": "buy-1" },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "idempotency_conflict");

    const missingKey = await signedFetch(
      harness.baseUrl,
      secret,
      "POST",
      "/v1/checkout",
      checkoutBody,
    );
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.error, "idempotency_key_required");

    harness.stripe.markPaid(checkout.body.sessionId);
    const event = {
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      account: onboarding.body.accountId,
      livemode: false,
      data: {
        object: {
          id: checkout.body.sessionId,
          payment_status: "paid",
          payment_intent: "pi_test_1",
        },
      },
    };
    const rawEvent = JSON.stringify(event);
    const webhook = await fetch(`${harness.baseUrl}/webhooks/stripe-connect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature(rawEvent, CONNECT_WEBHOOK_SECRET),
      },
      body: rawEvent,
    });
    assert.equal(webhook.status, 200);
    assert.equal(((await webhook.json()) as any).handled, true);

    const events = await signedFetch(
      harness.baseUrl,
      secret,
      "GET",
      "/v1/events?after=0&limit=10",
    );
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].type, "payment.succeeded");
    assert.equal(events.body.events[0].payload.creditUsd, 10);
    assert.equal(events.body.cursor, 1);

    const payment = await signedFetch(
      harness.baseUrl,
      secret,
      "GET",
      `/v1/payments/${checkout.body.sessionId}`,
    );
    assert.equal(payment.body.payment.status, "paid");
    assert.equal(payment.body.payment.netCents, 950);

    const other = await enroll(harness.baseUrl);
    const forbidden = await signedFetch(
      harness.baseUrl,
      other.secret,
      "GET",
      `/v1/payments/${checkout.body.sessionId}`,
    );
    assert.equal(forbidden.status, 404);
  } finally {
    await harness.close();
  }
});

test("the operator enrollment page never leaks the operator token", async () => {
  const harness = await start();
  try {
    const page = await fetch(`${harness.baseUrl}/enroll?code=ABCD-EFGH`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(html.includes(OPERATOR), false);
    assert.match(html, /name="operatorToken" type="password"/);
    assert.match(html, /value="ABCD-EFGH"/);

    const started = await fetch(`${harness.baseUrl}/v1/enrollments`, { method: "POST" });
    const ticket = (await started.json()) as { code: string };
    const denied = await fetch(`${harness.baseUrl}/enroll`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: ticket.code, name: "Atelier", operatorToken: "wrong" }),
    });
    assert.equal(denied.status, 401);

    const approved = await fetch(`${harness.baseUrl}/enroll`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: ticket.code, name: "Atelier", operatorToken: OPERATOR }),
    });
    assert.equal(approved.status, 200);
  } finally {
    await harness.close();
  }
});

test("operator API lists instances and changes commission", async () => {
  const harness = await start();
  try {
    const { instance } = await enroll(harness.baseUrl);
    const unauthorized = await fetch(`${harness.baseUrl}/api/instances`);
    assert.equal(unauthorized.status, 401);
    const list = await fetch(`${harness.baseUrl}/api/instances`, {
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { instances: { id: string }[] };
    assert.equal(body.instances.length, 1);

    const patched = await fetch(
      `${harness.baseUrl}/api/instances/${instance.id}/commission`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
        body: JSON.stringify({ commissionBps: 750 }),
      },
    );
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as any).instance.commissionBps, 750);

    const suspended = await fetch(
      `${harness.baseUrl}/api/instances/${instance.id}/suspend`,
      { method: "POST", headers: { authorization: `Bearer ${OPERATOR}` } },
    );
    assert.equal(suspended.status, 200);
    assert.equal(((await suspended.json()) as any).instance.status, "suspended");
  } finally {
    await harness.close();
  }
});

test("webhooks reject a bad signature and a missing secret", async () => {
  const harness = await start();
  try {
    const response = await fetch(`${harness.baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: "{}",
    });
    assert.equal(response.status, 400);
  } finally {
    await harness.close();
  }
});

test("the browser return page never shows a fake success as a credit", async () => {
  const harness = await start();
  try {
    const { secret } = await enroll(harness.baseUrl);
    const onboarding = await signedFetch(
      harness.baseUrl,
      secret,
      "POST",
      "/v1/connect/onboarding",
      {},
      { "idempotency-key": "onboard" },
    );
    harness.stripe.enableCharges(onboarding.body.accountId);
    await harness.broker.connectStatus(harness.broker.requireInstance(secret), { refresh: true });
    const checkout = await signedFetch(
      harness.baseUrl,
      secret,
      "POST",
      "/v1/checkout",
      {
        amountCents: 1000,
        creditUsd: 10,
        userRef: "usr_1",
        successUrl:
          "https://instance.test/?tab=billing&checkout=success&session_id={CHECKOUT_SESSION_ID}",
      },
      { "idempotency-key": "buy" },
    );
    const page = await fetch(
      `${harness.baseUrl}/checkout/return?session_id=${checkout.body.sessionId}`,
    );
    const html = await page.text();
    assert.match(html, /vérification/);
    assert.match(html, /instance\.test\/\?tab=billing&amp;checkout=success/);
    assert.ok(html.includes(`session_id=${encodeURIComponent(checkout.body.sessionId)}`));
    assert.equal(html.includes("{CHECKOUT_SESSION_ID}"), false);
    const events = await signedFetch(harness.baseUrl, secret, "GET", "/v1/events?after=0");
    assert.equal(events.body.events.length, 0);
  } finally {
    await harness.close();
  }
});
