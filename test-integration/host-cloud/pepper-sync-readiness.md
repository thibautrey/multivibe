# Pepper synchronization readiness — 2026-09-07

This is the historical pre-sync readiness inspection. Its statement that no
patch or rollout had occurred was true at inspection time and is superseded by
the [post-sync diagnosis](production-401-diagnosis.md): the primary task performed
the bounded one-field sync and API-only rollout, with UID/resourceVersion tests
and automatic rollback. Revision 50 is ready and the 20:32:08Z audit passed.
This documentation update makes no production changes.

## Permissions and provisioning

The current Kubernetes identity is `kubernetes-admin` (`system:masters`).
`kubectl auth can-i patch secret/multivibe-cloud-api-runtime -n multivibe-cloud`
and the corresponding `update` check both returned `yes`.
The same patch check with impersonation for the production identity and runtime
secret-provisioner service accounts returned `no`.

The inspected identity, managed-runtime and catalog provisioning workflows
explicitly exclude the API runtime Secret. Billing/provider-cash provisioning
uses `SERVICE_KEY_HASH_PEPPER` for its own Secrets, not a one-field API sync.
No existing approved workflow for the requested synchronization was found.
Workflow files agree between Cloud local `85c5549` and remote main
`157f05a3b8067646c74d60d618bce0bcfb38fce8`.

Live admission inventory differs from source policy documents. The live
`multivibe-production-network-boundary` policy covers Secrets and has a Deny
binding for the Cloud namespace, but its match condition does not select this
API Secret under the observed administrator identity. This is static readiness
evidence, not an admission success test or permission to bypass provisioners.
No server-side mutation/dry run was attempted; RBAC alone cannot guarantee that
an eventual request will pass every admission control.

## Compatibility and rollback evidence

A read-only exhaustive aggregate over `service_keys` found exactly two rows,
both active, neither predating identity rollout at `2026-09-07T18:28:39Z`, and
neither missing its creation event. The user confirmed that their tested public
prefix matches a recent active row. Six runtime replicas confirmed API pepper
agreement within API and a different shared identity/billing pepper.

This supports preserving the identity/billing value: no older persisted key was
found in the inspected database at the time of the census. It is not a
cryptographic verification using the raw key, nor protection against concurrent
issuance, a future rotation, or another database. Recheck population and source
versions immediately before an approved change.

At the time of this readiness inspection, a protected previous-value rollback
had not been established. Deployment
rollback alone does not restore a mutated Secret. The canonical source ownership
and a suitable narrow provisioning path still needed operator approval at that
time. The primary task subsequently reports automatic rollback protection;
this documentation task has not independently exercised rollback.

## Original proposed production action — subsequently completed

After the secret owner approves the canonical identity/billing source and a
protected rollback, synchronize only `service-key-hash-pepper` in
`multivibe-cloud-api-runtime`, with source/target version fences. Preserve all
other fields and activation flags, then restart only API through the approved
rollout path and repeat the complete replica audit. This readiness inspection itself included no production write. The primary
task subsequently completed the sync and rollout; do not repeat them based on
this historical proposal.

Pepper agreement alone is insufficient for successful catalog authentication:
the current shadow verifier also requires entitlement/balance/lease joins, and
these projects have no entitlement or balance rows. Do not enable
`MANAGED_LIVE_INFERENCE_ENABLED`, monetary effects, billing, entitlements,
balances, leases or spending to work around that barrier. Host authentication,
catalog, persistence after authenticated configuration and real inference remain
unverified. See the prior production diagnosis for source evidence.

The local audit improvements detect drift and incomplete replica coverage; they
do not make drift impossible. Enforced prevention requires a separately reviewed
canonical provisioning design.
