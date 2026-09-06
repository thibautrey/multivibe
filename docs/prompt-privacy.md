# Prompt privacy in MultiVibe Core

## Implementation update — 6 September 2026

Core now contains the fail-closed client foundation for `confidential_verified` inference. It verifies signed, challenge-bound evidence against locally pinned Ed25519 roots and exact measurements, checks protected CPU/GPU state, encrypts the prompt to the attested X25519 recipient key, and authenticates/decrypts the response locally. The matching Cloud path only relays sealed envelopes.

This mode is disabled unless both `MULTIVIBE_CLOUD_PRIVACY_MODE=confidential_verified` and a local `MULTIVIBE_CONFIDENTIAL_INFERENCE_TRUST_POLICY` are configured. No production trust bundle or qualified CPU/GPU runtime is shipped. Conventional provider routes therefore remain conventional, and the hardware-backed privacy promise remains unavailable.

The policy is non-downgradable within the Core process: confidential requests filter out standard accounts, fail immediately on verification or protected-transport errors, bypass clear response replay storage, omit request bodies from traces, and do not enter the current clear deferred-job store. See the Cloud document `docs/confidential-inference-implementation.md` for the protocol, activation contract, limitations and test coverage.

Source review: 6 September 2026, commit `d7713a87c3e3c9a03cc2ef1bb35f088609528f8d`.
Status: documentation of current behavior and proposed requirements. This document does not implement a confidential-computing mode or certify an installation.

## What Core protects today

Core can run without a MultiVibe Cloud account. It can route to a local runtime or to a remote provider. **Running the proxy locally does not automatically mean that inference stays on your device.** The selected model, provider, runtime configuration and any tools determine where the content goes.

Request bodies and request headers are excluded from Core traces by default (`src/config.ts:101`). Header values receive additional sanitization when header tracing is enabled. Recent traces and longer-term statistical history have separate representations; `src/traces.ts:1727` removes the request body, headers and several diagnostic fields from statistical history.

These defaults reduce collection. They do not prevent the running proxy, the selected inference runtime or an administrator of the hosting machine from accessing content in memory. A remote provider also receives the data needed to answer the request. Its retention and training terms must be evaluated separately.

The host updater checks trusted Ed25519 signatures before accepting an update document (`host-updater/manifest.go:90`). This helps verify update authenticity. It is not remote hardware attestation of the inference runtime and does not prove that an operator cannot inspect model memory.

## Where content and metadata can remain

| Feature | Current source behavior | Privacy consequence |
| --- | --- | --- |
| Request traces | `TRACE_INCLUDE_BODY` defaults to `false`; proxy trace construction can include `req.body` when enabled (`src/routes/proxy/index.ts:2790`) | Diagnostic configuration can retain prompts; do not claim that all traces are always content-free |
| Trace storage | JSONL append (`src/traces.ts:1693`) and later compaction | Protect the data directory and backups; compaction is not proof of secure erasure |
| Deferred jobs | SQLite uses WAL, file permissions `0600`, and JSON request/result columns (`src/jobs.ts:175`, 196, 301, 477) | Queued requests and results may be stored as readable application data; no application-level encryption is visible in these writes |
| Job expiry | `purge()` nulls request/result data at `purge_after` or after a 30-day creation-age ceiling (`src/jobs.ts:562`) | Logical deletion does not prove removal from WAL, free pages, filesystem snapshots or backups; effective retention depends on purge scheduling and job policy |
| Synchronous idempotency | Eligible completed responses can be cached in process memory (`src/inference-idempotency.ts:419`); default TTL is five minutes (`src/config.ts:213`) | Prevents duplicate execution but differs from immediate deletion after delivery |
| Operational errors | Sentry is initialized only when `SENTRY_DSN` exists (`src/sentry.ts:7`) | Its setup enables HTTP/Express integrations without a project-specific export scrubber visible here; actual payload capture needs verification against the SDK and deployment |
| Usage sharing | New/missing settings enable anonymous usage sharing (`src/store.ts:126`); worker sends allowlisted model aggregates (`src/anonymous-usage-sharing.ts:222`, 269) | The observed schema uses model/count aggregates, not prompts; aggregation does not prove network anonymity or hide the sender IP from every intermediary |
| Local model runtime | Core hands the request to the selected runtime | Runtime logging, caches, extensions and storage have their own behavior; they are not audited merely by choosing a loopback address |

These references identify source behavior, not the configuration of your machine. Full-disk encryption or infrastructure controls may provide additional protection; they were not verified by this review. They also do not make plaintext inaccessible to an authorized running process.

## Practical interpretation

- To keep a computation on your device, use a genuinely local model and check that tools, retrieval, preprocessing and fallbacks do not send content to remote services.
- Keep body tracing disabled unless you intentionally need it. Review retained traces and backups after diagnostic sessions; turning the option off does not delete previously retained data.
- Treat deferred jobs and replay as retention features. Do not assume a “no logging” preference also disables them.
- Review the anonymous usage sharing setting separately from provider selection. Its aggregate data and network metadata are different from inference content.
- A provider contract that forbids training, a TLS connection and hardware-backed confidential execution are three different protections.

## What an Apple PCC-like mode would require

Apple Private Cloud Compute combines hardware and software protections, client-verified attestation, encrypted requests to verified nodes, restricted administration, transient processing, limited metadata and publicly verifiable software releases. It is not equivalent to running a signed container, using a VPN, or forwarding a request to a conventional cloud API.

A future Core integration would need all of the following:

1. A trusted client that verifies the destination environment before the message leaves its trust boundary. If the client runs in an application's server, that server already sees the prompt; do not describe that as end-user-device encryption.
2. A narrow inference runtime protected across CPU, GPU, firmware, drivers and memory transfers. A CPU enclave with an ordinary unprotected GPU is insufficient.
3. Short-lived encryption keys generated inside the verified environment, bound to fresh attestation and approved software/model measurements. Operators must not have an alternate way to export those keys.
4. A policy that persists per project and never silently falls back to a less protective provider, region or execution mode.
5. Authenticated encrypted streaming, explicit completion, cancellation and retry semantics. Existing SSE compatibility alone does not implement this protocol.
6. Storage rules for traces, errors, job queues, replay caches, model caches, embeddings, temporary files, dumps and backups. Local queues or client-encrypted deferred results can preserve useful features without readable server retention.
7. An update and transparency system through which clients and independent researchers can verify what is actually executing. A signed release alone does not establish its safety or its current execution state.
8. Minimal telemetry and receipts that do not export content. Stronger unlinkability also requires separating account identity from execution and considering an independently operated privacy relay.
9. A support and incident workflow that does not add a hidden prompt-capture or debug bypass.
10. Independent security review and measured latency, quality and cost for each supported hardware/model configuration.

Ordinary community hosts should not receive the confidential-mode label simply because they sign a receipt or run a verified archive. Their owner can generally inspect or replace a conventional runtime. An Apple silicon computer's Secure Enclave does not automatically provide PCC's protections to an arbitrary local model process.

## Experience to preserve

Keep the existing compatible interface where practical, using an explicit local adapter/SDK for attestation and encryption. Show only models compatible with the selected policy, prefetch public verification data, keep model weights warm, and show the actual execution mode without technical setup dialogs.

When verification fails before sending, keep the user's text and explain that it was not sent. After a disconnect that happens after sending, report the known state accurately. Preserve streaming and distinguish “not executed” from “execution uncertain” to avoid duplicate work or charges. Never sacrifice verification freshness to improve a performance chart.

A future confidential mode, conventional provider routes and purely local computation should remain distinguishable. No such new mode is implemented by this documentation change.

## Public references

- [Apple: Private Cloud Compute architecture](https://security.apple.com/blog/private-cloud-compute/)
- [Apple: PCC security research and verification resources](https://security.apple.com/blog/pcc-security-research/)
- [Apple: separate privacy terms for the ChatGPT extension](https://www.apple.com/legal/privacy/data/en/chatgpt-extension/)
- [NVIDIA: confidential computing documentation and compatibility resources](https://docs.nvidia.com/confidential-computing/index.html)
- [RFC 9180: Hybrid Public Key Encryption](https://www.rfc-editor.org/rfc/rfc9180)
- [RFC 9458: Oblivious HTTP](https://www.rfc-editor.org/rfc/rfc9458)

The cross-repository audit and detailed implementation proposal are maintained in the private Cloud repository. This public Core guide is standalone and does not require access to that repository.
