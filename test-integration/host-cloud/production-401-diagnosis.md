# Live project-key 401 diagnosis — 2026-09-07

## Post-sync result — supersedes the original mismatch

The primary task reports a bounded production update: only identity's
`service-key-hash-pepper` was copied into `multivibe-cloud-api-runtime`, guarded
by UID/resourceVersion tests and automatic rollback, followed by an API-only
restart. API revision **50** is ready with **2/2** replicas.

Its audit at **2026-09-07T20:32:08Z** found all six API/identity/billing pods ready
in one pepper group, the same API/identity database, exactly two active keys,
no associated entitlement/balance rows, and `driftGatePassed=true`.
A fresh `/v1/models` request with the user key still returned **401**, as reported
by the primary task. This documentation task did not obtain or replay that key.
The remaining shadow verifier entitlement/balance/lease barrier is therefore
consistent with the post-sync request; pepper drift is no longer the live blocker.
Lease absence itself was not separately established.

All three activation flags remain false. No billing, entitlement, balance, lease
or inference activation is authorized by this update. Alignment success does
not establish authenticated Host catalog access or enrollment persistence.
See [post-sync evidence](production-post-sync-2026-09-07.json).

## Original pre-sync observations (historical)

At approximately 20:20 UTC, read-only Kubernetes and PostgreSQL probes established:

- API deployment revision **49** and identity revision **63** both declare source
  `5c1fbd240c0802e7232eedf6979915b423d2703a` and run image
  `ghcr.io/pleiades-solutions/multivibe-cloud@sha256:68a67a81d6d00e02837ab493cec9dace22a814e24ad44f6b99ce8d4c9b87231a`.
  Source is the deployment annotation; the digest was independently observed in
  pod container status. Remote OCI-label inspection was denied by registry scope,
  so no independent image-to-source attestation is claimed.
- All six relevant pods were ready. The two API pods agree on their pepper;
  the two identity and two billing pods agree on another pepper. **These two
  groups differ.** Raw peppers and comparison digests were not displayed.
- API and identity connect to the same live PostgreSQL database, as checked by
  ephemeral keyed comparisons of server/database identity, without showing URLs.
- The five-row bounded query returned two keys, prefixes `mvk_YkAFrHEv` and
  `mvk_ev1lOR8y`. Both have a persisted creation event, scopes `models:read` and
  `responses:write`, future expiry on 2026-12-06, and no revocation.
- Neither associated project has any `entitlement_versions` or
  `entitlement_balances` row.
- The sampled API runtime has `MANAGED_LIVE_INFERENCE_ENABLED=false`,
  `MONETARY_EFFECTS_ENABLED=false` and `MARKETPLACE_ROUTING_ENABLED=false`.
- Ingress routes API traffic to `multivibe-cloud-api`, and dashboard/identity
  traffic to `multivibe-cloud-identity`, with separate billing path routing.

The user requested proceeding without the tested key or its specific prefix.
Therefore these findings cover the observed recent keys and deployment state;
**the exact user key was not matched or independently replayed**. Its reported
HTTP 401 is user-provided evidence, not a fresh request executed by this audit.

## Original two-barrier diagnosis (first barrier now resolved)

The deployed source has two independent barriers:

1. `ProjectApiKeyService.create` persists `serviceKeyDigest(token, pepper)` in
   `service_keys.key_digest`; `serviceKeyDigest` is HMAC-SHA256. Identity takes
   the pepper from `multivibe-cloud-identity-runtime/service-key-hash-pepper`.
   API authentication takes its pepper from
   `multivibe-cloud-api-runtime/service-key-hash-pepper`. The observed mismatch
   makes a currently issued identity key's API-side digest differ.
2. With live inference disabled, `server-safe.ts` does not instantiate the
   universal gateway/project-only verifier. `/v1/models` falls back to
   `PostgresStore.authenticateServiceKey`, whose inner joins require a current
   entitlement, balance and regional lease. The observed projects have no
   entitlement or balance at all. The fallback maps an absent joined result to
   `401 invalid_api_key`, even if the token's digest were aligned.

Thus **aligning peppers alone is insufficient**. Expiry, revocation and missing
key-creation persistence are not the problem for the two observed keys. The
historical source of the divergent secret values is not established by this audit.

## Concrete repair sequence and rollback boundary

The original audit made no production mutation. The primary task subsequently
completed the bounded field synchronization and API restart described above.
The following sequence records the original repair boundaries; steps 1–2 are
completed, and steps 3–4 are not authorization to activate services.

1. The secret owner must choose the canonical **existing** service-key pepper
   used for dashboard-issued keys and synchronize the API runtime's designated
   field through the approved provisioning process. Preserve the prior value in
   the operator's secret system for rollback; never put it in this repository.
   Check existing key populations before a change because unknown keys issued
   under another pepper could be invalidated. Do not solve this by referencing
   the whole identity runtime Secret from the inference Deployment: the checked-in
   admission contract explicitly pins API env references to its own runtime Secret
   (`production-admission-policies.yaml`, API env contract).
2. Roll out only the API deployment after secret alignment, retain the recorded
   image/revision, and rerun the equality audit on **all** replicas. A Deployment
   rollback alone cannot restore an overwritten pepper: restore its previous
   secret version as part of the same controlled rollback, then restart the API.
3. Resolve the intended operating mode. The current profile is shadow, not live
   managed inference. Enabling real inference and monetary effects requires the
   product's existing provider/billing/project-budget readiness evidence. The
   deployment must not synthesize shadow grants merely to make this test pass.
   If the product should expose a project-authenticated catalog while live
   inference is disabled, that is a separate explicit API contract change; it
   must not enable dispatch or claim a funded allowance.
4. Once the intended profile is active and an already issued test key is usable,
   run existing-key configuration, authenticate both catalogs, restart the local
   Host and repeat catalog verification. Only then run the explicit minimal
   inference with a reviewed model and existing budget. OAuth enrollment is a
   separate proof from project-key authentication.

A blind secret edit or activation of live billing would not be a complete or
reversible fix for the two observed barriers. No live billing or inference activation was performed. The bounded pepper
update is recorded separately above.

## Reproduce the read-only evidence

```sh
python3 test-integration/host-cloud/audit-production.py --require-aligned
python3 -m unittest discover -s test-integration/host-cloud -p 'test_audit_production.py'
```

The audit uses the current Kubernetes context and namespace `multivibe-cloud`.
It uses no raw API key; executes only environment comparisons and bounded SELECTs
with `default_transaction_read_only=on` and a five-second statement timeout;
never runs a Kubernetes write, inference or billing action. It uses a fresh random
HMAC challenge for each run and prints workload equivalence groups, never hashes.
Exit 1 means the alignment/readiness gate failed (including missing or unready
replicas); exit 2 means the audit could not finish.

The sanitized [runtime evidence](production-audit-2026-09-07.json) records the
snapshot, deployment digests, pod names and allowed public key prefixes. It contains
no raw key, cookie, DB URL, pepper, token, prompt, answer or application log.

**Remaining live proof:** resolve the catalog authentication contract for the
current disabled-live profile without granting financial capabilities. Host Cloud
authentication, Cloud enrollment persistence and real inference remain unverified.
No further pepper synchronization is pending on the observed deployment.
