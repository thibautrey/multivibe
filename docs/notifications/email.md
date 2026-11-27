# Email notifications

MultiVibe can send transactional account emails (low balance, successful
top-up, spend limit) over SMTP. The feature is opt-in, configured only through
environment variables, and safe to call from billing code: a disabled or
incomplete configuration returns a `skipped` result instead of throwing.

The implementation lives in `src/notifications/`:

| File | Purpose |
| --- | --- |
| `config.ts` | `SmtpConfig`, `smtpConfigFromEnv()`, completeness check |
| `transport.ts` | nodemailer SMTP transport (injectable behind `EmailTransport`) |
| `templates.ts` | shared dark-friendly HTML layout, plain-text alternative, escaping |
| `service.ts` | `NotificationService`, `notifyUserEvent()`, `sendNotification()` |
| `types.ts` | typed events, transport boundary, results |

## Configuration

All values are optional unless noted. A stock instance keeps email disabled.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MULTIVIBE_SMTP_ENABLED` | `false` | Set to exactly `true` to enable delivery. |
| `SMTP_HOST` | — | Relay hostname. Required when enabled. |
| `SMTP_PORT` | `587` | Relay port, capped to `1..65535`. |
| `SMTP_SECURE` | `false` | `true`: implicit TLS (usually port 465). `false`: STARTTLS is required. |
| `SMTP_USER` | — | Optional SMTP AUTH username. |
| `SMTP_PASSWORD` | — | Optional SMTP AUTH password. Set with `SMTP_USER`, or leave both empty. |
| `SMTP_FROM` | `MultiVibe <no-reply@multivibe.cloud>` | Envelope `From` header. |
| `SMTP_REPLY_TO` | — | Optional `Reply-To` header. |
| `MULTIVIBE_CLOUD_API_BASE_URL` | `https://app.multivibe.cloud` | Base URL for CTA links (`/billing`). |

See `.env.example` for a copy-paste block. Docker deployments should pass the
same values through `docker-compose.yml` (already wired) or an `.env` file next
to it.

Configuration rules:

- `MULTIVIBE_SMTP_ENABLED` must be `true`; any other value disables email.
- `SMTP_HOST` and a non-empty `SMTP_FROM` are required.
- `SMTP_USER` and `SMTP_PASSWORD` must be set together. A half-set pair is
  treated as **incomplete**, never as anonymous delivery.
- When disabled or incomplete, `notifyUserEvent()` / `sendNotification()`
  return `{ status: "skipped", reason: "disabled" | "incomplete_config" }`
  without touching the account store or the network.

### TLS

The transport never falls back to clear text:

- `SMTP_SECURE=true` opens implicit TLS immediately. Use it for port 465.
- `SMTP_SECURE=false` requires STARTTLS; a relay that does not advertise the
  upgrade fails instead of receiving credentials in the clear.
- TLS 1.2 is the minimum. Connection, greeting and socket timeouts are 10 s,
  10 s and 30 s.

Nodemailer protocol logging is disabled, so SMTP commands (credentials) and
`DATA` (message bodies) are never written to stdout.

## Events

Events are a discriminated union in `types.ts`. Every event has a stable
English subject, an HTML alternative and a plain-text alternative.

| Type | Payload | Subject |
| --- | --- | --- |
| `balance_low` | `{ balanceUsd, thresholdUsd?, ctaUrl? }` | `Your MultiVibe balance is low` |
| `topup_succeeded` | `{ amountUsd, balanceUsd?, ctaUrl? }` | `Your MultiVibe top-up succeeded` |
| `spend_limit_reached` | `{ limitUsd, spentUsd?, periodLabel?, ctaUrl? }` | `You reached your MultiVibe spend limit` |

Amounts are rendered in USD with `Intl.NumberFormat("en-US", { style:
"currency", currency: "USD" })`. `ctaUrl` is optional; only absolute `http:` or
`https:` URLs are accepted. Anything else falls back to
`<MULTIVIBE_CLOUD_API_BASE_URL>/billing`.

### Adding an event

1. Add a key and payload to `NotificationPayloads` in
   `src/notifications/types.ts`.
2. Add the matching template to `TEMPLATES` in
   `src/notifications/templates.ts` and a `case` in `buildTemplate()`.

The `switch` uses a `never` exhaustiveness check, so `npx tsc -b` fails until
the new event has a template.

## API

```ts
import type { AccountStore } from "./store.js";
import { notifyUserEvent, sendNotification } from "./notifications/index.js";

// Resolve the member by id, then send. This is the billing-hook entry point.
const result = await notifyUserEvent(store, userId, {
  type: "balance_low",
  data: { balanceUsd: 2.4, thresholdUsd: 5 },
});

// Explicit recipient, when there is no user record.
const direct = await sendNotification({
  to: "member@example.com",
  type: "spend_limit_reached",
  data: { limitUsd: 50, spentUsd: 50, periodLabel: "November 2026" },
});
```

For dependency injection or a long-lived instance, construct the service once:

```ts
import { createNotificationService } from "./notifications/index.js";

const notifications = createNotificationService(); // reads process.env
await notifications.notifyUserEvent(store, userId, event);
await notifications.sendNotification(input, "Sam"); // optional greeting name
```

Results:

```ts
type NotificationResult =
  | { status: "sent"; type: NotificationEventType; to: string; messageId?: string }
  | { status: "skipped"; type: NotificationEventType; reason: "disabled" | "incomplete_config" | "user_not_found" | "missing_email" }
  | { status: "failed"; type: NotificationEventType; error: string };
```

Behavior details:

- A missing user returns `user_not_found`; an empty or invalid address returns
  `missing_email`. Neither creates a transport.
- **Suspended members still receive email.** Only a missing address is skipped.
- Transport errors return `failed` with a sanitized error and log one warning
  (`notifications: <type> email failed: ...`). The error is redacted for the
  SMTP username and password.
- The service does not deduplicate events. A billing hook that may replay a
  webhook must keep its own idempotency guard (for example on `paymentId`)
  before calling it.
- Do not pass API keys, full payment ids, card data or other secrets in event
  payloads. The templates only need amounts, thresholds and labels.

### Future billing hook example

```ts
async function afterWalletCredit(store: AccountStore, userId: string, amountUsd: number) {
  const user = await store.findUser(userId);
  if (!user) return;
  await notifyUserEvent(store, userId, {
    type: "topup_succeeded",
    data: { amountUsd, balanceUsd: user.walletUsd },
  });
}
```

The call is safe inside a request or payment poller: it never throws for
configuration or delivery problems. Callers that need observability can inspect
the returned `status` and log it themselves.

## Security notes

- All interpolated values are HTML-escaped before entering the layout or an
  attribute; headers are collapsed to a single line.
- CTA links allow only absolute `http:`/`https:` URLs.
- Emails contain no secrets, API keys, credentials or full payment
  identifiers. Payment ids are intentionally not part of any template.
- SMTP credentials exist only in process environment / deployment secrets and
  are never logged, persisted in `accounts.json`, or included in a message.
- The transport boundary (`EmailTransport`) keeps unit tests off the network:
  `src/notifications/email.test.ts` uses a fake transport.

## Tests

```sh
npx tsc -b
npx tsx --test src/notifications/email.test.ts
```

The suite covers disabled and incomplete configuration, each event's subject
and escaped values, missing user/email skips, suspended members, USD formatting,
unsafe CTA fallback, credential redaction, and delivery failures.
