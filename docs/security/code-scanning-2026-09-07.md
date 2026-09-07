# Code-scanning review — 2026-09-07

Reviewed all 32 open [GitHub CodeQL alerts](https://github.com/thibautrey/multivibe/security/code-scanning) against local Core `main` (starting at `691edbe`) and their recorded scan revisions. Eleven alerts warranted a fix or defensive hardening; the other 21 are false positives or intended behavior under Core's documented operator trust boundary. This is a review of those alerts, not a full security audit.

The sibling Cloud repository was consulted read-only, at `d5bf370666c3`: `docs/architecture.md:122` explicitly describes administrator-configured outbound URLs and distinguishes Core's single-operator assumptions from Cloud's multi-tenant perimeter. Cloud's separate controls must not be assumed to protect arbitrary standalone Core deployments.

## Fixed or hardened

### High: bounded authentication work — alerts 14, 16–18

Repeated authorized requests could initiate provider authorization, token exchanges, polling, and local credential imports without an application-level request budget. `src/auth-rate-limit.ts:1` now supplies a bounded, process-wide fixed-window middleware, returning HTTP 429 with `Retry-After` before the route performs work.

| Route | Budget per minute | Source |
| --- | ---: | --- |
| `/admin/grok/import` | 5 | `src/routes/admin/index.ts`, `/grok/import` registration |
| `/admin/oauth/start` | 10 | Same file, `/oauth/start` registration |
| `/admin/oauth/complete` | 30 | Same file, `/oauth/complete` registration |
| `/admin/oauth/device/poll` | 60 | Same file, `/oauth/device/poll` registration |
| `/admin/session` | 20 | `src/server.ts`, admin login registration |

The login route was protected as part of the same fix. Budgets are shared per route across callers of one Core process; they intentionally do not trust forwarded IP headers because the native edge proxies over loopback. Restart resets these in-memory budgets, and separate processes have separate budgets. Cloud still needs its own distributed controls. Ordinary device polling at five-second intervals remains below its budget.

### High: inefficient regexes — alerts 4–8

- **4:** `src/host/harness-integrations.ts:304`: quoted TOML keys and the bare-character branch previously overlapped. The branches are now disjoint, preserving quoted brackets and avoiding ambiguous repeated matching.
- **5–7:** `src/string-utils.ts:1`, used by OpenCode, quota URL fallback, and admin base-URL normalization, trims trailing slashes in a single backwards pass instead of an unanchored repeated suffix regex.
- **8:** `src/routes/admin/index.ts:222` trims alias edge hyphens with bounded index scans. The existing normalization of internal characters remains unchanged.

These changes preserve normal formatting while removing avoidable CPU growth. No attack traffic was sent to a deployed service.

### High, configuration-dependent: credential persistence — alert 29

The shipped deployment intentionally sends credentials between processes over loopback HTTP (`docker-compose.yml:19`). That default is not a remote cleartext exposure. However, the configurable control-plane URL previously permitted remote HTTP as well.

`rust/v1-edge/src/token_refresh.rs`, `persistence_url`, now requires HTTPS for remote hosts and allows HTTP only for loopback IPs or `localhost`. URL credentials, query strings, and fragments are rejected; account IDs are appended as URL path segments. Validation happens before provider token rotation, as well as at persistence. Token refresh/persistence callers in `rust/v1-edge/src/lib.rs` now use the existing redirect-disabled HTTP client, so redirects cannot forward credential bodies or the internal authentication header.

Compatibility: deployments using remote cleartext `NODE_CONTROL_PLANE_URL` must move to HTTPS. OAuth/Console endpoints must provide their final token URL rather than rely on redirects. Default same-host deployments remain supported.

### Low: overly permissive test assertion — alert 19

`src/ai-sdk/models.test.ts:20` now escapes both dots in the Google hostname assertion. This was a real assertion defect in mocked test code, not a production hostname validation vulnerability.

## No security fix required for the reported condition

| Alerts | Evidence and assessment |
| --- | --- |
| **1** | `host/updater/native.go:44`: `cleanArchivePath` checks relative containment. Linux extraction rejects links/unsupported entries and uses exclusive file creation inside a freshly created staging directory. The flagged archive names already pass those checks before filesystem access. |
| **2** | `host/updater/native.go:328`: Windows extraction validates every path component, checks relative containment, rejects duplicates, uses private staging and exclusive file creation, and rejects unsupported file entries. CodeQL has not recognized the custom validation. |
| **3** | `provider-agent/managed_ollama.go:995`: ZIP extraction validates paths, checks `managedOllamaPathWithin`, rejects duplicates, bounds sizes, and writes regular files exclusively in fresh private staging. ZIP metadata is never used to create symlinks. |
| **9** | `web/src/components/tabs/AccountsTab.tsx:1248`: session storage contains the flow ID, UI method/provider/mode, target account ID, pending preferences, and timestamp. It does not contain access/refresh tokens, PKCE verifiers, authorization codes, or device secrets. OAuth status/completion still require the admin boundary; the flow ID alone is not a login credential. |
| **10** | `src/local-runtime-discovery.ts:410`: PAIR discovery accepts only an HTTP loopback IP origin with an explicit port, rejects URL credentials/path/query/fragment, requests the fixed `/v1/models` path, and disables redirects. Probing the operator-selected local runtime is the feature. |
| **11–13** | `src/quota.ts:601`: quota requests use configured provider/account base URLs. These URLs are operator configuration behind the admin guard, not an inference caller's arbitrary URL. Custom/private inference providers are supported intentionally. This assessment does not authorize exposing Core configuration routes to untrusted tenants. |
| **15** | `src/server.ts:807`: the reported handler is the SPA fallback serving a fixed `index.html`; it does not authenticate a password or exchange a token. The actual admin login route was separately rate-limited. |
| **20** | `src/oauth.ts:67`: SHA-256 hashes a freshly random PKCE verifier to produce the OAuth `S256` challenge. This is the protocol-required construction, not password storage; a password KDF would break OAuth interoperability. |
| **21–25** | In the scanned revision, `rust/v1-edge/src/lib.rs:5115`, `:5116`, and `:5142` are `Vec::remove`/`Vec::insert`; `:11263` is `Vec::remove` in a unit test. These operations rearrange in-memory accounts and do not log them. Current equivalents are near lines 5111, 5112, 5138 and in the token-refresh test. |
| **26** | `rust/v1-edge/src/lib.rs:3984`: `TraceSink` writes to `self.path`, initialized from the operator's `TRACE_FILE_PATH` configuration. Request content can enter a trace entry but does not select its filesystem destination. |
| **27** | `rust/v1-edge/src/token_refresh.rs:132`: the OpenAI token request uses configured `oauth_token_url`. OpenCode/xAI account-provided issuer metadata is checked against configuration; it does not select an arbitrary destination. Redirect handling was nevertheless hardened with alert 29. |
| **28** | `rust/v1-edge/src/lib.rs:1433`: upstream origins come from configured provider URLs/account records, combined with provider paths. An inference caller selects eligible models/accounts but cannot supply an arbitrary origin through this code. Custom upstreams are intentional under the operator boundary. |
| **30** | `rust/v1-edge/src/confidential.rs:206`: the constant `"null"` is canonical JSON serialization. The canonical evidence is hashed into an HKDF salt; this is not a hard-coded encryption key. |
| **31–32** | `rust/v1-edge/src/confidential.rs:485`: zero-filled arrays are output buffers. Successful `hkdf.expand` overwrites every key byte using the X25519 shared secret and evidence-derived salt; errors return before use. |

## Validation

- Worktree: source/diff review, `git diff --check`, and Node's dependency-free TypeScript syntax checks for the new utility and middleware passed. No dependencies were installed in the worktree.
- Main: `npm run build:api` passed. Targeted TypeScript tests passed (47 tests), covering auth budgets, string normalization, harness integration including quoted TOML keys, real SDK codecs, OAuth, OpenCode/quota behavior, and account redaction.
- Rust and Go validation: results recorded below after completion.

The initial Rust command could not open the pre-existing `target/debug/.cargo-build-lock` (permission denied). Main-branch Rust validation uses `CARGO_TARGET_DIR=/home/codex/.cache/multivibe-security-target` instead. Missing Rust/Go toolchains were installed outside the checkout; no lockfiles or generated dependency artifacts were changed.

GitHub alerts have not been dismissed or edited. Fixes are committed locally, without a push; the hosted CodeQL status cannot reflect these changes until a later push and analysis. Custom middleware and validators may still need manual false-positive review even after a successful scan.
