# Existing Cloud access investigation — 2026-09-07

## Metadata and local state actually inspected

No secret value was printed or sent to Cloud during this investigation.

- `openbao-kv keys codex-remote/multivibe`: field `API_KEY` only.
- `openbao-kv keys codex-remote/multivibe/matomo`: field `token_auth` only.
- Metadata searches for `multivibe`, `cloud`, `e2e`, `PROJECT_API_KEY`,
  `CUSTOMER_IDENTITY`, `CONTROL_PLANE`, `DASHBOARD`, `SESSION`, `OAUTH`,
  `IDENTITY`, `test`, `multicodex` and `proxy` found no clearly identified
  Cloud test project key, Cloud test OAuth session or test operator credential.
- Codex's local `litellm` provider uses environment field `MULTIVIBE_API_KEY`
  with an HTTP origin on the private network (`192.168.1.149`), not the public
  `api.multivibe.cloud` origin. Metadata does not establish that the OpenBao
  `API_KEY` has Cloud scope, and its value was not used to guess that scope.
- Local environment names contained `MULTIVIBE_API_KEY`, but no dedicated
  `MULTIVIBE_CLOUD_TEST_API_KEY` or `MULTIVIBE_E2E_PROJECT_API_KEY`.
- No actual `.env` credentials were present in the two repository roots; the
  Cloud `.env.example` contains configuration field names, not a provisioned
  test identity.
- Standard Host and repository account-store locations were absent. The isolated
  lab's account store exists, with no Cloud account or Cloud OAuth session.

The generic gateway key and analytics token were not substituted for the requested
Cloud test identity. This is **no identified suitable credential**, not proof
that no such credential exists anywhere outside the inspected scope.

## Official mechanisms in the sibling Cloud repository

Reviewed actual sources under `/home/codex/gitRepo/multivibe-cloud`:

1. `docs/customer-identity-test-corridor.md` documents operator invitations and
   email-possession verification, requiring an operator token, dedicated session
   peppers, Plunk delivery and Stripe test configuration. Its session grants only
   `billing:read` and `billing:write`; it does not issue an inference key or credits.
2. `docs/subscription-managed-access-test-corridor.md` requires the first corridor
   plus reconciled Stripe test evidence. It grants short-lived access only to
   approved synthetic managed routes, not real customer inference.
3. Both flags are `false` in `deploy/kubernetes/base/configmap.yaml` and the
   checked-in cloud-only identity overlay. This is checked-in configuration,
   not a readout of deployed feature flags.
4. `scripts/bootstrap-shadow.ts` directly writes a shadow organization/project,
   key and synthetic entitlement through PostgreSQL. It is not an existing-account
   login mechanism and was not run as an alternative to the refused UI creation.
5. `scripts/verify-managed-provider-e2e.ts` is an official live verification path,
   but requires a **previously issued** project API key, project ID, real paid
   Stripe invoice/event and a database connection. It verifies accounting evidence
   and cannot provision the missing identity. `docs/managed-mistral-launch.md`
   describes those requirements and the existing hard project budget prerequisite.

No operator invitation, bootstrap, key issuance, production flag change, direct
DB mutation, purchase or workaround for the earlier UI refusal was executed.

## Current measured result and remaining dependency

At 19:53 UTC, the installed Host returned health 200 and authenticated local Cloud
status 200; anonymous admin access returned 401. Its Cloud status was still
`disconnected`, with zero persisted Cloud accounts. The strict live check exited 1.

The new existing-access command was tested without a Cloud key: it exited 1 with
`MULTIVIBE_CLOUD_TEST_API_KEY is required; no lab state changed`. Four unit tests
passed for credential separation, redirect refusal, error redaction and inference
idempotency propagation. These are helper checks, not real Cloud success.

**Remaining dependency:** an already provisioned Cloud test project key with
`models:read` and `responses:write`, and an existing allowance/budget suitable for
one small generation. It must be identified in OpenBao by the operator, rather
than pasted into a chat. That would allow public API-key authentication, catalog,
restart persistence and inference verification without account creation. A full
OAuth signup/enrollment proof would remain a distinct requirement.
