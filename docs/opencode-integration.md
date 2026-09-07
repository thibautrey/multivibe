# OpenCode integration

Verified on 2026-09-07 against the public Go implementation and the deployed
Console application's API schema. These are different authentication surfaces.

| Connection | Inference credential | Workspace | Quota support |
| --- | --- | --- | --- |
| Zen / Go API key | API key | Bound to the key | Go exposes rolling 5h, weekly, monthly windows |
| Console device OAuth | Current OAuth access token when config returns `{env:OPENCODE_CONSOLE_TOKEN}` | `x-org-id` | No Go quota-window endpoint was found in the current Console API schema |
| Console config with a literal inference key | Configured key | `x-org-id` plus configured headers | Depends on the configured API root and Go entitlement |

The public Go route is `/zen/go/v1/usage`, including when inference uses `/zen`.
It authenticates against API keys, returns `usage.rolling`, `usage.weekly`, and
`usage.monthly`, and each window supplies `percent` and `resetsAt`. The documented
base limits are $12 per 5 hours, $30 per week, and $60 per subscription month;
model multipliers affect actual consumption. MultiVibe does not hard-code these
amounts or approximate a month as 30 days.

An authenticated key without a Go subscription receives HTTP 403 with
`error.type = EntitlementError` and `OpenCode Go subscription required.`.
Only that explicit response establishes unsupported Go quotas. Other 403s,
401s, 404s, non-JSON responses, and unrecognized success payloads are refresh
errors. Unsupported snapshots discard stale quota windows. Monthly exhaustion
is included when calculating the cooldown after an upstream quota rejection.

The Console inference root `/inference/openai` is not a usage root. MultiVibe
shows an explanation without probing a fabricated `/inference/openai/v1/usage`
route. Console billing summaries and dollar budgets are not converted into Go
quota percentages. A separate Go API-key account is needed to use the public
Go quota API.

Both Node and the native Rust edge resolve the Console token placeholder at
request time, so refreshed OAuth credentials take effect immediately. Both
send the selected workspace through `x-org-id`, preserve additional configured
headers, and prevent a configured Authorization header from overriding the
resolved credential. Unknown credential references are not expanded from the
host environment. Reauthentication preserves the existing workspace, and a
failed config fetch fails the connection instead of assigning the public Zen
endpoint to an OAuth session. Admin account responses redact inference keys
and omit configured headers, which may contain credentials.

The inspected deployment used the Console inference root, a token placeholder,
and only the legacy `x-opencode-org-id` header. Its stored errors included
`Workspace selection is required`; its quota snapshot reported unsupported.
These observations establish the configuration and code defects, but do not
prove whether the owner separately has an eligible Go subscription. No paid
inference request, credential rotation, or deployment was performed during the
investigation. The admin API redacts OAuth tokens, so end-to-end authenticated
Console validation requires the updated deployment or a fresh device connection.

Sources:

- [OpenCode Go documentation](https://opencode.ai/docs/go/)
- [Go usage endpoint implementation](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts)
- [Current Console application](https://opencode.ai/console), inspected bundle
  `/console/assets/index-DqlR4WdX.js`: workspace header `x-org-id`, config schema,
  billing and usage routes. This bundle is deployment-specific and can change.
