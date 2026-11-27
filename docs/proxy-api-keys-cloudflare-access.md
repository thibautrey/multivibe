# Cloudflare Access service tokens for dashboard API keys

The dashboard API keys (`mv_...`) and Cloudflare Access are two independent
gates. A client can reach MultiVibe only when Cloudflare accepts its service
token **and** the edge accepts its proxy API key.

By default, both are managed by hand. This optional integration lets the admin
mint a Cloudflare Access service token when it creates an API key, and delete
that token when the key is revoked. Nothing is provisioned automatically: the
feature is off unless explicitly enabled, and each key must opt in.

## What the integration does

Creating a key with the Cloudflare option:

1. `POST /accounts/{account_id}/access/service_tokens` with a deterministic
   name (`multivibe-<application>-<key id>`) and tags
   `managed_by=multivibe`, `application=<application>`.
2. `POST /accounts/{account_id}/access/apps/{application_id}/policies` with
   `decision: "non_identity"` (Service Auth) and an `include` rule that names
   the new token. One policy is created per token, so a key can be revoked
   without touching any other key.
3. The key is persisted with the Cloudflare identifiers only: account id,
   Access application id, policy id, service token id and client id. The
   **client secret is never stored**.

The creation response is the only time the client secret is returned. Save it
then; to recover a lost secret, rotate the token in Cloudflare or revoke the key
and create a new one.

Revoking a key that has a linked token:

1. Deletes the service token first, which immediately cuts access.
2. Deletes the Access policy (best effort; the token is already dead).
3. Deletes the local API key.

If Cloudflare rejects the token deletion, the local key is kept and the request
fails with an explicit error. Deleting the local key first would show "revoked"
while a live credential remains.

If the feature was disabled after keys were linked, revocation is refused so a
live token cannot be forgotten. Delete the token in Cloudflare first, then call
`DELETE /admin/proxy-api-keys/:id?force=true` to remove only the local key; the
response carries a warning that no Cloudflare credential was revoked.

## Configuration

All settings are environment variables. The mapping is intentionally env-only.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_ACCESS_PROVISIONING` | yes | `true` enables the feature. Anything else (including unset) leaves it disabled. |
| `CLOUDFLARE_API_TOKEN` | yes | API token with `Access: Service Tokens Write` and `Access: Apps and Policies Write`. |
| `CLOUDFLARE_ACCOUNT_ID` | yes\* | Cloudflare account containing the Access applications. |
| `CLOUDFLARE_ACCESS_APPS` | yes | JSON map: MultiVibe application name → Access application id. |
| `CLOUDFLARE_ACCESS_TOKEN_DURATION` | no | Cloudflare duration, default `8760h` (one year). |
| `ADMIN_TOKEN` | yes | Required: the admin guard is a no-op without it, and this endpoint can mint Access credentials. The `change-me` compose default does not count. |

\* An entry in `CLOUDFLARE_ACCESS_APPS` may override the account:

```json
{
  "staging-worker": "b1f0c2d3-...-access-app-id",
  "litellm": {
    "applicationId": "8a7d...-access-app-id",
    "accountId": "0123456789abcdef0123456789abcdef"
  }
}
```

Lexical application names must match the key's application exactly.

Example:

```sh
CLOUDFLARE_ACCESS_PROVISIONING=true
CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef
CLOUDFLARE_API_TOKEN=...              # never commit this value
CLOUDFLARE_ACCESS_APPS='{"staging-worker":"b1f0c2d3-0000-0000-0000-000000000000"}'
ADMIN_TOKEN=...                       # never commit this value
```

## Cloudflare prerequisites

- One self-hosted Access **application per exposed app** (dedicated hostname or
  most-specific path). If every app shares one Access application, a token
  opens the whole hostname and per-key scoping is not real.
- The API token needs `Access: Service Tokens Write` and
  `Access: Apps and Policies Write`. With a tag-based policy prepared by hand,
  only the former would be needed, but this implementation creates a policy per
  token and therefore needs both.
- The MultiVibe host needs egress to `api.cloudflare.com`.
- Strict service token authentication (default for Zero Trust organizations
  created on or after 2026-10-05) requires the policy action to be Service Auth;
  the `non_identity` decision is the API representation of that action.

## Security notes

- The Cloudflare API token can mint access credentials. Keep it in the process
  environment only, scope it to the account, and never expose it through the
  admin API.
- The service-token client secret is returned once and not persisted. The admin
  UI displays it in the creation modal only.
- Revocation fails closed: a Cloudflare error keeps the local key so the
  operator can retry instead of losing the only pointer to a live credential.
- If the Access applications or policies are managed by Terraform, exclude the
  `multivibe-*` tokens/policies or import them, otherwise the next apply will
  drift.
- This does not cover the admin surface itself: `/admin/*` must remain behind
  an interactive Access policy. Service tokens must never reach it.
