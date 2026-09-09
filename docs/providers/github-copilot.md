# GitHub Copilot

MultiVibe signs in through GitHub's OAuth device flow. The saved `refreshToken`
is the long lived GitHub OAuth token; `accessToken` is a short lived Copilot
inference token obtained from `GET /copilot_internal/v2/token`.

Subscription usage comes from `GET https://api.github.com/copilot_internal/user`
using the GitHub OAuth token. MultiVibe reads only the response's
`quota_snapshots.premium_interactions`, `quota_snapshots.chat`, and shared
`quota_reset_date` fields. GitHub reports `percent_remaining`, which is converted
to used percent. Premium interactions are represented as subscription credits
and chat as a monthly allowance, so both can inform account selection.

Unlimited snapshots and the all-zero placeholders returned for some Business
token-billing seats are left without a finite quota window. Missing percentages
are not reconstructed from entitlement or remaining values, and MultiVibe does
not assume plan-specific limits.

This endpoint is an internal Copilot endpoint rather than a documented public
GitHub REST API, so its availability and schema can change. HTTP errors and
malformed payloads remain visible as quota refresh errors.

Sources:

- [GitHub Copilot requests documentation](https://docs.github.com/en/copilot/concepts/billing/copilot-requests)
- [CodexBar Copilot provider source](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Copilot/CopilotUsageFetcher.swift)
- [CodexBar Copilot response fixtures](https://github.com/steipete/CodexBar/blob/main/Tests/CodexBarTests/CopilotUsageModelsTests.swift)
