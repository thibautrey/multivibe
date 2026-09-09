# Managed execution runtime

Build with `npm run build:api`, start with `npm run start:managed`.
This entrypoint mounts no desktop routes and imports no desktop server bootstrap.

Required environment configuration:

- `MANAGED_CORE_JOURNAL_DIRECTORY`: existing persistent directory shared by every replica accepting grants for this execution group. Do not use per-pod ephemeral storage. Exclusive file creation and fsync semantics must be verified on the actual volume before activation.
- `MANAGED_CORE_PROVIDER_MANIFEST_FILE`: absolute JSON manifest path.
- `MANAGED_CORE_CREDENTIAL_DIRECTORY`: absolute directory of scoped provider secret files.
- `MANAGED_CORE_TLS_KEY_FILE`, `MANAGED_CORE_TLS_CERT_FILE`, `MANAGED_CORE_TLS_CA_FILE`: workload mutual-TLS files.
- `MANAGED_CORE_CLOUD_VERIFY_KEY_FILE`: Cloud Ed25519 public key; Core never receives the signing key.
- `MANAGED_CORE_CLOUD_SPIFFE_URI`: exact allowed client workload URI.

Optional bounded settings: `MANAGED_CORE_HOST`, `MANAGED_CORE_PORT`, `MANAGED_CORE_MAX_REQUEST_BYTES`, `MANAGED_CORE_MAX_RESPONSE_BYTES`, `MANAGED_CORE_MAX_CONCURRENCY`, `MANAGED_CORE_EXECUTION_TIMEOUT_MS`. Defaults are in runtime.ts.

Manifest example (credential references are identifiers, not values):

```json
{
  "version": 1,
  "accounts": [{
    "providerId": "mistral",
    "credentialRef": "providers/mistral/production",
    "credentialFile": "mistral-api-key",
    "models": ["mistral-large-latest"]
  }]
}
```

All provider requests use the fixed CONNECT egress corridor and verified provider TLS. Runtime configuration cannot introduce arbitrary upstream origins. Discovery uses the same account and path but does not activate public prices or project access.

The internal API requires mutual TLS and signed execution grants. Non-stream replies contain independent response and receipt fields. Stream replies use application/x-ndjson framing with a response frame, base64 body chunks, then a durable receipt. The public Cloud response remains normal SSE. Client cancellation stops delivery, while a bounded provider drain collects evidence. Missing terminal usage stays uncertain; no implicit provider retry occurs.

This runtime is not yet activated in production. Replica-safe storage, crash reconciliation, all priced dimensions and signed deployment provenance remain integration requirements.

Receipt publication uses a synced temporary file and an exclusive hard link to
publish the completed JSON atomically. The journal volume must support atomic
exclusive create, hard links, and directory fsync. A missing receipt after a
claim remains uncertain; startup must never delete claims to make retries work.

The independent-process test races eight Node processes against the same local
journal and verifies one winner and seven rejections. A new process after the
winner exits is also rejected. This proves process-level coordination on the
tested filesystem; actual Kubernetes volume semantics still require validation.
