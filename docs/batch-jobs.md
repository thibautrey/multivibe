# Integrating deferred batch jobs

MultiVibe accepts a non-streaming inference request, persists it as a durable
job, and executes it later when its priority, batch window and local admission
allow. This is intended for translations, catalog enrichment, indexing,
reporting, and other work whose result does not have to be returned by the
original HTTP request.

This guide describes the native Rust edge used by the shipped split-process
profile. For server-side aliases, see the smart alias section in the main
[README](../README.md#-routing-strategy).

## Key behavior

- A deferred request returns `202 Accepted` with a `multivibe.job` object.
- Batch jobs submitted outside the execution window become eligible at 22:00
  `Europe/Paris`; the window lasts until 07:00 and follows daylight-saving
  changes. Eligibility is checked again before every attempt, including after
  a retry or restart.
- Jobs survive MultiVibe restarts and are isolated by application API key.
- Scheduling is weighted across priorities (`critical`, `interactive`,
  `standard`, `batch`) and then across applications of the selected
  priority.
- A running job recovered after a process stop may execute again. Result
  handling and external side effects must therefore be idempotent.
- Transient failures are attempted up to three times by default.
- Streaming Responses, streaming Chat Completions, WebSocket, Realtime and
  confidential requests cannot be deferred.

Examples use `multivibe-batch`, a deployment-level smart alias. The
deployment must configure it with an admissible local or cloud candidate.

## Recommended request flow

1. Generate a stable idempotency key for the business operation.
2. Submit a non-streaming request with explicit `batch` and `defer`
   headers.
3. Persist the returned MultiVibe job ID next to the business record.
4. Poll the durable job resource until it reaches a terminal state.
5. Fetch the result when the job is `succeeded`.
6. Apply it idempotently and mark the local operation complete.

A restart should resume monitoring the recorded job ID instead of submitting
unrelated work.

## Submit a job

Responses, Chat Completions, and Anthropic Messages routes accept deferred
non-streaming requests:

```bash
curl -X POST "$MULTIVIBE_BASE_URL/v1/responses" \
  -H "Authorization: Bearer $MULTIVIBE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-MultiVibe-Priority: batch" \
  -H "X-MultiVibe-Execution: defer" \
  -H "X-MultiVibe-Idempotency-Key: translation:product-42:fr:v3" \
  -H "X-MultiVibe-Deadline: 2026-09-09T07:00:00+02:00" \
  -d '{
    "model": "multivibe-batch",
    "input": "Translate the supplied product description into French."
  }'
```

Always send `X-MultiVibe-Priority: batch` and
`X-MultiVibe-Execution: defer` when also sending an idempotency key,
deadline, maximum wait, or webhook header. The presence of a routing header
makes the request explicit, so alias defaults are not filled into other
missing routing fields.

The deadline is optional and must be an unexpired RFC 3339 timestamp. A queued
or running job that reaches it becomes `expired`. Choose a deadline after the
next batch window if the job must have an opportunity to run; the API validates
the timestamp and expiry, not the amount of useful time remaining.

A new submission returns headers including:

```text
HTTP/1.1 202 Accepted
X-MultiVibe-Decision: queued
X-MultiVibe-Priority: batch
X-MultiVibe-Idempotency-Status: created
Location: /v1/jobs/job_68f0b7c0...
```

The body is a job resource. Public timestamps are ISO 8601 UTC strings:

```json
{
  "object": "multivibe.job",
  "id": "job_68f0b7c0...",
  "status": "queued",
  "priority": "batch",
  "model": "multivibe-batch",
  "attempts": 0,
  "max_attempts": 3,
  "created_at": "2026-09-07T12:00:00.000Z",
  "updated_at": "2026-09-07T12:00:00.000Z",
  "not_before": "2026-09-07T20:00:00.000Z",
  "deadline": "2026-09-09T05:00:00.000Z",
  "result_url": "/v1/jobs/job_68f0b7c0.../result",
  "events_url": "/v1/jobs/job_68f0b7c0.../events",
  "error": null
}
```

## Idempotent submission

`X-MultiVibe-Idempotency-Key` is scoped to the authenticated application and
may contain at most 200 characters. Repeating the same route and JSON body
with the same key returns the original job and
`X-MultiVibe-Idempotency-Status: replayed`.

Reusing the key for another route or JSON body returns
`409 idempotency_key_reused`. Use a deterministic value derived from the
business entity, operation, locale or variant, and source revision:

```text
translation:<product-id>:<locale>:<source-revision>
```

Do not include secrets or personal data in the key because it can appear in
operational metadata.

## Observe job state

List the current application's jobs:

```http
GET /v1/jobs?limit=100
```

`limit` is clamped to 1–1000. Fetch one job with:

```http
GET /v1/jobs/:id
```

Both endpoints require the application API key that submitted the job. A job
owned by another application is returned as `404`.

| Status | Meaning | Application action |
| --- | --- | --- |
| `queued` | Waiting for its window or a worker | Keep polling |
| `running` | Executing in a Rust worker | Keep polling; do not resubmit |
| `retry` | A transient attempt failed | Keep polling |
| `succeeded` | Result is available | Fetch `/result` |
| `failed` | Attempts are exhausted or the error is permanent | Record failure |
| `cancelled` | Cancellation was accepted | Stop monitoring |
| `expired` | Deadline or content-retention limit was reached | Decide whether to submit a new key |

Start polling around two seconds and back off to 30–60 seconds with jitter.
Network failures and `5xx` responses from the status endpoint should retry
the status check, never the inference submission.

## Receive progress with SSE

```http
GET /v1/jobs/:id/events
Accept: text/event-stream
```

Events include `job.queued`, `job.started`, `job.capacity_wait`, `job.retry`,
`job.succeeded`, `job.failed`, `job.cancelled`, and `job.expired`, plus webhook
delivery events. Each event has an integer SSE ID. Save the latest ID and
reconnect with:

```http
Last-Event-ID: <last-seen-id>
```

The native store retains up to 1,000 events per job and replays entries newer
than the supplied ID. The live stream sends a heartbeat comment every 15
seconds and recovers a lagged in-memory subscriber from persisted history.
Polling `GET /v1/jobs/:id` remains the authoritative status check after a
long disconnection or an event-history truncation.

## Retrieve a result

After `succeeded`:

```http
GET /v1/jobs/:id/result
```

- `200`: returns the stored inference result and marks it consumed;
- `409`: the job is not ready;
- `410`: the job is `failed`, `cancelled`, or `expired`;
- `404`: no job is visible to this application.

Relevant upstream request IDs and the content type are restored when present.
Store and apply the result transactionally where possible. A crash after the
fetch but before the application's commit must be safe to recover.

## Cancel a job

```http
DELETE /v1/jobs/:id
```

- `204`: cancellation was accepted;
- `409`: the job can no longer be cancelled;
- `404`: the job is absent or belongs to another application.

Cancellation of a running job prevents its result from replacing the terminal
state, but an already-sent provider request can still finish externally.

## Optional signed webhook

An administrator must pre-register and enable each webhook URL for an
application. Submit its ID with:

```text
X-MultiVibe-Webhook: <registered-webhook-id>
```

After a successful job, MultiVibe posts:

```json
{
  "id": "event-id",
  "type": "job.completed",
  "createdAt": "2026-09-08T00:14:12.000+00:00",
  "data": {
    "job": {
      "object": "multivibe.job",
      "status": "succeeded"
    },
    "result": {}
  }
}
```

Headers include:

```text
X-MultiVibe-Event-Id: <event-id>
X-MultiVibe-Signature: sha256=<hex HMAC-SHA256 of the exact request body>
```

Verify the signature over the unmodified body with a constant-time comparison
before parsing or acting. Deduplicate callbacks by event ID. MultiVibe accepts
any `2xx` as success, follows no redirects, and gives each attempt a
ten-second timeout. Failures use exponential backoff capped at one hour and
remain eligible for up to 24 hours.

## Persistence, migration, and retention

Native jobs are stored in the JSON file selected by
`V1_EDGE_JOBS_PATH` (normally `/data/v1-edge-jobs.json`). Each persistence
cycle writes a temporary file with mode `0600` on Unix and renames it over
the destination. Job state and its event are published together only after
that write is durable. Workers pause on storage failures, and the drain keeps
such work active until the final transition has been saved. An uncertain
commit after replacement of the file blocks further mutations until restart.
Job event history is stored in the same file.

On startup:

- a `running` job is requeued if attempts remain, so it may run again;
- a job past its deadline becomes `expired`;
- a running job that exhausted its attempts becomes `failed`;
- the legacy SQLite database from `JOBS_DB_PATH`, when present, is opened
  read-only and imported idempotently;
- before import, Rust creates a consistent
  `*.pre-rust-backup.sqlite` copy if that backup does not already exist.

SQLite remains unchanged as a migration and rollback artifact. The Rust worker
does not renew SQLite leases and does not use SQLite as its live store.

Transient network errors, ordinary `429`, and `5xx` outcomes move the job to
`retry` with exponential backoff while attempts remain. A local
`capacity_unavailable` result is requeued after a short delay without
consuming an attempt.

Reading a result or successfully delivering its webhook starts a one-hour
grace period before request and result content can be purged. Content not
consumed or delivered is purged after 30 days. The remaining job record
becomes `expired`.

Request payloads and results are stored in clear text in the protected data
volume. Protect `V1_EDGE_JOBS_PATH`, its temporary files, the legacy SQLite
backup, and volume backups according to the deployment's data policy.

## Migration checklist for an application

- Identify non-interactive operations that do not stream and do not require
  confidential mode.
- Keep interactive and confidential paths synchronous.
- Configure the MultiVibe base URL, application API key, batch alias, and a
  feature flag.
- Persist the job ID, idempotency key, status, attempts, and last error in the
  application's durable store.
- Separate submission from monitoring so both survive restarts.
- Make result application and webhook processing idempotent.
- Add bounded polling and reconcile after network failures.
- Handle every terminal state explicitly.
- Avoid logging authorization headers, payloads, or model results.
- Cover submission replay/conflict, restart recovery, success, retries,
  expiry, cancellation, webhook deduplication, and malformed responses.

For a self-contained task specification, use
[the batch integration prompt](prompts/implement-multivibe-batch.md).
