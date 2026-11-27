import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { AccountStore } from "../../store.js";
import { createAdminModelBillingRouter } from "./model-billing.js";
import { setModelBillingOverrides } from "../../model-pricing.js";
import { setOffPeakSchedule } from "../../off-peak.js";

async function withBillingServer(run: (baseUrl: string, store: AccountStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-model-billing-"));
  const store = new AccountStore(path.join(root, "accounts.json"));
  await store.init();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { role: "admin", via: "token" };
    next();
  });
  app.use("/admin/model-billing", createAdminModelBillingRouter({ store }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, store);
  } finally {
    setModelBillingOverrides(undefined);
    setOffPeakSchedule(undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as any });

test("prices are stored per model, applied immediately and removable", async () => {
  setModelBillingOverrides(undefined);
  await withBillingServer(async (baseUrl, store) => {
    const empty = await json(await fetch(`${baseUrl}/admin/model-billing`));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.billing, {});
    assert.equal(empty.body.schedule, null);

    const saved = await json(
      await fetch(`${baseUrl}/admin/model-billing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.4",
          inputPer1M: 3,
          outputPer1M: 18,
          cachedInputPer1M: 0.3,
          offPeak: { inputPer1M: 1.5, outputPer1M: 9, cachedInputPer1M: 0.15 },
        }),
      }),
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.billing["openai/gpt-5.4"], {
      inputPer1M: 3,
      outputPer1M: 18,
      cachedInputPer1M: 0.3,
      offPeak: { inputPer1M: 1.5, outputPer1M: 9, cachedInputPer1M: 0.15 },
    });
    // The in-memory override is live for the next priced trace.
    assert.equal(store.getCachedSettings().modelBilling?.["openai/gpt-5.4"]?.outputPer1M, 18);

    const incompleteOffPeak = await json(
      await fetch(`${baseUrl}/admin/model-billing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.4",
          inputPer1M: 3,
          outputPer1M: 18,
          offPeak: { inputPer1M: 1.5 },
        }),
      }),
    );
    assert.equal(incompleteOffPeak.status, 400);
    assert.equal(incompleteOffPeak.body.error, "invalid_rate");

    const bad = await json(
      await fetch(`${baseUrl}/admin/model-billing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", inputPer1M: -1, outputPer1M: 2 }),
      }),
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_rate");

    const reserved = await json(
      await fetch(`${baseUrl}/admin/model-billing`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "__proto__", inputPer1M: 1, outputPer1M: 2 }),
      }),
    );
    assert.equal(reserved.status, 400);

    const removed = await json(
      await fetch(`${baseUrl}/admin/model-billing`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.4" }),
      }),
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.billing, {});
    assert.equal(store.getCachedSettings().modelBilling, undefined);
  });
});

test("off-peak schedules persist a timezone and a weekly calendar", async () => {
  await withBillingServer(async (baseUrl, store) => {
    const saved = await json(
      await fetch(`${baseUrl}/admin/model-billing/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schedule: {
            enabled: true,
            timezone: "Europe/Paris",
            days: {
              mon: [{ start: "22:00", end: "06:00" }],
              sat: "not-a-list",
            },
          },
        }),
      }),
    );
    assert.equal(saved.status, 400);
    assert.equal(saved.body.error, "invalid_schedule");

    const accepted = await json(
      await fetch(`${baseUrl}/admin/model-billing/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schedule: {
            enabled: true,
            timezone: "Europe/Paris",
            days: {
              mon: [{ start: "22:00", end: "6:00" }],
              sat: [{ start: "09:00", end: "18:00" }, { start: "20:00", end: "23:00" }],
            },
          },
        }),
      }),
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body.schedule, {
      enabled: true,
      timezone: "Europe/Paris",
      days: {
        mon: [{ start: "22:00", end: "06:00" }],
        sat: [{ start: "09:00", end: "18:00" }, { start: "20:00", end: "23:00" }],
      },
    });
    assert.deepEqual(store.getCachedSettings().offPeak, accepted.body.schedule);

    const read = await json(await fetch(`${baseUrl}/admin/model-billing`));
    assert.deepEqual(read.body.schedule, accepted.body.schedule);

    const badZone = await json(
      await fetch(`${baseUrl}/admin/model-billing/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, timezone: "Mars/Olympus", days: {} }),
      }),
    );
    assert.equal(badZone.status, 400);

    const sameEdges = await json(
      await fetch(`${baseUrl}/admin/model-billing/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          timezone: "UTC",
          days: { mon: [{ start: "10:00", end: "10:00" }] },
        }),
      }),
    );
    assert.equal(sameEdges.status, 400);

    // Disabling and clearing the calendar removes the setting entirely.
    const cleared = await json(
      await fetch(`${baseUrl}/admin/model-billing/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, timezone: "UTC", days: {} }),
      }),
    );
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.schedule, null);
    assert.equal(store.getCachedSettings().offPeak, undefined);
  });
});
