# Headroom request compression

MultiVibe can ask a local [Headroom](https://docs.headroomlabs.ai/) service to
shrink the provider-ready request body before the Rust edge sends it upstream.
MultiVibe still owns model routing, account selection, subscription
authentication and quota accounting; Headroom only rewrites bytes.

This is the **request half only**. MultiVibe does not call
`/v1/compress/response`, does not redeem CCR retrieval markers, and never
re-drives a provider call. Streaming requests therefore use
`gateway.can_redrive=false`.

## Enable it

Start Headroom on loopback in cache mode:

```bash
headroom proxy --host 127.0.0.1 --port 8787 --mode cache
```

Then point the edge at it:

```bash
HEADROOM_COMPRESS_URL=http://127.0.0.1:8787/v1/compress
HEADROOM_PROXY_TOKEN=replace-with-a-secret   # when Headroom requires one
```

A base URL such as `http://127.0.0.1:8787` is also accepted and normalized to
`/v1/compress`. Compression stays disabled when `HEADROOM_COMPRESS_URL` is
empty.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEADROOM_COMPRESS_URL` | unset | Headroom endpoint. Unset disables compression. |
| `HEADROOM_PROXY_TOKEN` | unset | Sent as `X-Headroom-Proxy-Token`. `HEADROOM_API_TOKEN` is accepted as an alias. |
| `HEADROOM_TIMEOUT_MS` | `3000` | Whole-call budget. Clamped to 50–30000 ms. |
| `HEADROOM_MIN_BYTES` | `4096` | Serialized provider body below this size is not sent to Headroom. |
| `HEADROOM_COMPRESS_MODE` | unset | Optional marker-free mode: `lossless`, `lossy_inline` or `lossless_then_lossy`. `ccr` is rejected. |

For a container deployment, publish Headroom only on loopback and set
`HEADROOM_COMPRESS_ALLOW_REMOTE=1` only when the sidecar really is reached over
a container network. Keep `HEADROOM_PROXY_TOKEN` set in that case.

## When compression runs

The edge calls Headroom after the provider body is fully prepared — protocol
conversion, model selection, provider defaults and tool sanitization are
already applied — and before serialization. Compression is skipped when any of
these is true:

- no stable session ID (`session_id`, `session-id`, `x-session-id`,
  `x-session_id`, or the Codex session/thread headers);
- the request is confidential (`MULTIVIBE_CLOUD_PRIVACY_MODE=confidential_verified`,
  `X-MultiVibe-Privacy: confidential_verified`, or a confidential account);
- the route is an embedding, image or decisions call, or
  `/responses/compact`;
- the account is a managed MultiVibe Cloud account;
- the body carries `previous_response_id`, has no `messages`/`input` field,
  has empty input, is smaller than `HEADROOM_MIN_BYTES`, or already carries a
  Headroom control key (`config`, `gateway`, `token_budget`);
- the Headroom circuit breaker is open.

Only requests with a stable session ID are compressed because Headroom session
mode is what protects the provider's prefix cache. Without it, a fresh
compression decision each turn could rewrite already-cached bytes.

## Prefix-cache contract

The request carries:

```json
{
  "config": { "session_id": "<stable conversation id>" },
  "gateway": {
    "can_redrive": false,
    "can_relay_response": false,
    "request_headers": { "anthropic-beta": "<client tokens>" }
  }
}
```

`request_headers` is only present when the client sent `anthropic-beta`.
Headroom puts those tokens first in the `anthropic-beta` header it returns, and
MultiVibe merges only that allowlisted header back into the upstream request.

Headroom returns the complete provider body. The edge forwards that body
verbatim, so the next turn replays the same prefix. Keep
`HEADROOM_COMPRESS_MODE` stable for the lifetime of a session; changing the
mode mid-conversation invalidates the replay contract.

Session state lives in the Headroom process. Run one Headroom replica, or pin a
session to a replica, exactly as you would for Headroom's proxy path.

## Fail-open behavior

Compression never fails an inference request. A connection error, timeout,
non-2xx response, invalid JSON, missing body, changed model, changed streaming
flag, changed prompt cache key, mismatched wire shape, or unredeemed obligation
leaves the original body untouched. Transport, timeout and HTTP failures also
open a short exponential cooldown (1 s up to 30 s) so a dead sidecar does not
add its timeout to every turn.

## Trace signal

Compressed attempts carry a separate `compression` object in the trace
journal:

```json
{
  "provider": "headroom",
  "outcome": "compressed",
  "tokensBefore": 12000,
  "tokensAfter": 7400,
  "tokensSaved": 4600,
  "compressionRatio": 0.6167,
  "transforms": ["router:smart_crusher:0.35"],
  "durationMs": 84,
  "wireShape": "openai_responses",
  "frozenMessageCount": 8,
  "cachedPrefixReplayed": false
}
```

`tokensSaved` is Headroom's request-side estimate. It is deliberately **not**
merged into `tokensInputCached`, `tokensInputCacheWrite`, `cacheSavingsUsd` or
`costUsd`; those remain the provider's measured cache signal. Failed and
skipped attempts record `outcome: "failed"` or `"skipped"` with a short reason.

## What is not implemented

- response-half compression (`/v1/compress/response`);
- relaying provider usage to `/v1/usage` (session replay uses Headroom's own
  turn state, not provider cache telemetry);
- CCR markers and `/v1/retrieve`;
- re-driving a provider call;
- compressing user messages (`config.compress_user_messages` is never sent,
  and session mode rejects it anyway).
