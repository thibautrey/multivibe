import crypto from "node:crypto";
import http from "node:http";
import { bodySignature, safeEqual, sha256 } from "./signing.js";

/**
 * Small signed broker used by the instance tests. It mirrors the wire contract
 * of `services/marketplace` without importing it, so the distributed instance
 * test tree has no dependency on the broker source.
 */

export type StubPayment = {
  paymentId: string;
  sessionId: string;
  kind: "topup" | "subscription";
  status: "open" | "paid" | "expired" | "refunded" | "disputed";
  amountCents: number;
  feeCents: number;
  netCents: number;
  currency: string;
  creditUsd?: number;
  userRef: string;
  planRef?: string;
  livemode: boolean;
  createdAt: number;
  paidAt?: number;
  refundedCents?: number;
};

export type StubEvent = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

type RefundInput = { paymentId?: string; sessionId?: string; amountCents?: number };

export type StubBroker = {
  url: string;
  secret: string;
  instanceId: string;
  payments: Map<string, StubPayment>;
  events: StubEvent[];
  failEvents: boolean;
  failCheckout: boolean;
  close: () => Promise<void>;
  markPaid: (sessionId: string) => StubPayment;
  markRefunded: (sessionId: string, amountCents: number) => StubPayment;
  markDisputed: (sessionId: string) => StubPayment;
  resetCursor: () => void;
};

function send(res: http.ServerResponse, status: number, payload: unknown, secret: string): void {
  const raw = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-multivibe-signature", bodySignature(secret, raw));
  res.end(raw);
}

function collect(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function createStubBroker(): Promise<StubBroker> {
  const secret = "inst_secret_test";
  const instanceId = "ins_test";
  const payments = new Map<string, StubPayment>();
  const events: StubEvent[] = [];
  let counter = 0;
  let seq = 0;
  let cursorResetAt = 0;

  const emit = (type: string, payload: Record<string, unknown>) => {
    events.push({ seq: ++seq, type, payload, createdAt: Date.now() });
  };
  const publicPayment = (payment: StubPayment) => ({ ...payment });

  const state: StubBroker = {
    url: "",
    secret,
    instanceId,
    payments,
    events,
    failEvents: false,
    failCheckout: false,
    close: async () => {},
    resetCursor: () => {
      cursorResetAt = Date.now();
    },
    markPaid: (sessionId: string) => {
      const payment = [...payments.values()].find((entry) => entry.sessionId === sessionId);
      if (!payment) throw new Error("unknown session");
      payment.status = "paid";
      payment.paidAt = Date.now();
      emit("payment.succeeded", publicPayment(payment));
      return payment;
    },
    markRefunded: (sessionId: string, amountCents: number) => {
      const payment = [...payments.values()].find((entry) => entry.sessionId === sessionId);
      if (!payment) throw new Error("unknown session");
      payment.refundedCents = (payment.refundedCents ?? 0) + amountCents;
      payment.status = payment.refundedCents >= payment.amountCents ? "refunded" : "paid";
      emit("payment.refunded", publicPayment(payment));
      return payment;
    },
    markDisputed: (sessionId: string) => {
      const payment = [...payments.values()].find((entry) => entry.sessionId === sessionId);
      if (!payment) throw new Error("unknown session");
      payment.status = "disputed";
      payment.refundedCents = payment.amountCents;
      emit("payment.disputed", publicPayment(payment));
      return payment;
    },
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const raw = await collect(req);
    const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    // --- public enrollment --------------------------------------------------
    if (method === "POST" && path === "/v1/enrollments") {
      send(res, 201, {
        code: "ABCD-EFGH",
        deviceCode: "device-code",
        verificationUrl: "https://broker.test/enroll?code=ABCD-EFGH",
        expiresAt: Date.now() + 600_000,
      }, secret);
      return;
    }
    if (method === "GET" && path.startsWith("/v1/enrollments/")) {
      if (req.headers.authorization !== "Bearer device-code") {
        send(res, 403, { error: "invalid_device_code" }, secret);
        return;
      }
      send(res, 200, {
        status: "approved",
        consumed: false,
        instanceId,
        instanceSecret: secret,
      }, secret);
      return;
    }

    // --- instance authentication -------------------------------------------
    const authorization = req.headers.authorization ?? "";
    const timestamp = String(req.headers["x-multivibe-timestamp"] ?? "");
    const signature = String(req.headers["x-multivibe-signature"] ?? "");
    const material = `${timestamp}.${method.toUpperCase()}.${path}.${sha256(raw)}`;
    const expected = crypto.createHmac("sha256", secret).update(material).digest("hex");
    if (
      authorization !== `Bearer ${secret}` ||
      !timestamp ||
      Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000 ||
      !safeEqual(expected, signature)
    ) {
      send(res, 401, { error: "invalid_signature" }, secret);
      return;
    }

    const url = new URL(path, "http://stub.invalid");

    if (method === "GET" && url.pathname === "/v1/instance") {
      send(res, 200, {
        instance: {
          id: instanceId,
          name: "Atelier",
          status: "active",
          commissionBps: 500,
          currency: "EUR",
          country: "FR",
          chargeMode: "direct",
          livemode: false,
          createdAt: Date.now(),
        },
      }, secret);
      return;
    }
    if (method === "POST" && url.pathname === "/v1/connect/onboarding") {
      const input = payload as { returnUrl?: string; refreshUrl?: string; email?: string };
      if (!input.returnUrl?.startsWith("http://instance.test/")) {
        send(res, 400, { error: "invalid_url" }, secret);
        return;
      }
      send(res, 200, {
        url: "https://connect.stripe.test/onboard",
        accountId: "acct_test",
        expiresAt: Date.now() + 300_000,
      }, secret);
      return;
    }
    if (method === "GET" && url.pathname === "/v1/connect") {
      send(res, 200, {
        status: "active",
        chargesEnabled: true,
        payoutsEnabled: true,
        requirementsDue: [],
        accountId: "acct_test",
        updatedAt: Date.now(),
      }, secret);
      return;
    }
    if (method === "POST" && url.pathname === "/v1/checkout") {
      if (state.failCheckout) {
        res.statusCode = 503;
        res.end("unavailable");
        return;
      }
      const id = `pay_${++counter}`;
      const sessionId = `cs_test_${counter}`;
      const amountCents = Number(payload.amountCents ?? 0);
      const payment: StubPayment = {
        paymentId: id,
        sessionId,
        kind: payload.kind === "subscription" ? "subscription" : "topup",
        status: "open",
        amountCents,
        feeCents: Math.round(amountCents * 0.05),
        netCents: amountCents - Math.round(amountCents * 0.05),
        currency: String(payload.currency ?? "EUR"),
        ...(payload.creditUsd !== undefined ? { creditUsd: Number(payload.creditUsd) } : {}),
        userRef: String(payload.userRef ?? ""),
        ...(payload.planRef ? { planRef: String(payload.planRef) } : {}),
        livemode: false,
        createdAt: Date.now(),
      };
      payments.set(id, payment);
      send(res, 200, {
        url: `https://checkout.stripe.test/${sessionId}`,
        sessionId,
        paymentId: id,
        amountCents,
        feeCents: payment.feeCents,
        netCents: payment.netCents,
        currency: payment.currency,
      }, secret);
      return;
    }
    if (method === "GET" && url.pathname.startsWith("/v1/payments/")) {
      const sessionId = decodeURIComponent(url.pathname.slice("/v1/payments/".length));
      const payment = [...payments.values()].find((entry) => entry.sessionId === sessionId);
      if (!payment) {
        send(res, 404, { error: "payment_not_found" }, secret);
        return;
      }
      send(res, 200, { payment: publicPayment(payment) }, secret);
      return;
    }
    if (method === "GET" && url.pathname === "/v1/payments") {
      const since = Number(url.searchParams.get("since") ?? 0);
      send(res, 200, {
        payments: [...payments.values()]
          .filter((payment) => payment.createdAt >= since)
          .map(publicPayment),
      }, secret);
      return;
    }
    if (method === "GET" && url.pathname === "/v1/events") {
      if (state.failEvents) {
        res.statusCode = 503;
        res.end("unavailable");
        return;
      }
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 100));
      const page = events.filter((event) => event.seq > after && event.createdAt >= cursorResetAt);
      const slice = page.slice(0, limit);
      send(res, 200, {
        events: slice,
        cursor: slice.at(-1)?.seq ?? after,
        hasMore: page.length > slice.length,
      }, secret);
      return;
    }
    if (method === "POST" && url.pathname === "/v1/refunds") {
      const input = payload as RefundInput;
      const payment = input.paymentId
        ? payments.get(input.paymentId)
        : [...payments.values()].find((entry) => entry.sessionId === input.sessionId);
      if (!payment) {
        send(res, 404, { error: "payment_not_found" }, secret);
        return;
      }
      const remaining = payment.amountCents - (payment.refundedCents ?? 0);
      const amount = input.amountCents ?? remaining;
      payment.refundedCents = (payment.refundedCents ?? 0) + amount;
      payment.status = payment.refundedCents >= payment.amountCents ? "refunded" : "paid";
      emit("payment.refunded", publicPayment(payment));
      send(res, 200, {
        payment: publicPayment(payment),
        refundId: `re_${++counter}`,
        amountCents: amount,
      }, secret);
      return;
    }
    if (method === "GET" && url.pathname === "/v1/earnings") {
      const paid = [...payments.values()].filter(
        (payment) => payment.status === "paid" || payment.status === "refunded",
      );
      const grossCents = paid.reduce((total, payment) => total + payment.amountCents, 0);
      const feeCents = paid.reduce((total, payment) => total + payment.feeCents, 0);
      const refundedCents = paid.reduce(
        (total, payment) => total + (payment.refundedCents ?? 0),
        0,
      );
      send(res, 200, {
        currency: "EUR",
        grossCents,
        feeCents,
        netCents: grossCents - feeCents - refundedCents,
        refundedCents,
        paidCount: paid.length,
        payments: paid.map(publicPayment),
        refunds: [],
      }, secret);
      return;
    }
    send(res, 404, { error: "not_found" }, secret);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  state.url = `http://127.0.0.1:${address.port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
