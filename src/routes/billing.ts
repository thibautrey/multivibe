import express from "express";
import type { AccountStore } from "../store.js";
import { getAuth } from "../auth-context.js";
import type { PaymentsService } from "../payments/service.js";
import { PaymentsError } from "../payments/service.js";
import { sendPaymentsError } from "./admin/payments.js";

type Options = { store: AccountStore; payments: PaymentsService };

/** Member-facing billing: own balance, packs, checkout and purchase status. */
export function createBillingRouter({ store, payments }: Options) {
  const router = express.Router();

  const currentUser = async (req: express.Request) => {
    const auth = getAuth(req);
    if (!auth) return undefined;
    if (!auth.userId) {
      // The legacy admin token has no member wallet; the admin panel is the
      // right place for that session.
      return undefined;
    }
    const user = await store.findUser(auth.userId);
    return user && user.status === "active" ? user : undefined;
  };

  router.get("/", async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(403).json({ error: "forbidden" });
    res.setHeader("cache-control", "no-store");
    res.json(await payments.memberBilling(user));
  });

  router.get("/history", async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(403).json({ error: "forbidden" });
    const limit = Number(req.query.limit ?? 25);
    res.setHeader("cache-control", "no-store");
    res.json({
      payments: await payments
        .history(user.id, Number.isFinite(limit) && limit > 0 ? Math.min(100, limit) : 25)
        .catch(() => []),
    });
  });

  router.post("/checkout", async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(403).json({ error: "forbidden" });
    const packId = typeof req.body?.packId === "string" ? req.body.packId.trim() : "";
    if (!packId) return res.status(400).json({ error: "invalid_pack" });
    const origin = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    try {
      res.json(await payments.checkout(user.id, packId, origin));
    } catch (error) {
      return sendPaymentsError(res, error);
    }
  });

  router.get("/return", async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(403).json({ error: "forbidden" });
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
    if (!sessionId || sessionId.length > 300) {
      return res.status(400).json({ error: "invalid_session" });
    }
    try {
      const result = await payments.paymentStatus(sessionId, user.id);
      res.setHeader("cache-control", "no-store");
      res.json(result);
    } catch (error) {
      if (error instanceof PaymentsError) return sendPaymentsError(res, error);
      return res.status(502).json({ error: "broker_unavailable" });
    }
  });

  return router;
}
