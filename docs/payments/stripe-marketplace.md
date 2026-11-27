# Stripe Connect payments: multi-instance marketplace

Reimplementation plan for the Toulousecraft mechanism in MultiVibe: anyone who
installs their own server can collect payments from their users through the
MultiVibe Stripe Connect platform, and the platform takes a commission.

Status: proposal, no payment code has been written yet.

---

## 1. Goal

- Any MultiVibe instance (self-hosted, behind NAT, over HTTP on a LAN) can
  enable billing in a few clicks.
- The instance admin sets their own prices (credit packs, possibly per-model
  rates already in place), collects on **their** Stripe Connect account, and
  sees their revenue.
- The MultiVibe platform keeps a commission per transaction, without ever
  handling end users' money.
- A member buys credit from the instance, pays on Stripe Checkout, and their
  balance is credited reliably and idempotently.
- No Stripe secret key is distributed to self-hosters.

## 2. What Toulousecraft does (reference)

The `toulousecraft` repository contains a central service
`stripe-service/index.js` (Express + Stripe SDK) and a Java client.

Mechanics actually implemented:

1. **Express connected account** created by the platform for each admin:
   `stripe.accounts.create({ type: "express", country: "FR", capabilities: {
   card_payments, transfers }, metadata: { admin_id } })`.
2. **Hosted onboarding**: `accountLinks.create({ type:
   "account_onboarding", return_url, refresh_url })`; the client opens the
   Stripe URL.
3. **Destination-charge checkout**:
   `checkout.sessions.create` with
   `payment_intent_data.application_fee_amount = amount *
   PLATFORM_FEE_PERCENT / 100` and
   `transfer_data.destination = acct_...`. The admin receives the net amount,
   the platform keeps the commission.
4. **Global webhook** `/webhook` in `express.raw` +
   `stripe.webhooks.constructEvent`, events `checkout.session.completed`,
   `account.updated`, `payment_intent.succeeded`.
5. **Global commission** via `PLATFORM_FEE_PERCENT` (default 20).
6. **Client authentication** by a JWT signed by the platform.

Limitations not to reproduce:

- Player credit is a `TODO` in the webhook: no reliable credit.
- The webhook is not persisted, not idempotent, not replayable.
- A self-hosted server behind NAT cannot receive a webhook, and Stripe rejects
  non-HTTPS return URLs: the browser return breaks.
- A single global commission, not snapshotted per payment.
- No refunds, no disputes, no ledger, no reconciliation.
- Secrets encrypted/obfuscated in the Java client: security through obscurity,
  and the central service holds the platform secret key for everyone.

## 3. Target architecture

```
Member browser
   │  1. purchase
   ▼
MultiVibe instance (Node)  ──2. POST /checkout (HMAC)──►  Marketplace broker
   │   ▲                                                     │  3. Checkout Session
   │   └────────────── 6. signed event / poll ──────────────┤
   │                                                         ▼
   └── 7. wallet credit (idempotent)                    Stripe Connect
                                                             │
                                                             └── instance connected account

Browser ──4. payment──► Stripe Checkout ──5. webhook──► Broker
```

- **Instance**: source of truth for the user balance, holds only its instance
  secret. It never talks to Stripe directly.
- **Broker**: the marketplace service. Creates and manages connected accounts
  (Express dashboard), Checkout sessions, commissions, refunds, the payment
  ledger and an event journal per instance.
- **Stripe**: KYC, collection, payouts, Radar, optional VAT.

This split is necessary because an instance may be unreachable (behind NAT) and
on HTTP. The broker is the durable point; the instance pulls the events.

## 4. Economic model

### 4.1 Charge type: direct charges recommended

Toulousecraft used **destination charges**. It is the simplest to wire (a single
key, the platform's), but it is not the right model for a self-hosted
marketplace:

- the platform is debited for Stripe fees, refunds and disputes, even with
  `on_behalf_of`;
- connected accounts cannot handle refunds or disputes themselves;
- the platform carries the negative balances;
- the commission must cover the processing fees, and therefore has to be
  artificially high.

Recommended: **direct charges** on Connect v2 accounts configured as the
Express equivalent.

```
stripe.accounts.create({
  dashboard: "express",
  fees_collector: "stripe",        // the connected account pays the Stripe fees
  losses_collector: "stripe",      // Stripe carries the negative balances
  requirements_collector: "stripe",
  configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
  metadata: { instance_id, platform: "multivibe" },
})
```

Then the Checkout session is created **on the connected account**
(`stripe.checkout.sessions.create(params, { stripeAccount: acct_... })`) with
`payment_intent_data.application_fee_amount`.

Consequences:

- the connected account is the merchant of record: bank statement, VAT,
  refunds and disputes belong to it;
- Stripe debits its fees from the connected account, not from ours;
- our commission is net revenue, with no processing to cover;
- negative balances and chargebacks are carried by Stripe
  (`losses_collector: stripe`), not by the platform;
- the admin can refund from their Express dashboard or through the broker.

Formula:

```
feeCents = round(amountCents * commissionBps / 10000)
netCents = amountCents - feeCents - stripeFees   // paid by the connected account
```

The commission can therefore be low (5% for example) without a loss.

**Destination charges fallback** if direct charges are not available (country
not covered, legacy v1 `type=express` account, or a Stripe constraint):

- `checkout.sessions.create` on the platform account with
  `payment_intent_data.application_fee_amount` +
  `transfer_data.destination` + `on_behalf_of`;
- our balance pays the Stripe fees, the refunds and the disputes;
- the minimum commission must cover ~2.9% + 0.30 in the currency, otherwise the
  platform loses money;
- connected accounts cannot refund: everything goes through the broker.

The broker chooses the mode per instance (`chargeMode: "direct" | "destination"`)
and freezes it at account creation; it is not mixed during the account's life.

### 4.2 BYO Stripe alternative (phase 2)

`byo-stripe` mode: the admin pastes their own keys (Standard account or a v2
account they own), the instance talks to Stripe directly, no commission. Useful
for businesses that refuse the marketplace, and it de-risks activation of the
platform Connect account.

### 4.3 VAT and compliance

- The credit sale is made by the instance admin: their tax responsibility,
  their Stripe account, their VAT.
- The commission is a B2B service from the platform: to be invoiced by us
  (Stripe Tax on the platform account, or annual invoicing).
- The broker must publish marketplace terms of service (prohibitions, refunds,
  disputes) and Stripe must approve the Connect/marketplace usage.
- In direct charge, the connected account is the merchant of record: it is the
  one that appears on the end customer's statement.

## 5. Enrollment without OAuth redirect (NAT-compatible)

A classic OAuth flow requires a public HTTPS `redirect_uri`. So we use a
**device code**:

1. Admin → Settings → Payments → "Connect Stripe".
2. `POST {broker}/v1/enrollments` → `{ code, verificationUrl, expiresAt }`
   (short code, 10 minutes, single use).
3. The UI displays the code and the link. The admin opens it on their phone or
   another browser, signs in to their marketplace account (email + magic link
   or passkey, reusing the MultiVibe Cloud identity), enters the code and names
   the instance.
4. The instance polls `GET /v1/enrollments/{code}` (or receives an SSE push) and
   obtains `{ instanceId, instanceSecret }` exactly once.
5. The secret is stored on the instance side in a `0600` file (or a dedicated
   store field with restrictive permissions); the broker keeps only a hash.

Accepted variant: if the instance already has a MultiVibe Cloud connection, the
broker can reuse that identity to pre-fill step 3.

## 6. Stripe Connect onboarding

- `POST /v1/instances/{id}/connect/onboarding` (instance secret auth):
  - creates the v2 account if missing, with the §4.1 configuration
    (`dashboard: "express"`, `fees_collector: "stripe"`,
    `losses_collector: "stripe"`, `requirements_collector: "stripe"`,
    `card_payments` capability), the admin's country, email,
    `metadata: { instance_id, platform: "multivibe" }`;
  - creates an `accountLink` `account_onboarding`.
- `return_url` and `refresh_url` point to pages **of the broker**
  (`/connect/return?instance=...`), which show "Back to your server" with a deep
  link. Stripe never sees a local HTTP URL.
- `GET /v1/instances/{id}/connect` returns
  `{ status: not_connected | pending | restricted | active, chargesEnabled,
  payoutsEnabled, requirementsDue, dashboardUrl? }`.
- `account.updated` and capability events update the broker and emit a
  `connect.updated` event.
- "Stripe dashboard" button: `accounts.createLoginLink` (Express) so the admin
  sees their payments and payouts.
- One account = one country and one settlement currency. Changing country later
  requires a new account: to be shown at onboarding.
- Check before any checkout: `charges_enabled` and the `card_payments`
  capability active.

## 7. Checkout and credit

### 7.1 Packs defined by the instance

```json
{
  "id": "pack_10",
  "label": "€10 of credit",
  "amountCents": 1000,
  "currency": "EUR",
  "creditUsd": 10,
  "bonusUsd": 0
}
```

The admin chooses a single sales currency per instance. Credit is expressed in
USD (MultiVibe's internal unit) and fixed per pack: no implicit conversion and
no hidden exchange rate.

### 7.2 Session creation

`POST /v1/instances/{id}/checkout` with `Idempotency-Key`:

```json
{
  "packId": "pack_10",
  "amountCents": 1000,
  "currency": "EUR",
  "creditUsd": 10,
  "userRef": "usr_...",
  "customerEmail": "member@example.com",
  "successUrl": "https://instance.example/billing/return",
  "cancelUrl": "https://instance.example/billing"
}
```

The broker validates: instance active, `chargesEnabled`, allowed currency,
integer amount within `[minCharge, maxCharge]`, `creditUsd` positive and capped.
It does not know the instance's prices and cannot verify them: the admin is the
merchant, the risk is theirs.

Stripe (direct mode, recommended):

- `stripe.checkout.sessions.create(params, { stripeAccount: acct_... })`;
- `mode: "payment"`, `line_items` built from the pack;
- `client_reference_id = userRef`;
- `payment_intent_data: { application_fee_amount: feeCents, metadata: {...} }`;
- `success_url = {broker}/checkout/return?session_id={CHECKOUT_SESSION_ID}`;
- the broker then redirects to the instance's `successUrl`, adding
  `session_id`.

In destination mode (fallback), the session is created on the platform account
with `payment_intent_data.transfer_data.destination` and `on_behalf_of` as well.

Response: `{ url, sessionId, amountCents, feeCents, netCents, currency,
chargeMode, expiresAt }`.

### 7.3 Reliable credit

- The instance **never** credits on the browser redirect alone.
- It calls `GET /v1/instances/{id}/payments/{sessionId}` or waits for the
  `payment.succeeded` event.
- Credit is idempotent: `paymentId`/`sessionId` unique in the local ledger
  (`creditLedger`), replaying does not double it.
- Credit adds `creditUsd + bonusUsd` to the user's wallet, with a `topup` entry
  containing `paymentId`, amount paid, currency, commission, date.

### 7.4 Return, expiration, abandonment

- Expired session → `checkout.expired` event (or `unpaid` status at poll), no
  credit.
- Pending payment (asynchronous methods) → `processing`, credit only at `paid`.
- The instance shows a "payment being verified" state rather than a false
  success.

## 8. Events and reliability

This is the point Toulousecraft is missing.

- Stripe webhooks → broker only, with a `raw` body,
  `stripe.webhooks.constructEvent`, with **two endpoints and two secrets**:
  - "your account" (`connect: false`): platform events;
  - "connected accounts" (`connect: true`): events of the direct charges
    (`event.account` set).
- Check `event.livemode` and match it against the instance's mode. For an object
  of a direct charge, retrieve it **as the connected account**
  (`stripeAccount: event.account`), otherwise Stripe answers "No such…".
- The broker persists each event in `stripe_events` (key `stripe_event_id`,
  idempotence) then in an **outbox per instance**:
  `instance_events(instance_id, seq, type, payload, created_at)`.
- The instance pulls `GET /v1/instances/{id}/events?after={cursor}&limit=100`,
  applies each event, then advances its cursor **in the same flush** as the
  credit. A duplicate is ignored by `stripeEventId`.
- Polling: at startup, every 60 s when billing is active, and right after a
  checkout return. No need to be reachable.
- Optional push later (SSE or signed outgoing webhook) for latency, never as the
  single source.
- Retention 90 days; beyond that, reconciliation happens via
  `GET /v1/instances/{id}/payments?since=`.
- Daily reconciliation on the instance side: sessions of the last 7 days
  compared against the local ledger.

Event types: `payment.succeeded`, `payment.refunded`,
`payment.disputed`, `connect.updated`, `checkout.expired`.

## 9. Refunds, disputes, chargebacks

Direct charges (recommended):

- `POST /v1/instances/{id}/refunds` (instance admin, or from their Express
  dashboard): the broker runs `refunds.create` on the connected account and
  emits `payment.refunded`.
- The commission can be returned with `refund_application_fee: true` depending
  on the commercial policy. Stripe never does it automatically.
- Disputes are debited from the connected account; Stripe is responsible for
  negative balances (`losses_collector: stripe`). The broker emits
  `payment.disputed` and freezes the related credit.
- The instance debits the wallet by the credited amount, clamps at 0, journals
  it, and freezes the account if the balance goes negative beyond a
  configurable threshold.
- No member self-service refund in v1: that would allow laundering credit
  already consumed.

Destination charges (fallback):

- Refunds and disputes are debited from the **platform balance**;
- connected accounts cannot refund themselves: everything goes through the
  broker, which must watch its balance and suspend instances at risk;
- `refund_application_fee` does not exist in this mode: the commission is
  clawed back by a manual refund or an adjustment entry.

## 10. Credit accounting in MultiVibe

Current state:

- `User.quota.creditUsd` = the period's allocation (month/day/total), reset to
  zero by `rollUsagePeriod`.
- `User.usage.costUsd` = cumulative cost of the period.
- Enforcement: `user_access()` in `rust/v1-edge/src/lib.rs` and
  `reasonsFor()` / `remainingFor()` in `src/users.ts`.
- The cost is recorded by `store.recordUserUsage()` from the `onCompleted`
  callback of `createTraceManager` (`src/server.ts`).

Additions:

```ts
type CreditEntry = {
  id: string;
  kind: "allowance" | "topup" | "adjust" | "refund" | "debit";
  amountUsd: number;          // signed
  balanceAfterUsd: number;    // wallet after the entry
  at: number;
  actor?: string;             // admin or "system"
  paymentId?: string;         // Stripe reference on the broker side
  note?: string;
};

type User = {
  // ...
  /** Purchased credit, persists from one period to the next. */
  walletUsd?: number;
  /** Share of the period cost covered by the quota allowance. */
  usage: UserUsage & { grantedCostUsd?: number };
  /** Bounded journal (last 500 entries). */
  creditLedger?: CreditEntry[];
};
```

Charging rules in `recordUserUsage`:

```
if quota.creditUsd === undefined:
    // unlimited credit: the wallet is not debited
    usage.grantedCostUsd += cost
else:
    grantedRemaining = max(0, quota.creditUsd - usage.grantedCostUsd)
    covered          = min(cost, grantedRemaining)
    usage.grantedCostUsd += covered
    walletUsd       -= (cost - covered)
```

- Unlimited credit (`creditUsd` absent): no wallet debit, otherwise an account
  without a cap would empty a purchased wallet for no reason.
- The period allowance is consumed first, then the wallet.
- `rollUsagePeriod` resets `grantedCostUsd` to 0 and **does not touch** the
  wallet.
- A request already in flight cannot be stopped midway: the balance can
  therefore go negative by the cost of that last request. We do not clamp (that
  would lose the real debt); the account is blocked as soon as the balance is
  ≤ 0. Decision approved: the slight overshoot is allowed and a negative balance
  is kept as is, visible in the dashboard, until the next top-up.
- Enforcement: exhausted if
  `usage.grantedCostUsd >= quota.creditUsd && walletUsd <= 0`, or token/request
  caps reached.
- Rust backward compatibility: if `walletUsd` or `grantedCostUsd` are absent
  (old `accounts.json`), fall back to the current calculation
  `usage.costUsd >= quota.creditUsd`.
- `POST /admin/users/:id/credit` (existing) keeps increasing
  `quota.creditUsd` and journals an `allowance` entry.
- A direct edit of the cap in the user form is journaled the same way (delta
  only).
- `POST /admin/users/:id/wallet` credits or debits the prepaid balance
  (goodwill gesture, refund), journaled, with an optional note.
- `GET /admin/users/:id/credits` returns `{ walletUsd, ledger }` for the
  **Users** tab (balance, form, last eight movements).
- Member **Credit** tab: `GET /admin/me` is enough, it already exposes
  `walletUsd` and `usage.remainingCreditUsd`; no leak of other members.
- Balance shown to the member:
  `max(0, creditUsd - grantedCostUsd) + max(0, walletUsd)`.

Do not debit `usage.costUsd` directly: it resets, so purchased credit would
become spendable again every period.

## 11. Broker API

Instance auth: `Authorization: Bearer <instanceSecret>` +
`X-Multivibe-Timestamp` + `X-Multivibe-Signature =
HMAC-SHA256(secret, timestamp + "." + method + path + sha256(body))`,
5-minute window, `Idempotency-Key` mandatory on writes. The `instanceId` is
always derived from the secret, never read from the body.

| Method | Route | Role |
| --- | --- | --- |
| POST | `/v1/enrollments` | start a device code |
| GET | `/v1/enrollments/{code}` | retrieve the identity (once) |
| POST | `/v1/enrollments/{code}/claim` | approve on the browser side |
| GET | `/v1/instance` | name, status, commission, currency |
| POST | `/v1/connect/onboarding` | create the v2 account + link |
| GET | `/v1/connect` | KYC status, capabilities, dashboard |
| POST | `/v1/checkout` | create a Checkout session (on the connected account in direct mode) |
| GET | `/v1/payments/{sessionId}` | verified status of a payment |
| GET | `/v1/payments?since=&limit=` | reconciliation |
| GET | `/v1/events?after=&limit=` | signed outbox |
| POST | `/v1/refunds` | refund |
| GET | `/v1/earnings` | gross, commission, net, upcoming payouts |
| POST | `/v1/secret/rotate` | rotation without downtime |

Platform API (operator dashboard, operator auth):

- list the instances (GMV, commission, KYC status, country);
- change `commissionBps` (snapshot per payment, never retroactive);
- suspend an instance (fraud, chargebacks);
- see payments, refunds, disputes;
- accounting exports.

## 12. Broker data model

Postgres recommended; SQLite acceptable in single-instance mode.

- `platform_users(id, email, passkey…, created_at)`
- `instances(id, owner_id, name, secret_hash, status, commission_bps,
  charge_mode, default_currency, country, created_at, suspended_at)`
- `connect_accounts(instance_id, stripe_account_id UNIQUE, charge_mode,
  charges_enabled, payouts_enabled, requirements JSONB, country,
  livemode, updated_at)`
- `checkout_intents(id, instance_id, stripe_session_id UNIQUE,
  payment_intent_id, amount_cents, fee_cents, currency, credit_usd, user_ref,
  pack_id, charge_mode, livemode, status, idempotency_key UNIQUE, created_at,
  paid_at)`
- `stripe_events(stripe_event_id PK, type, payload JSONB, received_at,
  processed_at)`
- `instance_events(id BIGSERIAL, instance_id, seq, type, payload JSONB,
  created_at)` + index `(instance_id, seq)`
- `refunds(id, checkout_id, stripe_refund_id, amount_cents, reason, status,
  created_at)`
- `audit_log(actor, action, target, metadata, at)`

## 13. Changes in MultiVibe

### Node backend

- `src/types.ts`: `StoreSettings.payments`, `PaymentPack`, `PaymentsSettings`,
  `User.walletUsd`, `User.creditLedger`, `CreditEntry`, `AppliedPayment`.
- `src/payments/` (new):
  - `broker-client.ts`: signed HTTP (HMAC + timestamp), response signature
    verification, timeouts, `Idempotency-Key`, typed errors.
  - `credentials.ts`: `data/payments-credentials.json` file in `0600`
    (instance id, secret, enrollment in progress), never in `accounts.json`.
  - `service.ts`: enrollment, Connect status, onboarding, checkout, outbox
    synchronization, idempotent credit, refunds, daily reconciliation,
    `startPaymentsPoller` (`unref()`).
  - `signing.ts`: HMAC and constant-time comparison, shared with the broker
    wire format.
  - `test-broker.ts`: fake signed `node:http` broker for tests.
- `src/routes/admin/payments.ts`: settings, enrollment, Connect, packs,
  refunds, revenue, synchronization, disconnection.
- `src/routes/billing.ts`: member side — balance, packs, checkout, return
  verification, history.
- `src/server.ts`: service init, poller start, mounting of `/admin/payments`
  and `/admin/billing`, clean shutdown.
- `src/store.ts`: `creditWalletFromPayment` and `refundWalletFromPayment`
  (idempotent by `paymentId`, refund proportional to the credit),
  bounded `paymentAwards`, `recordUserUsage` (granted/wallet charging).
- `src/users.ts`: `reasonsFor` / `remainingFor` include wallet and
  `grantedCostUsd`.
- `src/config.ts`: `MULTIVIBE_MARKETPLACE_URL` (default
  `https://marketplace.multivibe.cloud`, an empty value disables enrollment),
  `MULTIVIBE_MARKETPLACE_SECRET_PATH`,
  `MULTIVIBE_MARKETPLACE_POLL_INTERVAL_MS`,
  `MULTIVIBE_MARKETPLACE_REQUEST_TIMEOUT_MS`.
- `rust/v1-edge/src/lib.rs`: `user_access` reads `walletUsd` /
  `usage.grantedCostUsd` (legacy fallback), reason `payment_required`.

### UI

- `packages/ui/src/components/tabs/BillingTab.tsx` (member): balance, period
  consumption, packs, purchase, verified Stripe return, history.
- `packages/ui/src/components/tabs/PaymentsPanel.tsx` (admin): enrollment,
  Stripe Connect state, onboarding, commission, packs (CRUD), revenue, refunds,
  synchronization.
- `packages/ui/src/App.tsx`: member tab "Credit", admin tab "Payments"
  (Advanced group).
- `packages/ui/src/types.ts`: dashboard types (`DashboardMemberBilling`,
  `DashboardPaymentsOverview`, `DashboardConnectStatus`…).
- `packages/ui/src/i18n/fr/users.ts`: FR catalogs.

### Settings

```ts
type PaymentsSettings = {
  enabled: boolean;
  brokerUrl?: string;
  instanceId?: string;
  commissionBps?: number;       // informational, frozen by the broker
  chargeMode?: "direct" | "destination";
  currency: string;
  packs: PaymentPack[];         // id, label, amountCents, currency, creditUsd, bonusUsd
  lastEventCursor?: number;
  lastSyncAt?: number;
  connect?: {
    status: "not_connected" | "pending" | "restricted" | "active";
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    requirementsDue: string[];
    accountId?: string;
    updatedAt?: number;
  };
};
```

The instance secret is not in `accounts.json`: `data/payments-credentials.json`
file in `0600` (path overridden by `MULTIVIBE_MARKETPLACE_SECRET_PATH`).

## 14. Broker service (operator-hosted)

Delivered state:

- `services/marketplace/` in this repository (TypeScript/Express), multi-stage
  Docker image, dedicated `docker-compose.yml`, single-process JSON store (the
  Postgres adapter remains to be done).
- Pages present: enrollment code (`/enroll`), Connect and Checkout returns,
  operator API (`/api/*`), `GET /health`.
- Current deployment: a `multivibe-marketplace` container on the same host as
  the instance, port `1460` on the LAN, state in `services/marketplace/data/`,
  secrets in `services/marketplace/.env` (0600). The instance reaches it
  through the Docker gateway (`http://<docker-gateway>:1460`).
- Remaining for production: public HTTPS name (`marketplace.multivibe.cloud`)
  in front of this port so Stripe can reach both webhooks, store backups, logs
  without PII.
- Dev: Stripe test keys + `stripe listen --forward-to
  localhost:PORT/webhooks/stripe` and
  `localhost:PORT/webhooks/stripe/connect`.
- Prod: two webhook endpoints (account + connected accounts), live keys,
  alerting on failed events.

<a id="operator-token"></a>

### Where to find the operator token

The broker's `/enroll` page — the one the instance opens from **Settings →
Payments** — asks for an "Operator token" in addition to the enrollment code.
This is neither the instance administration token (`ADMIN_TOKEN`) nor the
enrollment code: it is the secret the marketplace operator configured in the
broker.

- **Generation** (once, then keep it):

  ```sh
  openssl rand -hex 32
  ```

- **Storage**: the value is assigned to `MARKETPLACE_OPERATOR_TOKEN=` in
  `services/marketplace/.env`, on the host running the broker. On the broker
  host: `/srv/multivibe/services/marketplace/.env`, mode `0600`, git-ignored.
  This file must never be copied into the repository, a ticket, a screenshot or
  a message.

- **Reading it on the broker host without leaking it**: from the repository
  checkout on the host,

  ```sh
  cd /srv/multivibe/services/marketplace
  docker compose exec marketplace printenv MARKETPLACE_OPERATOR_TOKEN
  ```

  If the container is stopped:

  ```sh
  sed -n 's/^MARKETPLACE_OPERATOR_TOKEN=//p' \
    /srv/multivibe/services/marketplace/.env
  ```

  The value is displayed in the terminal: do not redirect it to a file and do
  not paste it into a log, a ticket or a conversation. Only the command stays in
  the shell history, never the value. After any change to the `.env`, recreate
  the container (`docker compose up -d`): the environment is read at startup.

- **Empty value**: without `MARKETPLACE_OPERATOR_TOKEN`, the operator API is
  disabled (`/api/*` and `POST /v1/enrollments/:code/claim` answer
  `503 operator_disabled`) and `/enroll` no longer requires a token. Reserve
  this for local development: a production marketplace must always have one.

- **Not to be confused**:
  - `ADMIN_TOKEN`: administration token of the MultiVibe instance (the
    self-hoster's dashboard), stored in the instance `.env`, unrelated to the
    broker;
  - the **enrollment code** (`ABCD-EFGH`): short, single-use code, displayed in
    Settings → Payments and valid for a few minutes;
  - the **operator token**: durable broker secret, shared only with the people
    who operate the marketplace.

The broker never returns this token: it is entered by hand on `/enroll`, or sent
as `Authorization: Bearer` on `/api/*`.

## 15. Security

- No Stripe key at the self-hosters; the broker is the only one talking to
  Stripe.
- Instance secret hashed (scrypt/argon2), rotation possible with a double
  secret for 24 h.
- HMAC + timestamp + idempotence on every call; anti-replay.
- Never any credit on the browser redirect.
- Strict validation: amounts, allowed currencies, caps, rate limit per
  instance.
- `instanceId` derived from the secret, never from the request body.
- Logs: no secret, no card PII (Stripe does not transmit it), opaque `userRef`.
- Checkout requires an active member session (CSRF already covered by the
  existing auth).
- A compromised instance admin can only harm their own account: they are the
  merchant. A stolen secret does not allow creating payments for another
  instance.
- In direct charge, the risk of negative balance and of dispute is carried by
  the connected account and by Stripe (`losses_collector: stripe`); the platform
  remains exposed if its configuration is incorrect.
- Stripe Radar applies to the connected account; new instances possibly under
  manual review before activation.
- Watch for money laundering: very high-value packs, stolen cards, abnormal
  refunds, several instances on the same card.
- Never accept a `stripeAccount` supplied by the instance: the broker resolves
  it from its database.

## 16. Edge cases

- Instance offline at payment time → event kept, credit at the next poll.
- Payment succeeded but instance deleted or secret lost → broker ledger kept,
  manual support.
- Double click / double webhook → idempotence by `session_id`.
- Zero-decimal currencies (JPY) and the Stripe minimum (~0.50) → validation.
- Partial refund, dispute, chargeback → negative wallet or freeze; in direct
  charge, the debit is on the connected account.
- Instance domain change → URLs stored per payment, no dependency.
- Secret rotation without downtime.
- Several admins per instance → owner/admin roles and audit.
- Commission change → snapshot per payment, never retroactive.
- Test mode vs live → flag per instance, never mix the ledgers; check
  `event.livemode`.
- Connect account blocked (`requirementsDue`) → checkout refused with a clear
  message, not a raw Stripe error.
- Direct charge event delivered in the "connected accounts" scope: always read
  `event.account` and query with `stripeAccount`.

## 17. Delivery

| Phase | Content | Estimate |
| --- | --- | --- |
| 0 | Decisions, platform Connect account, terms of service, VAT | 0.5 day + Stripe lead times |
| 1 | Local wallet without Stripe, ledger, Node/Rust enforcement, balance UI | **done** |
| 2 | Broker MVP: device code, Connect, credit + subscription checkout, webhook, outbox, refunds | **done** |
| 3 | Instance integration: signed client, poller, routes, credit, reconciliation | **done** |
| 4 | Ops and hardening: dashboard, metrics, e2e test mode, docs, i18n | 2–3 days |

Indicative total: 11–15 business days, excluding Stripe Connect activation and
business verification.

Phase 1 is delivered: `walletUsd`, `usage.grantedCostUsd`, the bounded
`creditLedger`, Node and Rust enforcement (with a fallback to the old records),
the `/admin/users/:id/wallet` and `/admin/users/:id/credits` routes, the
**Users** tab (balance, credit/debit, journal) and a member **Credit** tab.
Prepaid credit is therefore usable today with manual grants, without any Stripe
dependency.

Phases 2 and 3 are delivered: the TypeScript broker of `services/marketplace`
(Connect v2 accounts, checkout, Stripe and Connect webhooks, signed outbox,
refunds, disputes, revenue, idempotence) and its integration into the instance
(`src/payments/`). The instance keeps its secret in
`data/payments-credentials.json` (0600), signs every HMAC call, verifies the
signature of every response, and credits the wallet by `paymentId` — the same
guard covers the poller, the verified browser return and the daily
reconciliation. The admin **Payments** and member **Credit** tabs expose the
enrollment, the Stripe onboarding, the packs, the synchronization, the revenue,
the refunds and the purchase history.

Member invoices are native Stripe: the top-up checkout enables
`invoice_creation`, the broker resolves `hosted_invoice_url` and `invoice_pdf` at
payment time (`payment.succeeded`), and the instance exposes them in its own
member's history (`GET /admin/billing/history`, filtered by `userRef`). The
member's **Invoices** tab shows "Your MultiVibe purchases" with a direct link to
the hosted invoice, and the matching line of the **Credit** tab history carries
the same link. No invoice is stored on the instance side: Stripe remains the
source of the document, and only HTTPS URLs are passed to the browser.

Remaining before a public production release: a shared SQL adapter (the JSON
store is single-process), a real operator identity instead of
`MARKETPLACE_OPERATOR_TOKEN`, subscription sales from the member UI (the broker
already accepts `kind: subscription`), and a full E2E pass in Stripe test mode
with `stripe listen`.

## 18. Tests

- Unit: granted/wallet charging, rollover, caps, idempotent ledger, HMAC
  signature, anti-replay, amount and currency validation.
- Contract: local broker stub (`node:http`) with Stripe fixtures
  (paid / unpaid / expired / refunded / disputed) — no network call in
  `npm test`.
- Instance + broker stub integration: checkout → return → credit, double
  delivery, network failure, cursor resume, reconciliation.
- Rust: `user_access` with wallet, legacy fallback, `payment_required` message.
- Manual E2E: Stripe test mode, `stripe listen`, 4242 card, Express test
  onboarding, refund, simulated dispute.
- Non-regression: existing suite; the 3 pre-existing failures remain expected.

## 19. Approved decisions

1. **Account type**: v2 "Express" account created by our platform ("one
   click"). Standard/OAuth stays out of the v1 scope.
2. **Charge type**: direct charges + `application_fee_amount`. The instance
   admin is the merchant, pays the Stripe fees, handles disputes and refunds.
   Destination charges + `on_behalf_of` documented as a fallback only.
3. **Commission**: 5% by default, per instance, journaled per payment. In direct
   charge it does not have to cover the Stripe fees; in destination, plan for a
   minimum commission.
4. **Product sold**: both. Prepaid credit (phase 1, delivered) and subscriptions
   or paid plans via Checkout, with the same sliding windows as the current
   plans.
5. **Refunds**: instance admin only. No member self-service, to avoid laundering
   credit already consumed.
6. **Broker**: operator-hosted, enrollment reusing the MultiVibe Cloud identity.
7. **Currencies**: EUR by default, USD optional, a single sales currency per
   instance.

## 20. What we do not take from Toulousecraft

- Encrypted/obfuscated configuration in the distributed client.
- Single global commission not journaled.
- Non-persistent and non-idempotent webhook.
- Credit left as a `TODO`.
- Browser return as proof of payment.
- No refunds, disputes, reconciliation or ledger.
