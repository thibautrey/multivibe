# Non-monetary shadow test readiness — 2026-09-07

The user authorized a very small real test, with commercial credits, monetary
effects, subscriptions and top-ups disabled. This supersedes the earlier
funding investigation as the requested approach. No grant, route, key, flag,
financial record or inference request was created during this inspection.

## Observations

A bounded read-only aggregate over every project referenced by service keys
returned one project and zero projects with an active `approved_synthetic`
managed route. The query emitted counts only, not project or user identifiers.
The broker Deployment reports two desired and two ready replicas. The public
API readiness request returned HTTP 403; that does not identify whether the
edge or application denied the probe and does not prove provider readiness.
No provider generation was attempted as a readiness probe.

## Existing mechanisms

Cloud `scripts/bootstrap-shadow.ts` unconditionally creates a new organization,
project and service key, plus entitlement, balance, regional lease and routes.
It cannot target an existing project or reuse the current key. Even with one
unit and concurrency one, its entitlement/key expire after 30 days and its
minimum lease is one hour. It also assigns `approved_synthetic` to supplied
model names and prints the new raw key. It was inspected but not executed:
that would create broader access than the exact-project request.

`docs/mvp-managed-shadow.md` describes a real managed broker forwarding path
using one non-monetary `shadow_admitted_request_v1` unit per admitted request.
The legacy store's catalog and admission queries require project-specific
active routes with `rights_status='approved_synthetic'` in the current region.
An entitlement alone would not establish an approved usable route.

The operator materializer documented in
`docs/subscription-managed-access-test-corridor.md` is bounded to 15 minutes
but requires an eligible reconciled Stripe test candidate, exact paid-invoice
and PaymentIntent evidence, project ownership and approved synthetic routes.
It issues its own new key and is not a generic admission grant for an existing
key. Its contract excludes real customer traffic and commercial/provider effects.
No test payment evidence was fabricated and no corridor flag was enabled.

## Stop boundary

No inspected existing command meets the combined requirements of the current
project/key, approved ready route, minimal admission and short expiry. Adapting
the bootstrap by raw SQL would bypass its provisioning contract and would still
not establish route approval. A purpose-built existing-project operator admission
mechanism and approved provider route are needed before this path can proceed.

Host authenticated catalog, restart persistence and exactly one non-streaming
Responses request of at most eight output tokens remain unverified. There is
no new admission to clean up or expire. Any future attempt must preserve stable
idempotency and no retries, and must not infer provider readiness from replica
readiness alone. Source inspection used Cloud checkout `85c5549`; no claim is
made that all of its runbook statements describe the current deployment.

## Follow-up: global route approval census

The subsequent request explicitly made an already approved and currently
broker-routable route a prerequisite to implementing or applying admission.
The production aggregate was expanded beyond the current project:

- `managed_model_routes`: zero rows in total;
- active `approved_synthetic` managed routes: zero;
- `provider_route_versions` with active state, approved rights and approved
  contract: zero.

These are necessary approval predicates, not a complete provider eligibility
check. Because there are no candidates satisfying even these predicates,
there is no eligible route whose broker routability can be established for
this task. A ready broker or an advertised model would not substitute for
route approval. No model request, admission, route insertion or self-approval
was attempted. No admission cleanup is necessary.

The exact remaining external decision is approval by the route owner of a
specific route for the bounded non-monetary synthetic test, followed by proof
that the broker can route it. Only then does the user's conditional instruction
authorize implementing and applying the one-unit, concurrency-one,
short-lived admission for the existing project/key. The single non-streaming
Responses request remains unissued; its limit is eight output tokens with
stable idempotency and no retry.

See [sanitized global census](route-approval-proof-2026-09-07.json).
