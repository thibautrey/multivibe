# Live inference with a USD 2 total cap — 2026-09-07

## Outcome

Stopped before activation or financial mutation: no existing operator/admin
credit or real test-entitlement mechanism designed for this purpose was found
in the inspected Cloud checkout (`85c5549`). No inference request was sent and
this task incurred no inference or payment spend. The user authorized up to
USD 2 total, not a subscription, recurring charge or a broader grant.

## Current read-only evidence

At 20:42:18 UTC, the runtime audit passed the complete pepper/readiness gate.
There are still exactly two active keys with creation events. All sampled
activation flags remain false: managed live inference, monetary effects and
marketplace routing.

A separate read-only aggregate, with a five-second statement timeout, covered
all projects referenced by existing service keys without emitting identities:

- one project is referenced by the keys;
- zero such projects have available, effective, unblocked live credit eligible
  for reservation (correction lots excluded);
- zero have an effective hard project budget.

The previous audit established no entitlement or balance rows for these keys.
The financial aggregate did not fetch the raw key or expose any organization,
project, payment identifier, secret or financial balance. It was not an atomic
snapshot with the runtime audit.

## Mechanisms inspected and limits

Cloud `docs/managed-mistral-launch.md` documents fixed subscription credit backed
by a real paid invoice, a hard project budget, fresh global solvency and broker
mTLS. Some historical deployment statements there predate the currently wired
live gateway; source `src/server-safe.ts` now selects the project-only verifier
and live gateway when the managed flag is enabled. Synthetic shadow entitlement
rows are not a prerequisite to manufacture for this live path.

`src/live-credit-reservation.ts` enforces hard per-request and monthly budgets
under a project lock, reserves global provider capacity, and consumes existing
eligible live credit lots. It explicitly excludes correction lots. A monthly
USD 2 budget alone would not establish a permanent total USD 2 cap.

The inspected credit creation paths were:

- `src/stripe-live-billing-repository.ts`: real Stripe-backed subscription/top-up
  grants with commercial evidence and ledger postings;
- `src/agent-payments-postgres.ts`: top-up fulfillment requires a successful
  live payment proof bound to the order, amount, customer and organization;
- `src/commercial-credit-foundation-postgres.ts` and
  `src/subscription-credit-lifecycle-shadow.ts`: shadow mechanisms;
- `src/provider-cash-withdrawals.ts`: provider earnings conversion, not a test
  credit grant.

No inspected path provides an auditable operator grant for this unfunded test
project. Stripe subscription funding starts above this task's total cap and is
recurring; shadow grants, fabricated payment evidence and direct ledger inserts
cannot substitute. Paid top-up paths likewise are not operator/test grants and
were not invoked. OpenBao metadata discovery was performed; lack of shell
credentials was not used as the reason for stopping.

## Missing mechanism and remaining proof

A reviewed, auditable non-recurring test credit mechanism that can bound this
specific project's total liability to USD 2 is required before continuing under
the requested conditions. It must preserve the financial source and solvency
invariants and support a much smaller server-enforced per-request limit.
Creating such a financial capability is not a routine test-lab change.

No config activation or rollout was attempted, so no new rollback was needed.
Provider route/rate/solvency readiness and lowest-cost routable model selection
were not completed after the funding gate failed. Host authenticated catalog,
restart persistence and the single 16-output-token inference remain unverified.
Do not interpret this report as permission to enable flags or create credits.
