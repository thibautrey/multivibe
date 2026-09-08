# Subscription quota audit — 2026-09-08

## Coverage and changes

| Connection | Quota checking |
| --- | --- |
| ChatGPT/OpenAI | Existing WHAM endpoint retained; validates recognizable windows and finite values, normalizes weekly-only accounts, trims base URL slashes, surfaces failed probes. |
| OpenCode Go | Existing rolling, weekly, monthly parser and entitlement handling retained; shares bounded failure retries and correct background failure reporting. |
| OpenCode Console | Explicitly unsupported with existing guidance to connect a Go inference key. |
| Z.ai / BigModel | Reads actual `data.limits` token/credit quotas, percentage or consumed/total values, period metadata and resets; retains older named windows. MCP tool allowance is displayed separately and excluded from model routing. Unknown model periods and provider error envelopes are errors. |
| Grok Build | Adds authenticated `/v1/billing?format=credits` query using existing OAuth token and client headers. Displays subscription credit percentage and provider reset. Missing percentage stays unknown; on-demand spending is not substituted for subscription consumption. |
| Mistral | Explicitly unsupported with the current API credential. Vibe quota retrieval found in third-party tooling requires a separate Console browser/CSRF session, which Multivibe does not store. |
| Generic OpenAI-compatible / AI SDK | Explicitly unsupported except recognized Z.ai/BigModel hosts; clears obsolete windows. |

All supported probes preserve stale readings with an explicit error state, and retry after at most one minute (or the configured shorter cache TTL), rather than on every request after a failed reset-time probe. Forced refresh still bypasses caching. Background refresh counts failures correctly. Successful probes clear quota-related errors without erasing unrelated inference errors. Account selection avoids exhausted model quotas when another account has headroom and compares headroom for accounts without weekly windows.

## Evidence and limits

- Z.ai official script: https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs
- Z.ai quota semantics: https://docs.z.ai/devpack/faq
- Supplemental current Z.ai credit/period schema: https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Resources/Plugins/zai.js
- OpenCode subscription documentation: https://opencode.ai/docs/go/
- Grok official CLI documentation: https://docs.x.ai/build/overview and https://docs.x.ai/build/features/status-line
- Grok billing schema/headers (third-party implementation; not a public API stability guarantee): https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Grok/GrokCreditsProxyFetcher.swift
- Mistral Vibe public source inspected for quota surfaces: https://github.com/mistralai/mistral-vibe
- Mistral browser credential requirements: https://github.com/steipete/CodexBar/blob/main/docs/mistral.md

No authenticated customer quota response was obtained. OpenBao metadata searches did not locate matching Z.ai, Mistral, OpenCode, or Grok subscription credentials; API billing keys found under unrelated applications were not used. Parser/transport tests use synthetic fixtures based on the cited source contracts. Provider-specific plan availability still requires a live refresh in a connected account.

This audit supersedes the implementation-gap sections of `zai-subscription-quota-assessment.md`.

## Validation

Worktree: source review and `git diff --check` passed. Dependency-backed validation was deferred to local `main` as required.

Local `main`:

- `node --import tsx --test src/quota.test.ts src/quota-blocks.test.ts src/usage-refresh.test.ts src/usage-refresh-monitor.test.ts`: 49 passed.
- `node --import tsx --test src/routes/proxy/account-rotation.test.ts src/routes/proxy/native-stream-account-rotation.test.ts`: 4 passed.
- `npm run build:api` and `npm run build:web`: passed. Vite emitted its bundle-size advisory.
- `CARGO_TARGET_DIR=/tmp/multivibe-quota-cargo-target /home/codex/.cargo/bin/cargo test -p multivibe-v1-edge account_selection --lib --locked`: 2 passed. Native routing now consumes subscription credits and avoids exhausted quotas when alternatives have headroom.

Rust validation initially failed with `cargo: command not found`; installed the minimal Rust toolchain. The default target directory then failed with `Permission denied` opening `target/debug/.cargo-build-lock`; the successful run used the separate temporary target directory above. No lockfiles were changed.
