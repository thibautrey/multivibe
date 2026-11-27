import crypto from "node:crypto";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { safeEqual, verifyRequestSignature, verifyStripeSignature } from "./crypto.js";
import { MarketplaceBroker, BrokerError, instanceView } from "./service.js";
import { StripeError } from "./stripe.js";
import type { MarketplaceStore } from "./store.js";
import type { Instance, Payment } from "./types.js";

export type MarketplaceAppOptions = {
  broker: MarketplaceBroker;
  store: MarketplaceStore;
  webhookSecret: string;
  connectWebhookSecret: string;
  operatorToken: string;
  /** Timestamp tolerance for instance requests, in milliseconds. */
  clockWindowMs?: number;
};

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      instance?: Instance;
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b0f;color:#f4f4f5}
main{max-width:34rem;padding:2rem}label{display:block;margin:1rem 0 .25rem;font-size:.85rem;opacity:.75}
input{width:100%;padding:.6rem .7rem;border-radius:.5rem;border:1px solid #3f3f46;background:#18181b;color:inherit;box-sizing:border-box}
button{margin-top:1.25rem;padding:.65rem 1rem;border-radius:.5rem;border:0;background:#6366f1;color:#fff;font-weight:600;cursor:pointer}
code{background:#18181b;padding:.15rem .4rem;border-radius:.3rem}a{color:#a5b4fc}
.muted{opacity:.7;font-size:.9rem}
</style></head><body><main>${body}</main></body></html>`;
}

function operatorGuard(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) {
      return res
        .status(503)
        .json({ error: "operator_disabled", message: "MARKETPLACE_OPERATOR_TOKEN is not set." });
    }
    const provided =
      req.header("x-operator-token") ||
      req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
      "";
    if (!safeEqual(provided, token)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  };
}

export function createMarketplaceApp(options: MarketplaceAppOptions): express.Express {
  const { broker, store, webhookSecret, connectWebhookSecret, operatorToken } = options;
  const clockWindowMs = options.clockWindowMs ?? 5 * 60 * 1000;
  const app = express();
  app.disable("x-powered-by");

  const rawParser = express.raw({ type: "*/*", limit: "1mb" });
  const jsonParser = express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      (req as Request).rawBody = buffer.toString("utf8");
    },
  });

  // --- Stripe webhooks (raw body, verified signature) ----------------------

  const handleWebhook = (scope: "platform" | "connect", secret: string) =>
    async (req: Request, res: Response) => {
      if (!secret) {
        return res.status(503).json({ error: "webhook_not_configured" });
      }
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      if (
        !verifyStripeSignature(raw, req.header("stripe-signature"), secret, {
          toleranceMs: 5 * 60 * 1000,
        })
      ) {
        return res.status(400).json({ error: "invalid_signature" });
      }
      let event: { id: string; type: string; account?: string; livemode?: boolean; data: { object: Record<string, unknown> } };
      try {
        event = JSON.parse(raw);
      } catch {
        return res.status(400).json({ error: "invalid_json" });
      }
      try {
        const result = await broker.handleStripeEvent(event, scope);
        res.json({ received: true, ...result });
      } catch (error) {
        if (error instanceof BrokerError) {
          return res.status(error.status).json({ error: error.code });
        }
        res.status(500).json({ error: "webhook_failed" });
      }
    };

  app.post("/webhooks/stripe", rawParser, handleWebhook("platform", webhookSecret));
  app.post(
    "/webhooks/stripe-connect",
    rawParser,
    handleWebhook("connect", connectWebhookSecret),
  );

  // --- Public enrollment ---------------------------------------------------

  app.post("/v1/enrollments", jsonParser, async (_req, res) => {
    const ticket = await broker.startEnrollment();
    res.status(201).json(ticket);
  });

  app.get("/v1/enrollments/:code", jsonParser, async (req, res) => {
    const deviceCode =
      req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!deviceCode) return res.status(401).json({ error: "missing_device_code" });
    try {
      const result = await broker.pollEnrollment(req.params.code, deviceCode);
      res.setHeader("cache-control", "no-store");
      res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post(
    "/v1/enrollments/:code/claim",
    operatorGuard(operatorToken),
    jsonParser,
    async (req, res) => {
      try {
        const result = await broker.claimEnrollment(req.params.code, {
          name: String(req.body?.name ?? "MultiVibe"),
          email: req.body?.email ? String(req.body.email) : undefined,
          country: req.body?.country ? String(req.body.country) : undefined,
          currency: req.body?.currency ? String(req.body.currency) : undefined,
        });
        res.json(result);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  app.get("/enroll", (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    res.type("html").send(
      page(
        "Connecter une instance MultiVibe",
        `<h1>Connecter une instance</h1>
<p class="muted">Saisissez le code affiché dans <strong>Réglages → Paiements</strong> de votre instance MultiVibe, puis validez.</p>
<form method="post" action="/enroll" autocomplete="off">
  <label for="code">Code</label>
  <input id="code" name="code" value="${escapeHtml(code)}" placeholder="ABCD-EFGH" required>
  <label for="name">Nom de l'instance</label>
  <input id="name" name="name" placeholder="Mon MultiVibe" required>
  <label for="email">Email (facultatif)</label>
  <input id="email" name="email" type="email" placeholder="admin@example.com">
  <label for="country">Pays Stripe (2 lettres)</label>
  <input id="country" name="country" value="FR" maxlength="2">
  <label for="currency">Devise de vente</label>
  <input id="currency" name="currency" value="EUR" maxlength="3">
  <label for="operatorToken">Jeton opérateur</label>
  <input id="operatorToken" name="operatorToken" type="password" required>
  <button type="submit">Approuver</button>
</form>
<p class="muted">En production, cette page est protégée par l'identité MultiVibe Cloud de l'opérateur.</p>`,
      ),
    );
  });

  app.post("/enroll", express.urlencoded({ extended: false, limit: "64kb" }), async (req, res) => {
    if (operatorToken && !safeEqual(String(req.body?.operatorToken ?? ""), operatorToken)) {
      return res.status(401).type("html").send(page("Accès refusé", "<h1>Accès refusé</h1>"));
    }
    try {
      const result = await broker.claimEnrollment(String(req.body?.code ?? ""), {
        name: String(req.body?.name ?? "MultiVibe"),
        email: req.body?.email ? String(req.body.email) : undefined,
        country: req.body?.country ? String(req.body.country) : undefined,
        currency: req.body?.currency ? String(req.body.currency) : undefined,
      });
      res.type("html").send(
        page(
          "Instance connectée",
          `<h1>Instance connectée</h1>
<p><strong>${escapeHtml(result.name)}</strong> est enregistrée.</p>
<p class="muted">Identifiant broker : <code>${escapeHtml(result.instanceId)}</code></p>
<p>Revenez dans l'instance MultiVibe : elle récupère ses identifiants automatiquement et peut continuer vers Stripe.</p>`,
        ),
      );
    } catch (error) {
      const message = error instanceof BrokerError ? error.message : "Erreur inattendue.";
      res
        .status(400)
        .type("html")
        .send(page("Code invalide", `<h1>Code invalide</h1><p>${escapeHtml(message)}</p><p><a href="/enroll">Réessayer</a></p>`));
    }
  });

  // --- Instance authentication --------------------------------------------

  const instanceGuard = (req: Request, res: Response, next: NextFunction) => {
    const secret = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!secret) return res.status(401).json({ error: "unauthorized" });
    let instance: Instance;
    try {
      instance = broker.requireInstance(secret);
    } catch (error) {
      return sendError(res, error);
    }
    const timestamp = req.header("x-multivibe-timestamp") ?? "";
    const signature = req.header("x-multivibe-signature") ?? "";
    const path = req.originalUrl;
    const body = req.rawBody ?? "";
    if (
      !verifyRequestSignature({
        secret,
        timestamp,
        method: req.method,
        path,
        body,
        signature,
        windowMs: clockWindowMs,
      })
    ) {
      return res.status(401).json({ error: "invalid_signature" });
    }
    req.instance = instance;
    // Sign every response with the current stored secret.
    const sign = res.json.bind(res);
    res.json = (payload: unknown) => {
      const serialized = JSON.stringify(payload);
      res.setHeader("x-multivibe-signature", broker.signPayload(broker.secretFor(instance), serialized));
      res.type("application/json");
      return res.send(serialized);
    };
    next();
  };

  const idempotency = async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();
    const instance = req.instance as Instance;
    const key = req.header("idempotency-key")?.trim();
    if (!key || key.length > 200) {
      return res.status(400).json({ error: "idempotency_key_required" });
    }
    const requestHash = crypto
      .createHash("sha256")
      .update(`${req.method}.${req.originalUrl}.${req.rawBody ?? ""}`)
      .digest("hex");
    const existing = store.findIdempotency(instance.id, key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return res.status(409).json({ error: "idempotency_conflict" });
      }
      res.setHeader("idempotent-replay", "true");
      return res.status(existing.statusCode).json(existing.body);
    }
    const json = res.json.bind(res);
    res.json = (payload: unknown) => {
      const statusCode = res.statusCode;
      void store.saveIdempotency({
        instanceId: instance.id,
        key,
        requestHash,
        statusCode,
        body: payload,
        createdAt: Date.now(),
      });
      return json(payload);
    };
    next();
  };

  const instanceRouter = express.Router();
  instanceRouter.use(jsonParser, instanceGuard);

  instanceRouter.get("/instance", (req, res) => {
    const instance = req.instance as Instance;
    res.json({ instance: instanceView(instance) });
  });

  instanceRouter.post("/connect/onboarding", idempotency, async (req, res) => {
    try {
      const result = await broker.connectOnboarding(req.instance as Instance, {
        returnUrl: typeof req.body?.returnUrl === "string" ? req.body.returnUrl : undefined,
        refreshUrl: typeof req.body?.refreshUrl === "string" ? req.body.refreshUrl : undefined,
        email: typeof req.body?.email === "string" ? req.body.email : undefined,
      });
      res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  instanceRouter.get("/connect", async (req, res) => {
    try {
      const status = await broker.connectStatus(req.instance as Instance, {
        loginLink: req.query.loginLink === "1",
        refresh: req.query.refresh === "1",
      });
      res.setHeader("cache-control", "no-store");
      res.json(status);
    } catch (error) {
      return sendError(res, error);
    }
  });

  instanceRouter.post("/checkout", idempotency, async (req, res) => {
    try {
      const result = await broker.createCheckout(req.instance as Instance, req.body);
      res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  instanceRouter.get("/payments", (req, res) => {
    const since = Number(req.query.since ?? 0);
    const limit = Number(req.query.limit ?? 100);
    const payments = broker.listPayments(
      req.instance as Instance,
      Number.isFinite(since) ? since : 0,
      Number.isFinite(limit) && limit > 0 ? limit : 100,
    );
    res.json({ payments });
  });

  instanceRouter.get("/payments/:sessionId", async (req, res) => {
    try {
      const payment = await broker.paymentStatus(
        req.instance as Instance,
        req.params.sessionId,
      );
      res.setHeader("cache-control", "no-store");
      res.json({ payment });
    } catch (error) {
      return sendError(res, error);
    }
  });

  instanceRouter.get("/events", (req, res) => {
    const after = Number(req.query.after ?? 0);
    const limit = Number(req.query.limit ?? 100);
    res.json(
      broker.listEvents(
        (req.instance as Instance).id,
        Number.isFinite(after) ? after : 0,
        Number.isFinite(limit) && limit > 0 ? limit : 100,
      ),
    );
  });

  instanceRouter.post("/refunds", idempotency, async (req, res) => {
    try {
      const result = await broker.refund(req.instance as Instance, req.body);
      res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  instanceRouter.get("/earnings", (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json(broker.earnings(req.instance as Instance));
  });

  instanceRouter.post("/secret/rotate", idempotency, async (req, res) => {
    try {
      const result = await broker.rotateSecret(req.instance as Instance);
      res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.use("/v1", instanceRouter);

  // --- Browser returns -----------------------------------------------------

  app.get("/checkout/return", async (req, res) => {
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
    const payment = sessionId ? store.findPaymentBySession(sessionId) : undefined;
    if (payment) {
      // Best effort: confirm with Stripe and credit the outbox before showing
      // a success page. The instance still pulls events, never this page.
      try {
        const instance = store.findInstance(payment.instanceId);
        if (instance) await broker.paymentStatus(instance, sessionId);
      } catch {
        // The page must not fail because Stripe is slow.
      }
    }
    // Stripe substitutes the template in the URLs it receives, but the deep
    // link is stored once and rendered later: substitute it here so the
    // instance can verify the session on return.
    const deepLink = payment?.successUrl
      ? payment.successUrl.replace("{CHECKOUT_SESSION_ID}", encodeURIComponent(sessionId))
      : undefined;
    res.type("html").send(
      page(
        "Paiement",
        `<h1>Merci !</h1>
<p>Votre paiement est en cours de vérification. Le crédit apparaît dans votre instance dès que Stripe confirme.</p>
${deepLink ? `<p><a href="${escapeHtml(deepLink)}">Revenir à votre instance</a></p>` : ""}
<p class="muted">La page de retour ne crédite jamais le compte : seule la confirmation signée de Stripe le fait.</p>`,
      ),
    );
  });

  app.get("/checkout/cancel", (req, res) => {
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
    const payment = sessionId ? store.findPaymentBySession(sessionId) : undefined;
    const cancelTarget = payment?.cancelUrl ?? payment?.successUrl;
    const deepLink = cancelTarget
      ? cancelTarget.replace("{CHECKOUT_SESSION_ID}", encodeURIComponent(sessionId))
      : undefined;
    res.type("html").send(
      page(
        "Paiement annulé",
        `<h1>Paiement annulé</h1>
<p>Aucun montant n'a été débité.</p>
${deepLink ? `<p><a href="${escapeHtml(deepLink)}">Revenir à votre instance</a></p>` : ""}`,
      ),
    );
  });

  const connectPage = (title: string, body: string) => page(title, body);
  for (const path of ["/connect/return", "/connect/refresh"]) {
    app.get(path, (req, res) => {
      const instanceId = typeof req.query.instance === "string" ? req.query.instance : "";
      const instance = instanceId ? store.findInstance(instanceId) : undefined;
      res.type("html").send(
        connectPage(
          "Stripe Connect",
          `<h1>Stripe Connect</h1>
<p>${path.endsWith("refresh")
            ? "Le lien d'onboarding a expiré, relancez « Connecter Stripe » depuis l'instance."
            : "Onboarding terminé. Stripe vérifie maintenant vos informations."}</p>
${instance ? `<p class="muted">${escapeHtml(instance.name)} — ${escapeHtml(instance.id)}</p>` : ""}
<p>Revenez dans MultiVibe : l'état est rafraîchi automatiquement.</p>`,
        ),
      );
    });
  }

  // --- Operator API --------------------------------------------------------

  const operatorRouter = express.Router();
  operatorRouter.use(operatorGuard(operatorToken), jsonParser);
  operatorRouter.get("/instances", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json({ instances: broker.listInstances() });
  });
  operatorRouter.post("/instances/:id/commission", async (req, res) => {
    try {
      res.json({
        instance: await broker.setCommission(req.params.id, Number(req.body?.commissionBps)),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });
  operatorRouter.post("/instances/:id/suspend", async (req, res) => {
    try {
      res.json({
        instance: await broker.setSuspended(req.params.id, req.body?.suspended !== false),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });
  operatorRouter.get("/payments", (req, res) => {
    const limit = Number(req.query.limit ?? 500);
    res.setHeader("cache-control", "no-store");
    res.json({ payments: broker.operatorPayments(Number.isFinite(limit) ? limit : 500) });
  });
  operatorRouter.get("/instances/:id/earnings", (req, res) => {
    const instance = store.findInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: "instance_not_found" });
    res.json(broker.earnings(instance));
  });
  app.use("/api", operatorRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  // Express error handler: never leak a Stripe key or a stack trace.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof StripeError || error instanceof BrokerError) {
      return sendError(res, error);
    }
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof BrokerError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  if (error instanceof StripeError) {
    return res.status(502).json({
      error: "stripe_error",
      message: error.message,
      ...(error.code ? { stripeCode: error.code } : {}),
    });
  }
  if (error instanceof SyntaxError) {
    return res.status(400).json({ error: "invalid_json" });
  }
  return res.status(500).json({ error: "internal_error" });
}

export type { Payment };
