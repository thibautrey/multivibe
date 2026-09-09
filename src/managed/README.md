# Managed execution runtime

Build with `npm run build:api`, start with `npm run start:managed`.
This entrypoint mounts no desktop routes and imports no desktop server bootstrap.

Required environment configuration:

- `MANAGED_CORE_COORDINATION_URL`: fixed private TLS endpoint for shared execution ownership. Core claims an owner epoch but cannot authorize provider dispatch or persist a receipt directly.
- `MANAGED_CORE_PROVIDER_MANIFEST_FILE`: absolute JSON manifest path.
- `MANAGED_CORE_INJECTOR_URL`: fixed private TLS endpoint for the credential injector.
- `MANAGED_CORE_TLS_KEY_FILE`, `MANAGED_CORE_TLS_CERT_FILE`, `MANAGED_CORE_TLS_CA_FILE`: workload mutual-TLS files.
- `MANAGED_CORE_CLOUD_VERIFY_KEY_FILE`: Cloud Ed25519 public key; Core never receives the signing key.
- `MANAGED_CORE_CLOUD_SPIFFE_URI`: exact allowed client workload URI.

The injector uses the matching `MANAGED_INJECTOR_COORDINATION_URL`, its own
`MANAGED_INJECTOR_*` TLS identity, provider manifest and credential directory.
Core rejects any configured credential directory.

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

The internal API requires mutual TLS and signed execution grants. Non-stream replies contain independent response and receipt fields. Stream replies use application/x-ndjson framing with a response frame, base64 body chunks, then a durable receipt. The public Cloud response remains normal SSE. Client cancellation stops delivery, while a bounded provider drain collects evidence. Missing terminal usage stays uncertain; no implicit provider retry occurs. Both runtimes require the shared coordination service: Core claims a short lease, carries the returned owner and epoch to the injector, and the injector consumes the dispatch fence immediately before the provider call. The injector also persists Core's bounded receipt through its own coordinator identity.

This runtime is not yet activated in production. Cloud takeover orchestration, durable response recovery, all priced dimensions and signed deployment provenance remain integration requirements.

The managed runtime no longer requires a journal directory or writable PVC.
Execution identity, fencing epochs and receipts live in the separate shared
coordination database. A missing receipt after dispatch remains uncertain and
never authorizes a second provider call.
