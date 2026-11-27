import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { AccountStore } from "../store.js";
import type { User } from "../types.js";
import { PaymentsService } from "./service.js";
import { createAdminPaymentsRouter } from "../routes/admin/payments.js";
import { createBillingRouter } from "../routes/billing.js";
import { createStubBroker, type StubBroker } from "./test-broker.js";

const NOW = 1_760_000_000_000;

function makeUser(id: string, email: string): User {
  return {
    id,
    email,
    name: id,
    role: "member",
    status: "active",
    quota: { period: "month", creditUsd: 20 },
    usage: { periodStart: undefined, requests: 0, tokens: 0, costUsd: 0, grantedCostUsd: 0 },
    walletUsd: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

type Harness = {
  baseUrl: string;
  store: AccountStore;
  broker: StubBroker;
  service: PaymentsService;
  close: () => Promise<void>;
};

async function start(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-payments-routes-"));
  const store = new AccountStore(path.join(dir, "accounts.json"));
  await store.init();
  const broker = await createStubBroker();
  const service = new PaymentsService({
    store,
    credentialsPath: path.join(dir, "credentials.json"),
    brokerUrl: broker.url,
    now: () => NOW,
  });
  await service.startEnrollment();
  await service.pollEnrollment();
  await service.updateSettings({
    packs: [{ id: "pack_10", amountCents: 1000, currency: "EUR", creditUsd: 10 }],
  });
  await store.addUser(makeUser("usr_1", "sam@example.com"));
  await store.addUser(makeUser("usr_2", "other@example.com"));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      role: req.header("x-role") === "admin" ? "admin" : "member",
      ...(req.header("x-user") ? { userId: req.header("x-user") } : {}),
      via: "session",
    };
    next();
  });
  app.use(
    "/admin/payments",
    createAdminPaymentsRouter({ store, payments: service }),
  );
  app.use("/admin/billing", createBillingRouter({ store, payments: service }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    broker,
    service,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await broker.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function admin(token = "admin"): Record<string, string> {
  return { "x-role": token, "x-user": "usr_admin" };
}

test("admin payments settings validate packs and keep member routes scoped", async () => {
  const harness = await start();
  try {
    const forbidden = await fetch(`${harness.baseUrl}/admin/payments`, {
      headers: { "x-role": "member", "x-user": "usr_1" },
    });
    assert.equal(forbidden.status, 403);

    const initial = await fetch(`${harness.baseUrl}/admin/payments`, { headers: admin() });
    assert.equal(initial.status, 200);
    const initialBody = (await initial.json()) as any;
    assert.equal(initialBody.settings.enabled, true);
    assert.equal(initialBody.settings.secretConfigured, true);
    assert.equal(initialBody.settings.connect.status, "active");

    const badAmount = await fetch(`${harness.baseUrl}/admin/payments/settings`, {
      method: "PATCH",
      headers: { ...admin(), "content-type": "application/json" },
      body: JSON.stringify({
        packs: [{ id: "cheap", amountCents: 10, currency: "EUR", creditUsd: 1 }],
      }),
    });
    assert.equal(badAmount.status, 400);

    const mismatch = await fetch(`${harness.baseUrl}/admin/payments/settings`, {
      method: "PATCH",
      headers: { ...admin(), "content-type": "application/json" },
      body: JSON.stringify({
        packs: [{ id: "usd", amountCents: 1000, currency: "USD", creditUsd: 10 }],
      }),
    });
    assert.equal(mismatch.status, 400);
    assert.equal(((await mismatch.json()) as any).error, "pack_currency_mismatch");

    const saved = await fetch(`${harness.baseUrl}/admin/payments/settings`, {
      method: "PATCH",
      headers: { ...admin(), "content-type": "application/json" },
      body: JSON.stringify({
        packs: [
          { id: "pack_20", amountCents: 2000, currency: "EUR", creditUsd: 20, bonusUsd: 2 },
        ],
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as any).settings.packs[0].id, "pack_20");
  } finally {
    await harness.close();
  }
});

test("admin can start and poll an enrollment and read connect status", async () => {
  const harness = await start();
  try {
    const enrollment = await fetch(`${harness.baseUrl}/admin/payments/enrollment`, {
      method: "POST",
      headers: admin(),
    });
    assert.equal(enrollment.status, 201);
    const ticket = (await enrollment.json()) as any;
    assert.equal(ticket.code, "ABCD-EFGH");
    assert.equal(ticket.deviceCode, "");

    const polled = await fetch(`${harness.baseUrl}/admin/payments/enrollment`, {
      headers: admin(),
    });
    assert.equal(polled.status, 200);
    assert.equal(((await polled.json()) as any).status, "enrolled");

    const connect = await fetch(`${harness.baseUrl}/admin/payments/connect?loginLink=1`, {
      headers: admin(),
    });
    assert.equal(connect.status, 200);
    assert.equal(((await connect.json()) as any).connect.status, "active");
  } finally {
    await harness.close();
  }
});

test("a member buys a pack, the return credits it, and only the owner sees it", async () => {
  const harness = await start();
  try {
    const checkout = await fetch(`${harness.baseUrl}/admin/billing/checkout`, {
      method: "POST",
      headers: { "x-user": "usr_1", "content-type": "application/json" },
      body: JSON.stringify({ packId: "pack_10" }),
    });
    assert.equal(checkout.status, 200);
    const created = (await checkout.json()) as any;
    assert.match(created.url, /checkout\.stripe\.test/);

    harness.broker.markPaid(created.sessionId);
    const stolen = await fetch(
      `${harness.baseUrl}/admin/billing/return?session_id=${created.sessionId}`,
      { headers: { "x-user": "usr_2" } },
    );
    assert.equal(stolen.status, 404);

    const own = await fetch(
      `${harness.baseUrl}/admin/billing/return?session_id=${created.sessionId}`,
      { headers: { "x-user": "usr_1" } },
    );
    assert.equal(own.status, 200);
    const paid = (await own.json()) as any;
    assert.equal(paid.payment.status, "paid");
    assert.equal(paid.walletUsd, 10);

    const billing = await fetch(`${harness.baseUrl}/admin/billing`, {
      headers: { "x-user": "usr_1" },
    });
    const body = (await billing.json()) as any;
    assert.equal(body.walletUsd, 10);
    assert.equal(body.packs.length, 1);
    assert.equal(body.payments.length, 1);

    // The invoices tab reads the same owner-scoped history and needs the
    // Stripe-hosted document link for the member's purchase.
    const history = await fetch(`${harness.baseUrl}/admin/billing/history`, {
      headers: { "x-user": "usr_1" },
    });
    assert.equal(history.status, 200);
    assert.equal(history.headers.get("cache-control"), "no-store");
    const historyBody = (await history.json()) as any;
    assert.equal(historyBody.payments.length, 1);
    assert.match(String(historyBody.payments[0].invoiceUrl), /^https:\/\/invoice\.stripe\.test\//);
    assert.match(String(historyBody.payments[0].invoicePdf), /\.pdf$/);

    const other = await fetch(`${harness.baseUrl}/admin/billing`, {
      headers: { "x-user": "usr_2" },
    });
    assert.equal(((await other.json()) as any).payments.length, 0);

    const otherHistory = await fetch(`${harness.baseUrl}/admin/billing/history`, {
      headers: { "x-user": "usr_2" },
    });
    assert.equal(otherHistory.status, 200);
    assert.equal(((await otherHistory.json()) as any).payments.length, 0);
  } finally {
    await harness.close();
  }
});

test("member checkout refuses unknown packs and missing sessions", async () => {
  const harness = await start();
  try {
    const unknown = await fetch(`${harness.baseUrl}/admin/billing/checkout`, {
      method: "POST",
      headers: { "x-user": "usr_1", "content-type": "application/json" },
      body: JSON.stringify({ packId: "nope" }),
    });
    assert.equal(unknown.status, 404);
    const missing = await fetch(`${harness.baseUrl}/admin/billing/return`, {
      headers: { "x-user": "usr_1" },
    });
    assert.equal(missing.status, 400);
  } finally {
    await harness.close();
  }
});

test("admin refunds a payment and the member wallet follows", async () => {
  const harness = await start();
  try {
    const checkout = await fetch(`${harness.baseUrl}/admin/billing/checkout`, {
      method: "POST",
      headers: { "x-user": "usr_1", "content-type": "application/json" },
      body: JSON.stringify({ packId: "pack_10" }),
    });
    const created = (await checkout.json()) as any;
    harness.broker.markPaid(created.sessionId);
    await harness.service.syncEvents();

    const refunded = await fetch(`${harness.baseUrl}/admin/payments/refund`, {
      method: "POST",
      headers: { ...admin(), "content-type": "application/json" },
      body: JSON.stringify({ paymentId: created.paymentId, amountCents: 400 }),
    });
    assert.equal(refunded.status, 200);
    const body = (await refunded.json()) as any;
    assert.equal(body.amountCents, 400);
    const user = await harness.store.findUser("usr_1");
    assert.equal(user?.walletUsd, 6);
  } finally {
    await harness.close();
  }
});
