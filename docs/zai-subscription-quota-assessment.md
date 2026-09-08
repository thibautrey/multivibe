# Z.ai subscription quota feasibility

Checked 2026-09-08. Verdict: feasible; Multivibe already has a partial integration, but its parser does not handle the format used by Z.ai's published usage plugin. This assessment does not change runtime behavior.

## Evidence

- Z.ai's official [usage query script](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs) calls `GET https://api.z.ai/api/monitor/usage/quota/limit` using the configured coding credential in `Authorization`. It also supports BigModel hosts.
- The script reads `data.limits`, interpreting `TOKENS_LIMIT` as five-hour model usage and `TIME_LIMIT` as monthly MCP usage. It reads `percentage`, `currentValue`, `usage`, and `usageDetails`. This is source evidence, not a live response captured from this account.
- The [official FAQ](https://docs.z.ai/devpack/faq) confirms five-hour and weekly subscription limits. The script alone does not establish the current weekly response schema or reset fields. Those require a current authenticated response before implementation assumptions are finalized.
- The script also queries `/api/monitor/usage/model-usage` and `/api/monitor/usage/tool-usage` with start/end times for historical statistics; these are optional for a quota display.

## Existing implementation

- `src/quota.ts`: `zaiQuotaUrl` already selects the monitoring endpoint; `refreshUsageIfNeeded` calls it for native Z.ai accounts and recognized OpenAI-compatible hosts.
- `parseZaiUsage` only reads named primary/five-hour and secondary/weekly objects. It does not inspect `limits`. `parseZaiWindow` does not read `percentage` or `currentValue`. The official plugin's response format therefore produces empty quota windows while updating `fetchedAt` and clearing the last error.
- Multivibe adds a Bearer prefix; the official script forwards the configured credential unchanged. Verify accepted authentication against the live endpoint before changing this behavior.
- The account UI already has quota percentages/reset display and refresh integration. Z.ai failures currently record `lastError`, but do not set the explicit quota error status used by OpenCode.

## Recommended implementation scope

1. Capture a sanitized response through the existing account credential, checking authentication and provider-level errors even on HTTP 200. Never store the credential in fixtures.
2. Parse `limits` and `percentage`, retaining existing named-window compatibility. Map windows using actual period metadata rather than assuming every token limit is five-hour. Support weekly/reset metadata only where verified; absent values must remain unknown.
3. Represent MCP allowance separately from model allowance. Do not map monthly tool usage into a generic exhausted model quota: existing routing considers generic quota windows when determining model exhaustion/reset behavior. Current plan variants may differ from the published plugin's older labels.
4. Mark unrecognized/error responses visibly instead of accepting an empty successful snapshot. Preserve stale values with an explicit error state and refresh timestamp policy.
5. Add focused fixture tests for actual five-hour/weekly payloads, optional tool quota, reset units, unknown shapes, and HTTP/provider errors. Verify account refresh and UI display, then routing behavior when model quota is exhausted.

## Validation and limits

Direct source review and official documentation/script retrieval completed. OpenBao metadata searches for `zai` and `z.ai` returned no matches; no authenticated subscription request was made. Account-specific quota availability, exact current schema, and accepted auth format remain unverified. No runtime changes or dependency-backed builds/tests were needed for this documentation-only assessment; `git diff --check` is the applicable repository check.
