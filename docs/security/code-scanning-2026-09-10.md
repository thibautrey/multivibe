# Code-scanning review — 2026-09-10

## Executive summary

Reviewed all 31 open GitHub CodeQL alerts against hosted scan commit `3fd3a02` and local `main` at `f369e26`. None of the 31 currently open alerts represents an exploitable condition in the reviewed trust model. The 18 carryover alerts remain false positives; the 13 newly reported alerts are also false positives caused by CodeQL not recognizing existing validation, fixed destinations, custom rate-limit middleware, or deliberately non-secret audit metadata.

The eleven real or defense-in-depth findings from the 2026-09-07 review are already fixed on `main`. The latest hosted analysis no longer reports alerts 4–8, 14, 16–19, or 29, confirming that those changes reached GitHub and were recognized. No new production-code fix is required by the current alert set.

This is a triage of the reported alerts, not a claim that the entire repository is vulnerability-free.

## Newly reported alerts

| Alerts | Classification and evidence |
| --- | --- |
| **33** | **False positive.** `src/server.ts` serves the SPA fallback from the fixed `webDist/index.html` path. Request data only decides whether the handler delegates to the next route; it never selects a filesystem path. Rate limiting a static SPA fallback would not address a security boundary. |
| **34–37** | **False positives on the current source.** The flagged authentication handlers already attach the process-wide `createAuthRateLimiter` middleware: `/grok/import` (5/minute), `/oauth/start` (10/minute), `/oauth/complete` (30/minute), and `/oauth/device/poll` (60/minute). CodeQL does not recognize the custom Express middleware as a rate limiter. Its HTTP contract is covered by `src/auth-rate-limit.test.ts`. |
| **38** | **False positive.** `test-integration/host-cloud/audit-production.py` emits deployment metadata, readiness booleans, key prefixes/states, and equality groups. The expression CodeQL labels as a secret is a Kubernetes `secretKeyRef` object: it contains the configured Secret name and key name, not the Secret value. Pepper and database comparisons use nonce-bound HMAC digests, discard the digests, and output only equality groups. Child-process output is withheld on errors and covered by `test_audit_production.py`. |
| **39–41** | **False positives under Core's documented single-operator boundary.** `src/quota.ts` derives quota URLs from the account/provider base URL configured behind the admin guard. Inference callers cannot supply these destinations. Supporting operator-configured private/custom providers is intentional; making the configuration surface multi-tenant would require a separate outbound-network policy. |
| **42–43** | **False positives.** `provider-agent/managed_engine_install.go` validates every TAR/ZIP name with `safeManagedEnginePath` before joining it to the private `MkdirTemp` staging directory. The validator rejects absolute paths, cleaned paths that differ, `..` traversal, separators invalid for the platform, control characters, duplicates, symlink escapes, unsupported entry types, and excess entries/bytes. Files use exclusive creation, and archive symlinks are materialized as regular files only after their in-archive targets are validated. Traversal, absolute-path, escaping-link, cycle, duplicate, and special-file cases are exercised by `TestManagedEngineArchiveRejectsTraversalAndResolvesInternalLinks`. |
| **44** | **False positive.** The dynamic quota-fetcher key originates at the admin account route but `validateSdkAccount` rejects every value not present in the fixed `SDK_PROVIDERS` catalog before persistence. Therefore inherited names such as `__proto__`, `valueOf`, or `hasOwnProperty` cannot reach `fetchSdkUsage`; unknown persisted providers return the existing unsupported result rather than being accepted through the API. |
| **45** | **False positive.** The Team inference route uses high-entropy, expiring bearer credentials whose SHA-256 digests are listed in a signed machine policy. Failed authorization performs only a hash and bounded key lookup. Authorized inference is already bounded by the signed `maxConcurrent` policy and local-runtime boundary. A global request limiter would let unauthenticated traffic deny service to legitimate Team members, while IP-based limiting would require a deployment-specific trusted-proxy contract. |

## Carryover alerts

The earlier source-backed classifications remain valid:

- **1–3:** archive paths pass containment validation before exclusive writes into private staging; unsupported links and entry types are rejected.
- **9:** session storage contains OAuth UI/flow coordination metadata, not tokens, authorization codes, PKCE verifiers, or device secrets.
- **10:** local runtime discovery accepts only explicit loopback HTTP origins, uses a fixed path, rejects credentials/path/query/fragment, and disables redirects.
- **11:** quota destinations are operator-configured account/provider URLs behind the admin boundary, not inference-request input.
- **20:** SHA-256 implements the OAuth PKCE S256 challenge; it is not password hashing.
- **21–25:** the flagged Rust operations are `Vec::remove`/`Vec::insert`, including a unit test, and do not log account secrets.
- **26:** the trace destination is operator configuration; request content does not select the filesystem path.
- **27–28:** OAuth and inference destinations come from validated/configured provider metadata under the operator boundary, and redirect forwarding is disabled.
- **30–32:** `"null"` is canonical JSON input to an evidence-derived salt, while zero-filled arrays are output buffers fully overwritten by successful HKDF expansion before use.

## Validation boundary

- The live GitHub API inventory and per-alert data-flow messages were reviewed on 2026-09-10.
- The changed artifact in this follow-up is documentation only; no dependency or generated artifact was changed.
- Targeted existing tests should be run from integrated local `main` in accordance with the repository worktree policy.
- Hosted alert dismissal records triage status only. It does not replace a future CodeQL run for subsequent source changes.
