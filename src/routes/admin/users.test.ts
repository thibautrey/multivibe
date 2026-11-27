import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { AccountStore } from "../../store.js";
import { createAdminUsersRouter } from "./users.js";

async function withUsersServer(run: (baseUrl: string, store: AccountStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-users-routes-"));
  const store = new AccountStore(path.join(root, "accounts.json"));
  await store.init();
  const app = express();
  app.use(express.json());
  // The dashboard guard normally attaches this identity.
  app.use((req, _res, next) => {
    req.auth = { role: "admin", via: "token" };
    next();
  });
  app.use("/admin/users", createAdminUsersRouter({ store }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as any });

test("an admin can revoke a passkey but cannot create one", async () => {
  await withUsersServer(async (baseUrl, store) => {
    const created = await json(
      await fetch(`${baseUrl}/admin/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "passkey@example.com", password: "secret12" }),
      }),
    );
    const id = created.body.user.id as string;
    await store.patchUser(id, {
      passkeys: [
        {
          id: "cred-1",
          publicKey: "pk",
          counter: 0,
          name: "Laptop",
          createdAt: Date.now(),
        },
      ],
    });

    const removed = await json(
      await fetch(`${baseUrl}/admin/users/${id}/passkeys/cred-1`, { method: "DELETE" }),
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.user.passkeys, []);

    // The user route never accepts credential material.
    const patched = await json(
      await fetch(`${baseUrl}/admin/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passkeys: [{ id: "forged" }] }),
      }),
    );
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.user.passkeys, []);
  });
});

test("model access is stored per user and cleared with an empty list", async () => {
  await withUsersServer(async (baseUrl, store) => {
    const created = await json(
      await fetch(`${baseUrl}/admin/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "restricted@example.com",
          password: "secret12",
          allowedModels: ["openai/gpt-5.4", "openai/gpt-5.4", " coding "],
        }),
      }),
    );
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.user.allowedModels, ["openai/gpt-5.4", "coding"]);

    const patched = await json(
      await fetch(`${baseUrl}/admin/users/${created.body.user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowedModels: [] }),
      }),
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.user.allowedModels, undefined);
    assert.equal((await store.findUser(created.body.user.id))?.allowedModels, undefined);

    const invalid = await json(
      await fetch(`${baseUrl}/admin/users/${created.body.user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowedModels: "gpt-5.4" }),
      }),
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid_allowed_models");
  });
});

test("user plans persist subscription windows, credit and a usage reset", async () => {
  await withUsersServer(async (baseUrl) => {
    const created = await json(
      await fetch(`${baseUrl}/admin/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "member@example.com",
          password: "secret12",
          plan: {
            mode: "subscription",
            name: "Pro",
            priceUsd: 20,
            windows: [
              { id: "5h", period: "5h", maxRequests: 120 },
              { id: "week", period: "week", maxTokens: 2_000_000, creditUsd: 18 },
            ],
          },
        }),
      }),
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.user.plan.mode, "subscription");
    assert.equal(created.body.user.plan.windows.length, 2);
    assert.equal(created.body.user.usage.remainingCreditUsd, 18);

    const id = created.body.user.id as string;
    const patched = await json(
      await fetch(`${baseUrl}/admin/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan: { mode: "subscription", windows: [{ id: "week", period: "week", maxRequests: 40 }] },
        }),
      }),
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.user.plan.windows.length, 1);
    assert.equal(patched.body.user.quotaWindows[0].maxRequests, 40);

    const credited = await json(
      await fetch(`${baseUrl}/admin/users/${id}/credit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: 5 }),
      }),
    );
    assert.equal(credited.status, 200);
    assert.equal(credited.body.user.usage.remainingCreditUsd, 5);

    const listing = await json(await fetch(`${baseUrl}/admin/users`));
    assert.equal(listing.body.users.length, 1);
    assert.equal(listing.body.users[0].plan.mode, "subscription");

    // Switching back to pay-as-you-go removes the windows and their counters.
    const usage = await json(
      await fetch(`${baseUrl}/admin/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: { mode: "usage" } }),
      }),
    );
    assert.equal(usage.body.user.plan.mode, "usage");
    assert.equal(usage.body.user.quotaWindows, undefined);
  });
});

test("the prepaid wallet is credited, debited and audit-logged", async () => {
  await withUsersServer(async (baseUrl, store) => {
    const created = await json(
      await fetch(`${baseUrl}/admin/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "wallet@example.com", password: "secret12" }),
      }),
    );
    assert.equal(created.status, 201);
    const id = created.body.user.id as string;
    assert.equal(created.body.user.walletUsd, undefined);

    const topped = await json(
      await fetch(`${baseUrl}/admin/users/${id}/wallet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: 20, note: "pack Starter" }),
      }),
    );
    assert.equal(topped.status, 200);
    assert.equal(topped.body.walletUsd, 20);
    assert.equal(topped.body.user.walletUsd, 20);
    assert.equal(topped.body.ledger.length, 1);
    assert.equal(topped.body.ledger[0].kind, "topup");
    assert.equal(topped.body.ledger[0].amountUsd, 20);
    assert.equal(topped.body.ledger[0].note, "pack Starter");

    // The period allowance is untouched by a purchase.
    assert.equal(topped.body.user.quota.creditUsd, undefined);

    const debited = await json(
      await fetch(`${baseUrl}/admin/users/${id}/wallet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: -3.5, note: "geste commercial" }),
      }),
    );
    assert.equal(debited.status, 200);
    assert.equal(debited.body.walletUsd, 16.5);
    assert.equal(debited.body.ledger[0].kind, "debit");
    assert.equal(debited.body.ledger[1].kind, "topup");

    const listing = await json(await fetch(`${baseUrl}/admin/users/${id}/credits`));
    assert.equal(listing.status, 200);
    assert.equal(listing.body.walletUsd, 16.5);
    assert.equal(listing.body.ledger.length, 2);

    // Zero, non-finite and oversized amounts are rejected.
    for (const amountUsd of [0, Number.NaN, 2_000_000]) {
      const invalid = await json(
        await fetch(`${baseUrl}/admin/users/${id}/wallet`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ amountUsd }),
        }),
      );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error, "invalid_amount");
    }

    // The manual allowance route now records an `allowance` entry too.
    const granted = await json(
      await fetch(`${baseUrl}/admin/users/${id}/credit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: 7 }),
      }),
    );
    assert.equal(granted.body.user.quota.creditUsd, 7);
    // Purchased credit is preserved across the allowance grant.
    assert.equal(granted.body.user.walletUsd, 16.5);

    // A direct quota edit is audited as an allowance movement too.
    const patched = await json(
      await fetch(`${baseUrl}/admin/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quota: { period: "month", creditUsd: 9 } }),
      }),
    );
    assert.equal(patched.body.user.quota.creditUsd, 9);

    const persisted = await store.findUser(id);
    assert.equal(persisted?.walletUsd, 16.5);
    assert.equal(persisted?.creditLedger?.length, 4);
    assert.equal(persisted?.creditLedger?.[0]?.kind, "allowance");
    assert.equal(persisted?.creditLedger?.[0]?.amountUsd, 2);
  });
});
