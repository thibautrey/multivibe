import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../store.js";
import type { User } from "../types.js";
import { PaymentsError, PaymentsService, startPaymentsPoller } from "./service.js";
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

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-payments-"));
  const store = new AccountStore(path.join(dir, "accounts.json"));
  await store.init();
  const broker = await createStubBroker();
  const service = new PaymentsService({
    store,
    credentialsPath: path.join(dir, "payments-credentials.json"),
    brokerUrl: broker.url,
    now: () => NOW,
  });
  await service.startEnrollment();
  await service.pollEnrollment();
  await service.updateSettings({
    packs: [
      {
        id: "pack_10",
        amountCents: 1000,
        currency: "EUR",
        creditUsd: 10,
        label: "10 EUR",
      },
    ],
  });
  await store.addUser(makeUser("usr_1", "sam@example.com"));
  await store.addUser(makeUser("usr_2", "other@example.com"));
  return {
    dir,
    store,
    broker,
    service,
    cleanup: async () => {
      await broker.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function walletOf(store: AccountStore, id: string): number {
  return store.getCachedUsers().find((user) => user.id === id)?.walletUsd ?? 0;
}

test("enrollment stores credentials with 0600 permissions and enables billing", async () => {
  const harness = await setup();
  try {
    const credentialsPath = path.join(harness.dir, "payments-credentials.json");
    const stat = await fs.stat(credentialsPath);
    assert.equal(stat.mode & 0o777, 0o600);
    const raw = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
    assert.equal(raw.instanceId, harness.broker.instanceId);
    assert.equal(raw.secret, harness.broker.secret);
    const settings = await harness.service.settings();
    assert.equal(settings.enabled, true);
    assert.equal(settings.instanceId, harness.broker.instanceId);
    assert.equal(settings.commissionBps, 500);
    assert.equal(settings.currency, "EUR");
  } finally {
    await harness.cleanup();
  }
});

test("Stripe onboarding returns to the instance and stores the account", async () => {
  const harness = await setup();
  try {
    assert.equal((await harness.service.settings()).connect?.status ?? "not_connected", "not_connected");
    const onboarding = await harness.service.connectOnboarding({
      email: "admin@example.com",
      origin: "http://instance.test",
    });
    assert.equal(onboarding.url, "https://connect.stripe.test/onboard");
    const settings = await harness.service.settings();
    assert.equal(settings.connect?.status, "pending");
    assert.equal(settings.connect?.accountId, "acct_test");
    assert.equal(settings.connect?.chargesEnabled, false);

    const live = await harness.service.refreshConnect();
    assert.equal(live.status, "active");
    assert.equal(live.chargesEnabled, true);
    assert.equal((await harness.service.settings()).connect?.chargesEnabled, true);
  } finally {
    await harness.cleanup();
  }
});

test("a top-up credits the wallet only after Stripe confirms", async () => {
  const harness = await setup();
  try {
    const checkout = await harness.service.checkout(
      "usr_1",
      "pack_10",
      "http://127.0.0.1:1455",
    );
    assert.equal(checkout.amountCents, 1000);
    assert.equal(checkout.feeCents, 50);
    assert.equal(walletOf(harness.store, "usr_1"), 0);

    const pending = await harness.service.paymentStatus(checkout.sessionId, "usr_1");
    assert.equal(pending.payment.status, "open");
    assert.equal(walletOf(harness.store, "usr_1"), 0);

    harness.broker.markPaid(checkout.sessionId);
    const paid = await harness.service.paymentStatus(checkout.sessionId, "usr_1");
    assert.equal(paid.payment.status, "paid");
    assert.equal(paid.walletUsd, 10);
    assert.equal(walletOf(harness.store, "usr_1"), 10);

    // The same return URL hit twice never doubles the credit.
    await harness.service.paymentStatus(checkout.sessionId, "usr_1");
    const user = await harness.store.findUser("usr_1");
    assert.equal(user?.walletUsd, 10);
    assert.equal(
      user?.creditLedger?.filter((entry) => entry.kind === "topup").length,
      1,
    );
    assert.equal(user?.creditLedger?.[0]?.paymentId, checkout.paymentId);
    assert.match(user?.creditLedger?.[0]?.note ?? "", /Stripe EUR 10\.00/);
  } finally {
    await harness.cleanup();
  }
});

test("a member cannot claim another member's checkout", async () => {
  const harness = await setup();
  try {
    const checkout = await harness.service.checkout("usr_1", "pack_10", "http://localhost");
    harness.broker.markPaid(checkout.sessionId);
    await assert.rejects(
      harness.service.paymentStatus(checkout.sessionId, "usr_2"),
      (error: unknown) => error instanceof PaymentsError && error.status === 404,
    );
    assert.equal(walletOf(harness.store, "usr_1"), 0);
    await harness.service.paymentStatus(checkout.sessionId, "usr_1");
    assert.equal(walletOf(harness.store, "usr_1"), 10);
  } finally {
    await harness.cleanup();
  }
});

test("an unknown checkout session is a 404, not a broker outage", async () => {
  const harness = await setup();
  try {
    await assert.rejects(
      harness.service.paymentStatus("cs_missing", "usr_1"),
      (error: unknown) => error instanceof PaymentsError && error.status === 404,
    );
  } finally {
    await harness.cleanup();
  }
});

test("the outbox cursor advances and a replay never double-credits", async () => {
  const harness = await setup();
  try {
    const checkout = await harness.service.checkout("usr_1", "pack_10", "http://localhost");
    harness.broker.markPaid(checkout.sessionId);
    const first = await harness.service.syncEvents();
    assert.equal(first.applied, 1);
    assert.equal(first.cursor, 1);
    assert.equal(walletOf(harness.store, "usr_1"), 10);

    // Simulate a lost cursor (process killed after the credit, before the
    // settings flush): the event is replayed and must be ignored.
    await harness.service.updateSettings({ lastEventCursor: 0 });
    const replay = await harness.service.syncEvents();
    assert.equal(replay.cursor, 1);
    assert.equal(walletOf(harness.store, "usr_1"), 10);
    const user = await harness.store.findUser("usr_1");
    assert.equal(user?.creditLedger?.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("a broker outage keeps the cursor so events are applied later", async () => {
  const harness = await setup();
  try {
    const checkout = await harness.service.checkout("usr_1", "pack_10", "http://localhost");
    harness.broker.markPaid(checkout.sessionId);
    harness.broker.failEvents = true;
    await assert.rejects(harness.service.syncEvents());
    assert.equal((await harness.service.settings()).lastEventCursor ?? 0, 0);
    assert.equal(walletOf(harness.store, "usr_1"), 0);

    harness.broker.failEvents = false;
    const recovered = await harness.service.syncEvents();
    assert.equal(recovered.applied, 1);
    assert.equal(walletOf(harness.store, "usr_1"), 10);
  } finally {
    await harness.cleanup();
  }
});

test("partial then full refunds debit the wallet proportionally", async () => {
  const harness = await setup();
  try {
    const checkout = await harness.service.checkout("usr_1", "pack_10", "http://localhost");
    harness.broker.markPaid(checkout.sessionId);
    await harness.service.syncEvents();
    assert.equal(walletOf(harness.store, "usr_1"), 10);

    const partial = await harness.service.refund(checkout.paymentId, { amountCents: 250 });
    assert.equal(partial.amountCents, 250);
    await harness.service.syncEvents();
    assert.equal(walletOf(harness.store, "usr_1"), 7.5);

    await harness.service.refund(checkout.paymentId);
    await harness.service.syncEvents();
    assert.equal(walletOf(harness.store, "usr_1"), 0);

    // Replaying the refund event after a lost cursor changes nothing.
    await harness.service.updateSettings({ lastEventCursor: 0 });
    await harness.service.syncEvents();
    assert.equal(walletOf(harness.store, "usr_1"), 0);
    const user = await harness.store.findUser("usr_1");
    assert.equal(user?.creditLedger?.filter((entry) => entry.kind === "refund").length, 2);
  } finally {
    await harness.cleanup();
  }
});

test("a dispute returns the whole credited amount and can drive the wallet negative", async () => {
  const harness = await setup();
  try {
    const checkout = await harness.service.checkout("usr_1", "pack_10", "http://localhost");
    harness.broker.markPaid(checkout.sessionId);
    await harness.service.syncEvents();
    // The member spends most of the credit before the chargeback.
    await harness.store.adjustUserWallet("usr_1", -9.5, { kind: "debit" });
    assert.equal(walletOf(harness.store, "usr_1"), 0.5);

    harness.broker.markDisputed(checkout.sessionId);
    await harness.service.syncEvents();
    assert.equal(walletOf(harness.store, "usr_1"), -9.5);
  } finally {
    await harness.cleanup();
  }
});

test("reconciliation credits a paid session whose event was missed", async () => {
  const harness = await setup();
  try {
    const checkout = await harness.service.checkout("usr_1", "pack_10", "http://localhost");
    harness.broker.markPaid(checkout.sessionId);
    const result = await harness.service.reconcile();
    assert.equal(result.checked, 1);
    assert.equal(result.credited, 1);
    assert.equal(walletOf(harness.store, "usr_1"), 10);

    const again = await harness.service.reconcile();
    assert.equal(again.credited, 0);
    assert.equal(walletOf(harness.store, "usr_1"), 10);
  } finally {
    await harness.cleanup();
  }
});

test("member billing exposes only the caller's payments", async () => {
  const harness = await setup();
  try {
    const first = await harness.service.checkout("usr_1", "pack_10", "http://localhost");
    harness.broker.markPaid(first.sessionId);
    await harness.service.syncEvents();
    const second = await harness.service.checkout("usr_2", "pack_10", "http://localhost");
    harness.broker.markPaid(second.sessionId);
    await harness.service.syncEvents();

    const user1 = await harness.store.findUser("usr_1");
    const user2 = await harness.store.findUser("usr_2");
    if (!user1 || !user2) throw new Error("missing users");
    const billing1 = await harness.service.memberBilling(user1);
    const billing2 = await harness.service.memberBilling(user2);
    assert.equal(billing1.payments.length, 1);
    assert.equal(billing1.payments[0]?.paymentId, first.paymentId);
    assert.equal(billing2.payments[0]?.paymentId, second.paymentId);
    assert.equal(billing1.walletUsd, 10);
    assert.equal(billing1.connected, false);
  } finally {
    await harness.cleanup();
  }
});

test("disabled billing refuses checkout before calling the broker", async () => {
  const harness = await setup();
  try {
    await harness.service.updateSettings({ enabled: false });
    await assert.rejects(
      harness.service.checkout("usr_1", "pack_10", "http://localhost"),
      (error: unknown) => error instanceof PaymentsError && error.code === "payments_disabled",
    );
  } finally {
    await harness.cleanup();
  }
});

test("unknown or disabled packs are refused", async () => {
  const harness = await setup();
  try {
    await assert.rejects(
      harness.service.checkout("usr_1", "nope", "http://localhost"),
      (error: unknown) => error instanceof PaymentsError && error.code === "pack_not_found",
    );
    await harness.service.updateSettings({
      packs: [
        {
          id: "hidden",
          amountCents: 1000,
          currency: "EUR",
          creditUsd: 10,
          enabled: false,
        },
      ],
    });
    await assert.rejects(
      harness.service.checkout("usr_1", "hidden", "http://localhost"),
      (error: unknown) => error instanceof PaymentsError && error.code === "pack_not_found",
    );
  } finally {
    await harness.cleanup();
  }
});

test("the poller applies events and can be stopped", async () => {
  const harness = await setup();
  try {
    const checkout = await harness.service.checkout("usr_1", "pack_10", "http://localhost");
    harness.broker.markPaid(checkout.sessionId);
    const poller = startPaymentsPoller(harness.service, { intervalMs: 60_000 });
    await poller.tick();
    assert.equal(walletOf(harness.store, "usr_1"), 10);
    poller.stop();
  } finally {
    await harness.cleanup();
  }
});
