# Hermes remote capacity: fair share, session grace, and the client bridge

This document is the contract behind the operator promise: a customer's own
Hermes keeps running unchanged, is served by our machines when they have room,
and is served by their own Nous Research account when they do not — without the
customer needing to know which happened.

## Why the limits are shaped this way

Three facts drive the design:

1. **Cloudflare closes an idle proxied response after 100 seconds** (524). An
   inline wait long enough to matter cannot be held at all, so waiting belongs to
   the client, not to the request.
2. **Prefill is the expensive part of a conversation.** A turn that is already
   running has mostly paid that cost. Refusing it mid-conversation wastes work
   that has already been done.
3. **A shared machine still has to stay fair.** Any grace that can exceed a
   tenant's fair share becomes a bypass: a client that farms session identifiers
   would take the whole account.

Hence the invariant:

> **Session grace never grants capacity beyond the application's fair share. It
> only decides who waits inside that share.**

## The four layers

Applied in order. Each layer only narrows the previous one.

| Layer | Limit | Where |
| --- | --- | --- |
| 1. Physical capacity | `capacityProfile.maxConcurrent`, else 32 for `cloud` and 1 for `local` | `account_max_concurrent` |
| 2. Fair share per application | `applicationPolicies[].maxConcurrentShare` (default `0.25`, floor 1 slot) plus `burst` (default `1`, only on an idle account) | `POST /v1/admission`, `proxy_inference` |
| 3. Session grace | Bound to `(application, session_id)`; requires ≥128 decoded tokens; TTL 20 min idle, 2 h absolute; at most 25 % of an account's slots | `admission::GraceRegistry` |
| 4. Calendar | Share multiplied by 2 between 20:00 and 08:00 Europe/Paris and all weekend | `applicationPolicies[].shareWindows` |

### Why not `batch` priority

`batch` defers work to the 22:00–07:00 Europe/Paris window. A remote customer on
`batch` would receive **no service at all** on a weekday afternoon, which is not
what "slower during the week" promises. Remote clients are therefore `standard`
with a small fair share and a calendar multiplier, so the wait is real but the
service always exists.

### Grace eligibility

A session earns grace only by completing a turn that produced output. Two
consequences, both intentional:

- A cold first turn never claims grace, so a new client cannot jump the queue by
  opening a conversation during a spike.
- The account must have been under 60 % utilisation when the session was first
  admitted. A conversation that *started* during a spike is not "already
  running" in the sense the promise means.

Above 85 % utilisation grace degrades to an ordinary queue position: the
conversation is never dropped, it simply stops outranking newcomers.

## Interfaces

### `POST /v1/admission`

```json
{ "model": "nousresearch/hermes-4-405b", "session": "conv-42", "switch_ok": true }
```

Returns `decision` ∈ `admit | queue | switch`, the lease when admitted, `waitMs`,
`grace`, and the share arithmetic that produced the answer. The request never
blocks for more than [`INLINE_MAX_WAIT_MS`] (55 s) because the wait is reported
rather than held.

### `GET /v1/admission/{lease}`

Reads a lease, or renews it with `?renew=1`. Lease TTL is 90 s with at most three
renewals, so a client cannot reserve a slot indefinitely.

### Inference

`x-multivibe-lease: adml_...` redeems a lease exactly once. The response carries
`x-multivibe-grace`, `x-multivibe-admission` and, when queued,
`x-multivibe-queue-position`. `/v1/capacity` additionally reports `shareLimit`,
`shareUsed`, `accountActive`, `graceSlots`, `graceActive` and `estimatedWaitMs`.

### `POST /admin/hermes-bridge/enrollment`

Operator-only. Issues a single-use `mvenr_...` code bound to an application name,
a fair-share policy, and the model mapping table. The code is returned once; it
cannot be read back.

### `POST /hermes-bridge/enrollment/exchange`

Unauthenticated — the code *is* the credential, which is why it is single-use,
bound to one application, and expiring. Returns the per-machine key once. A
replay answers `410 used_enrollment_code`, never a fresh key. Expired codes stay
reportable for seven days so the operator learns *why* it failed rather than
seeing "unknown code".

Codes live in memory only: an edge restart invalidates outstanding codes, which
is the safe direction.

### `GET /admin/admission/state`

Read-only operator view of the policy and content-free counters. It never returns
a session identifier or a prompt.

### `x-multivibe-max-wait-ms`

Clamped to 55 s. Values above that are accepted and silently reduced rather than
rejected, so a client written against the old 24 h budget still works.

## Client bridge

`multivibe-hermes-bridge` is a loopback-only OpenAI-compatible proxy. The harness
keeps its tools, memory, skills and configuration; only `OPENAI_BASE_URL` and
`OPENAI_API_KEY` change.

Routing rules, in priority order:

1. **One decision per turn, before the first token.** After a byte reaches the
   harness the choice is frozen — replaying to a second provider would run tools
   twice and duplicate output.
2. **Never worse than today.** An unreachable, slow, or refusing edge falls back
   to Nous Research using the customer's own key.
3. **No silent downgrade.** A switch happens only when a same-class model exists
   on both sides. Missing mapping means the turn fails explicitly rather than
   being served by a different model.
4. **Sticky for 10 minutes.** A switched conversation stays on Nous, protecting
   the prompt cache on both sides and avoiding flapping.
5. **The Nous key never leaves the machine.** All fallback traffic goes directly
   from the customer's host; nothing is proxied through us or billed by us.

## Rollout

| Phase | What ships | Gate |
| --- | --- | --- |
| 0. Shadow | Decisions are computed and logged, no effect | Counters match expectations |
| 1. Fair share + leases | `ADMISSION_POLICY_ENABLED=true`, no grace | No starvation between tenants |
| 2. Grace | Grace enabled for one pilot client | `grace.deniedByCap` low |
| 3. Bridge | General availability | `http.524.count` stays zero |

Metrics to watch: `admission.decision{reason}`, `grace.active`,
`grace.deniedByCap`, `switch.count`, `switch.blockedNoMapping`,
`inlineWaitMsMean`, and `queue.wait`. A sustained `grace.deniedByCap` means the
25 % pool is too small; a non-zero 524 count means an inline wait escaped the
clamp.

## Known constraint

`AdmissionController` counts in memory. **This is only correct for a
single-process edge.** With N replicas the effective capacity becomes N× the
declared value and every limit above is wrong. Before running more than one
replica, admission must move to a shared store; until then the deployment must
keep a single edge process.
