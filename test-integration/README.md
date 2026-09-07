# Core ↔ Cloud integration tests

From the Core checkout root:

```sh
npm run test:integration:cloud
# Optional alternate Cloud checkout:
MULTIVIBE_CLOUD_DIR=/absolute/path/to/multivibe-cloud npm run test:integration:cloud
```

Requires Node.js 22+ and installed npm dependencies in both Core and the sibling
`../multivibe-cloud` checkout. Missing Cloud sources or dependencies fail the
command; the suite is explicitly separate from `npm test`, so a standalone Core
checkout does not require the private Cloud repository. No credentials, database,
paid inference, or running deployment are needed. Servers bind ephemeral loopback
ports, and Core account/OAuth files are created in a temporary directory and removed.

The suite imports the sibling Cloud HTTP server and its in-memory test helpers
at runtime. It therefore detects contract changes in that checkout, including
uncommitted changes. Both repositories' revisions should be recorded when
reproducing a failure (initial validation: Cloud `157f05a`).

Coverage:

- Core connection service → real Cloud OAuth token route, PKCE parameters and
  callback compatibility; rejected grants leave accounts/settings untouched.
- Real Cloud project and API-key routes, scoped dashboard authentication,
  provisioning payloads, idempotency headers, durable Core account storage and
  prevention of callback replay.
- Core `/v1/models` → Cloud `/v1/models`, filtering out models absent from the
  Cloud entitlement/upstream intersection and avoiding API-key disclosure.
- Core `/v1/responses` → Cloud managed inference → deterministic provider,
  including managed model mapping, JSON output and UTF-8 SSE completion.
- Unsupported explicit fields remain rejected by Cloud without model invocation.

Boundaries: identity/token issuance and project/key persistence use injected test
services; Cloud dashboard authentication, HTTP parsing/validation, managed routing
and its in-memory admission store are real. User sign-in/consent in a browser,
PostgreSQL, production inference gateways, billing, native Rust edge and real model
providers are outside this suite. The Core HTTP admin callback has separate tests
in `src/routes/admin/multivibe-cloud-routes.test.ts`.

The integration suite caught Codex-specific defaults added to Cloud Responses
requests (`store`, forced streaming and other unsupported fields). Core now sends
the original Responses payload for Cloud accounts, leaving validation to Cloud.
