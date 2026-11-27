# Hermes remote capacity: fair share, session grace, and the client bridge

This document is the contract behind the operator promise: a customer's own
Hermes keeps running unchanged, is served by the shared edge pool when it has
room, and is served by their own Nous Research account when it does not — without
the customer needing to know which happened.

## Why the limits are shaped this way

Three facts drive the design:

1. **Cloudflare closes an idle proxied response after 100 seconds** (524). An
   inline wait long enough to matter cannot be held at all, so waiting belongs to
   the client, not to the request.
2. **Prefill is the expensive part of a conversation.** A turn that is already
   running has mostly paid that cost. Refusing it mid-conversation wastes work
   that has already been done.
3. **A shared machine still has to stay fair.** Any grace that can grow without
   a ceiling becomes a bypass: a client that farms session identifiers would
   take the whole account.

Hence the invariants:

> **Grace lends capacity from a pool it cannot exceed.** The pool is a fraction
> of the account's slots (25 % by default), counted in **slots, not sessions**:
> a conversation holding three turns has borrowed three slots.
>
> **Grace never exceeds physical capacity**, and **never takes a slot another
> tenant was promised** — the pool is deducted from the account, so the other
> tenant's share is still there when it asks.

So a session may hold its application's fair share *plus* a slice of the pool,
never more. A client farming `session_id` gains at most the pool, whatever it
does.

This was wrong once, and the tests did not notice: the pool was counted from the
registry's tally of known sessions, and one session never becomes two, so the cap
could not bind. A single graced conversation took 8 of 8 slots and every other
tenant was refused. `one_graced_session_cannot_eat_the_whole_account` is the
regression test.

## The four layers

Applied in order. Each layer only narrows the previous one.

| Layer | Limit | Where |
| --- | --- | --- |
| 1. Physical capacity | **measured** from `capacityProfile.metricsUrl` when present, else the declared `maxConcurrent`, else 32 for `cloud` and 1 for `local` | `capacity::CapacityRegistry` |
| 2. Fair share per application | `applicationPolicies[].maxConcurrentShare` (default `0.25`, floor 1 slot) plus `burst` (default `1`, only on an idle account) | `POST /v1/admission`, `proxy_inference` |
| 3. Session grace | Bound to `(application, session_id)`; requires ≥128 decoded tokens; TTL 20 min idle, 2 h absolute; borrowed slots capped at 25 % of the account, on top of the fair share | `admission::GraceRegistry` + `grace_slots_held` |
| 4. Calendar | Share multiplied by 2 between 20:00 and 08:00 Europe/Paris and all weekend | `applicationPolicies[].shareWindows` |

### Phase 0 exists on purpose

Turning the policy off answers "what happens without limits". It does not answer
"what would the limits do to *this* traffic", because with it off no decision is
computed. `ADMISSION_SHADOW=true` evaluates the full policy against every real
request while admitting exactly as before, and `evaluate_with_capacity` takes no
slot and touches no counter, so the numbers an operator reads are not perturbed by
the measurement itself.

Shadow does not trip the replica guard: it enforces nothing, so the N-times
argument does not apply.

### Measured capacity

A declared `maxConcurrent` cannot know that a runtime loaded a second model, that
a GPU is throttling, or that an operator halved the batch size. When an account
carries `metricsUrl`, the edge polls it every 30 s and the observation **replaces**
the declaration:

| Rule | Why |
| --- | --- |
| A drop takes effect at once | Over-admitting is the expensive mistake |
| A rise needs 5 minutes below 60 % load | One idle sample must not widen the gate and start an oscillation |
| A failed or timed-out probe changes nothing | Silence is not evidence of capacity |
| A stale observation keeps its ceiling | Regressing to a wider declaration during an incident is the dangerous direction |
| A busier runtime never ramps up | A runtime that is always busy is already saturated |

`/v1/capacity` reports `capacitySource` as `declared`, `measured`, or
`measured_stale`, so an operator can tell how the number was obtained rather than
assuming.

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
conversation is never dropped, it simply stops borrowing the remaining slots.
The report distinguishes the two states, because "granted" alone is ambiguous:

- `grace: granted` — this conversation holds grace;
- `graceKeepsPriority: true` — and it may still borrow past its share.

Past the threshold the first stays `granted` while the second turns `false`: the
conversation keeps its place in the queue and loses the ability to take the last
free slot, which is what would keep a new conversation from starting at all.

## Interfaces

### `POST /v1/admission`

```json
{ "model": "nousresearch/hermes-4-405b", "session": "conv-42", "switch_ok": true }
```

Returns `decision` ∈ `admit | queue | switch`, the lease when admitted, `waitMs`,
`position` (callers ahead on these accounts; 0 when admitted), `grace`,
`graceActive` / `graceSlots` (borrowed slots against the pool), `graceKeepsPriority`,
and the share arithmetic that produced the answer. The request never
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

## Onboarding a client

Three operator steps, in this order.

**1. Issue the code.** One application per client machine, so revocation and
usage attribution are per-machine:

```
curl -sS -X POST "$EDGE/admin/hermes-bridge/enrollment" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"application":"hermes-<client>","mappings":[
        {"from":"<their LLM_MODEL>","edge":"<model we serve>","nous":"<same as from>"}]}'
```

The response carries `code` once. Put it nowhere but the prompt: it is spent on
first use and useless afterwards.

**2. Render the prompt.** Never fill the placeholders by hand — a single-use code
is easy to paste into the wrong slot, and the Access secret must never travel in
the document:

```
npm run hermes:enrollment-prompt -- \
  --code mvenr_... --edge https://host.example.invalid \
  --model <their LLM_MODEL> --access-id <client id> \
  --access-secret-path /home/<client>/.mv-access-secret \
  --out prompt-<client>.md
```

The script refuses to emit a document that still contains a placeholder, refuses
a half-supplied Access pair, and accepts only a **path** for the secret. `--out`
writes `0600` because the file holds a live code.

The Nous side of the mapping is derived at enrollment from Nous's public
catalogue, so `"nous"` above may repeat `"from"`; only a name Nous actually lists
is stored, otherwise no fallback is recorded and `doctor` says so.

**3. Send the prompt** to whoever runs that machine. They run `enroll`, then
`install-hermes-bridge.sh`, then point Hermes at `http://127.0.0.1:8787/v1`.

### Offboarding

Deleting the key alone is not enough: the application policy holds a share
reservation. Remove both.

```
curl -sS -X DELETE "$EDGE/admin/proxy-api-keys/<id>"        -H "authorization: Bearer $ADMIN_TOKEN"
curl -sS -X DELETE "$EDGE/admin/application-policies/<app>" -H "authorization: Bearer $ADMIN_TOKEN"
```

Then revoke that machine's Cloudflare Access service token in the dashboard.
Until the token is revoked, the machine still passes the gate — it just has no
key to present to the edge.

### What must be true before a client can enrol

- A published Host release containing `bin/multivibe-hermes-bridge`: releases
  before `v0.2.147` predate the bridge, and an archive without it cannot be made
  to work by configuration.
- One Access **service token per machine**, with a *Service Auth* policy on the
  hostname. A `302` to `<team>.cloudflareaccess.com` means Access saw no
  credential; it does not mean tokens are impossible there.

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
6. **A capacity reading is reused for 15 s, and invalidated by the edge's
   event stream.** Probing on every turn costs a round
   trip on the path the customer is waiting on. The reading is only a hint for
   whether probing is worth it: a stale "plenty free" still meets a real `429`,
   which falls back, so caching can make a turn one request slower but not wrong.
   A failed probe is **not** cached — a credential refusal or a timeout is a fault
   to notice promptly, not a state to bake in.
   The bridge also subscribes to `/v1/capacity/events` and drops the cached
   reading on `capacity.changed` / `admission.changed`, so it does not act on a
   reading the edge has already declared obsolete. The subscription is best
   effort: a stream that never connects, or dies and retries, changes nothing
   about correctness because the TTL still governs. It retries with backoff on
   an unref'd timer and is closed with the server, so it can never hold shutdown
   open.
7. **Both upstarts speak the same dialect, and the bridge does not translate.**
   The plan allows normalising `tool_calls` and `finish_reason` "between the two
   upstreams". They were compared, not assumed: the edge already emits the same
   `chat.completion[.chunk]` shape with `finish_reason: "tool_calls"`, and Nous
   serves the same OpenAI dialect. Rewriting the stream against a difference that
   does not exist would risk corrupting the one thing that must survive a
   fallback — a tool call crossing the boundary intact — so the bridge relays
   bytes and a test pins that a streamed `tool_calls` sequence, `[DONE]`
   included, comes out identical. If a real divergence appears, `doctor` fails on
   the mapping before it fails in a conversation.
8. **A saturated edge is a reason to fall back, not to fail.** `429` and `503`
   from the edge — the shared pool busy, or no slot at all — are retried on Nous
   before any byte reaches the harness. A `400` is not: retrying a malformed
   request against a second provider would double the failure and hide its cause.

## Rollout

| Phase | What ships | Gate |
| --- | --- | --- |
| 0. Shadow | `ADMISSION_SHADOW=true`: every decision is computed and counted, nothing is enforced | The counters match what you expect before any request is refused |
| 1. Fair share + leases | `ADMISSION_POLICY_ENABLED=true`, no grace | No starvation between tenants |
| 2. Grace | Grace enabled for one pilot client | `grace_denied_by_cap` low |
| 3. Bridge | General availability | `counters.http524` stays zero on every enrolled machine |

`GET /admin/admission/metrics` serves the same counters in Prometheus text
format, so an operator can alert on them instead of reading JSON by eye. It
requires the admin token: these numbers describe one tenant's load.

| Metric | Where | What it tells you |
| --- | --- | --- |
| `admission_decision_total{reason}` | edge `/admin/admission/metrics` | How often work is refused, **and by which layer**: `share_available`, `grace`, `share_exhausted`, `account_saturated`, `grace_pool_full`, `switch_requested` |
| `admission_inline_wait_p99_ms` | same | The wait tail over recent samples, not a permanent record of the worst one. Absent, never `0`, until something has been sampled |
| `queue_wait_p99_ms` | same | Real time spent blocked for a slot, which is what the caller felt — the estimate can be wrong, the wait cannot |
| `grace_active` | same | Grace-borrowed **slots** in use, against `grace_slots` |
| `grace_denied_by_cap` | same | Eligible sessions the 25 % grace pool turned away |
| `counters.switched` | bridge `/health` (JSON) | Turns served by Nous because the edge could not serve them, including inline fallbacks |
| `counters.blockedNoMapping` | bridge `/health` (JSON) | A client asked for a model the fallback cannot serve |
| `counters.http524` | bridge `/health` (JSON) | Cloudflare cut a request off. Only the bridge can see this: Cloudflare answers `524` itself and the edge never sees it |
| `counters.turns` | bridge `/health` (JSON) | Total served turns, so the switch ratio is `switched / turns` |

The bridge exposes JSON, not Prometheus: it is one process per customer machine,
scraped by the operator only when diagnosing, so a text exposition format would
be ceremony without a consumer.

`grace_denied_by_cap` staying high means the grace pool is too small;
`blockedNoMapping` above zero means the promise cannot be kept for that model and
the mapping table needs a real equivalent; any non-zero `http524` means a request
waited past Cloudflare's 100-second budget, which no amount of queueing fixes.

## Known constraints

A runtime exposes no metrics endpoint yet: `metricsUrl` is a contract the
deployment must satisfy. Until the Spark `strata` runtime publishes
`{maxConcurrent, inFlight, prefillTokensPerSecond, decodeTokensPerSecond}`, the
declared value stays in force and `capacitySource` honestly reports `declared`.
The edge side is complete; the missing half is the runtime's.

`AdmissionController` counts in memory, so every limit above is **per process**.
With N replicas the effective capacity becomes N times the declared value and the
fair share is silently false.

This is now enforced rather than documented: setting `ADMISSION_POLICY_ENABLED`
with `EDGE_REPLICAS > 1` makes the edge refuse to start, naming the reason. An
operator who has not enabled the policy may run any number of replicas, because
nothing is being claimed.

`/v1/capacity` reports `replicas` alongside `policyEnabled`, so a reviewer sees
the scope of the numbers rather than assuming it.

Before scaling out with the policy on, admission must move to a shared store.
