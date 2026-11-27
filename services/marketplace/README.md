# MultiVibe marketplace broker

Self-hosted instances sell prepaid credit (and, next, paid subscriptions) with
their own Stripe Connect account. This service is the platform-side broker: it
keeps the instance registry, creates Connect accounts, opens Checkout sessions,
receives Stripe webhooks, and exposes a signed event outbox that instances pull.

The instance is the merchant of record. MultiVibe keeps a per-instance
commission (5% by default), snapshotted on every payment.

## Run

```sh
cd services/marketplace
npm install # only when the workspace has no root node_modules
STRIPE_SECRET_KEY=sk_test_… \
STRIPE_WEBHOOK_SECRET=whsec_… \
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_… \
MARKETPLACE_PUBLIC_URL=https://marketplace.example.com \
MARKETPLACE_OPERATOR_TOKEN=… \
MARKETPLACE_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `1460` | HTTP port. |
| `HOST` | all interfaces | Bind address. |
| `MARKETPLACE_DATA_PATH` | `/data/marketplace.json` | JSON store (instances, accounts, payments, outbox, idempotency). |
| `MARKETPLACE_PUBLIC_URL` | `http://127.0.0.1:$PORT` | Public base URL used in enrollment links and Checkout return URLs. |
| `STRIPE_SECRET_KEY` | — | Platform key. `sk_live_…` switches the broker to livemode. |
| `STRIPE_API_VERSION` | `2026-11-18.preview` | Pinned API version, needed for Connect v2. |
| `STRIPE_API_BASE_URL` | Stripe | Override for tests. |
| `STRIPE_WEBHOOK_SECRET` | — | Endpoint for platform-scope events. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | — | **Separate** endpoint for connected-account events (`event.account`). Direct charges arrive only there. |
| `MARKETPLACE_OPERATOR_TOKEN` | empty | Bearer token for `/api/*` (list instances, change commission). Empty disables the operator API. |
| `MARKETPLACE_ENCRYPTION_KEY` | empty | AES-256-GCM key sealing instance secrets at rest. Without it, secrets are base64 (development only). |
| `MARKETPLACE_COMMISSION_BPS` | `500` | Default commission in basis points for new instances. |

The store is single-process. A load-balanced deployment needs the SQL adapter:
two brokers sharing one JSON file would fork the outbox and the idempotency
cache.

## Instance flow

1. `POST /v1/enrollments` → short code + device code.
2. The admin opens `verificationUrl`, signs in on the marketplace and approves
   the instance (operator identity plugs into `MARKETPLACE_OPERATOR_TOKEN`).
3. The instance polls `GET /v1/enrollments/:code` with the device code and
   receives its secret **exactly once**. It stores it in a `0600` file, never in
   `accounts.json`.
4. `POST /v1/connect/onboarding` creates (or reuses) a Connect v2 account and
   returns a hosted onboarding link. `GET /v1/connect?refresh=1` reads the live
   capability state; `?loginLink=1` also returns a dashboard link.
5. `POST /v1/checkout` opens a Checkout session on the connected account with
   `application_fee_amount`. The response carries `paymentId`, `sessionId`,
   amount, fee and net.
6. Stripe sends `checkout.session.*`, `payment_intent.*`, `charge.refunded` and
   `charge.dispute.*` to the **connect** webhook. The broker deduplicates the
   event id and appends one outbox event per state change.
7. The instance pulls `GET /v1/events?after=<cursor>` and credits the wallet
   idempotently by `paymentId`. The browser return only presses the same
   verified path; a redirect is never proof of payment.

Every instance request is signed:

```
Authorization: Bearer <instance secret>
X-Multivibe-Timestamp: <epoch ms>
X-Multivibe-Signature: hmac_sha256(secret, `${timestamp}.${METHOD}.${path}.${sha256(body)}`)
```

`path` includes the query string. Timestamps outside a five-minute window are
rejected. Every response body carries `X-Multivibe-Signature: sha256=<hmac>`
that the instance verifies before trusting it. `POST` requests require an
`Idempotency-Key`: the same key with the same body replays the stored response,
a different body returns `409 idempotency_conflict`.

## Tests

```sh
npm run test:marketplace --prefix ../..
```

The suite uses an in-memory Stripe gateway (`src/fake-stripe.ts`) and a local
Express app; it never calls Stripe. It covers enrollment, Connect reuse,
checkout validation, webhook deduplication, partial and full refunds, disputes,
earnings, outbox pagination and signing.
