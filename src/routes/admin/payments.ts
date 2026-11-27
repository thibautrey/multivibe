import express from "express";
import type { AccountStore } from "../../store.js";
import { getAuth, requireAdmin } from "../../auth-context.js";
import type { PaymentsService } from "../../payments/service.js";
import { PaymentsError } from "../../payments/service.js";
import type { PaymentPack } from "../../types.js";

type Options = { store: AccountStore; payments: PaymentsService };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanPacks(value: unknown): PaymentPack[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 50) return undefined;
  const packs: PaymentPack[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const raw = asRecord(entry);
    const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 64) : "";
    const amountCents = Number(raw.amountCents);
    const creditUsd = Number(raw.creditUsd);
    const currency = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
    if (!id || seen.has(id)) return undefined;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return undefined;
    if (!Number.isInteger(amountCents) || amountCents < 50 || amountCents > 1_000_000) {
      return undefined;
    }
    if (!Number.isFinite(creditUsd) || creditUsd <= 0 || creditUsd > 100_000) return undefined;
    if (!/^[A-Z]{3}$/.test(currency)) return undefined;
    const bonusUsd = Number(raw.bonusUsd ?? 0);
    if (!Number.isFinite(bonusUsd) || bonusUsd < 0 || bonusUsd > 100_000) return undefined;
    seen.add(id);
    packs.push({
      id,
      amountCents,
      creditUsd: Math.round(creditUsd * 100) / 100,
      currency,
      ...(typeof raw.label === "string" && raw.label.trim()
        ? { label: raw.label.trim().slice(0, 120) }
        : {}),
      ...(bonusUsd > 0 ? { bonusUsd: Math.round(bonusUsd * 100) / 100 } : {}),
      ...(raw.enabled === false ? { enabled: false } : {}),
    });
  }
  return packs;
}

export function createAdminPaymentsRouter({ store, payments }: Options) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get("/", async (_req, res) => {
    const settings = await payments.adminStatus();
    let earnings: unknown;
    let history: unknown[] = [];
    if (settings.enabled) {
      earnings = await payments.earnings().catch(() => undefined);
      history = await payments.listPayments(50).catch(() => []);
    }
    res.setHeader("cache-control", "no-store");
    res.json({ settings, earnings, payments: history });
  });

  router.patch("/settings", async (req, res) => {
    const body = asRecord(req.body);
    const current = await payments.settings();
    const patch: Record<string, unknown> = {};
    if ("enabled" in body) {
      if (typeof body.enabled !== "boolean") {
        return res.status(400).json({ error: "invalid_enabled" });
      }
      patch.enabled = body.enabled;
    }
    if ("currency" in body) {
      const currency = String(body.currency ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        return res.status(400).json({ error: "invalid_currency" });
      }
      patch.currency = currency;
    }
    if ("packs" in body) {
      const packs = cleanPacks(body.packs);
      if (!packs) return res.status(400).json({ error: "invalid_packs" });
      if (packs.some((pack) => pack.currency !== (patch.currency ?? current.currency))) {
        return res.status(400).json({ error: "pack_currency_mismatch" });
      }
      patch.packs = packs;
    }
    if ("brokerUrl" in body) {
      const brokerUrl = String(body.brokerUrl ?? "").trim().replace(/\/+$/, "");
      if (brokerUrl && !/^https?:\/\//.test(brokerUrl)) {
        return res.status(400).json({ error: "invalid_broker_url" });
      }
      patch.brokerUrl = brokerUrl || undefined;
      if (brokerUrl && brokerUrl !== (await payments.brokerUrl())) {
        // A different broker cannot verify the existing secret: force a fresh
        // enrollment instead of signing calls the new broker will reject.
        await payments.disconnect();
      }
    }
    const settings = await payments.updateSettings(patch);
    res.json({ settings });
  });

  router.post("/enrollment", async (_req, res) => {
    try {
      const ticket = await payments.startEnrollment();
      res.status(201).json(ticket);
    } catch (error) {
      return sendPaymentsError(res, error);
    }
  });

  router.get("/enrollment", async (_req, res) => {
    try {
      res.json(await payments.pollEnrollment());
    } catch (error) {
      return sendPaymentsError(res, error);
    }
  });

  router.delete("/enrollment", async (_req, res) => {
    await payments.clearEnrollment();
    res.json({ ok: true });
  });

  router.post("/connect/onboarding", async (req, res) => {
    try {
      const auth = getAuth(req);
      const user = auth?.userId ? await store.findUser(auth.userId) : undefined;
      const origin = `${req.protocol}://${req.get("host") ?? "localhost"}`;
      res.json(await payments.connectOnboarding({ email: user?.email, origin }));
    } catch (error) {
      return sendPaymentsError(res, error);
    }
  });

  router.get("/connect", async (req, res) => {
    try {
      const status = await payments.refreshConnect({
        loginLink: req.query.loginLink === "1",
      });
      res.setHeader("cache-control", "no-store");
      res.json({ connect: status });
    } catch (error) {
      return sendPaymentsError(res, error);
    }
  });

  router.post("/refund", async (req, res) => {
    const body = asRecord(req.body);
    const paymentId = typeof body.paymentId === "string" ? body.paymentId.trim() : "";
    if (!paymentId) return res.status(400).json({ error: "invalid_payment" });
    const amountCents = body.amountCents === undefined ? undefined : Number(body.amountCents);
    if (amountCents !== undefined && (!Number.isInteger(amountCents) || amountCents <= 0)) {
      return res.status(400).json({ error: "invalid_amount" });
    }
    try {
      const result = await payments.refund(paymentId, {
        ...(amountCents !== undefined ? { amountCents } : {}),
        refundApplicationFee: body.refundApplicationFee === true,
      });
      res.json(result);
    } catch (error) {
      return sendPaymentsError(res, error);
    }
  });

  router.post("/sync", async (_req, res) => {
    try {
      const synced = await payments.syncEvents();
      const reconciled = await payments.reconcile().catch(() => undefined);
      res.json({ ...synced, reconciled });
    } catch (error) {
      return sendPaymentsError(res, error);
    }
  });

  router.post("/disconnect", async (_req, res) => {
    await payments.disconnect();
    res.json({ ok: true });
  });

  return router;
}

export function sendPaymentsError(res: express.Response, error: unknown) {
  if (error instanceof PaymentsError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  const status = Number((error as { status?: number })?.status);
  const code = String((error as { code?: string })?.code ?? "broker_error");
  if (status >= 400 && status < 600) {
    return res.status(502).json({
      error: code,
      message: error instanceof Error ? error.message : "Broker request failed.",
    });
  }
  return res.status(500).json({ error: "payments_failed" });
}
