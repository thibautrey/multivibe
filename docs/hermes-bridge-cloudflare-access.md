# Cloudflare Access for the Hermes bridge

`host.example.invalid` sits behind Cloudflare Access. The bridge is a
machine, not a person, so it authenticates with a **service token**, never a
browser session. This document is the operator runbook; the code side is already
complete and expects exactly these headers.

## Why a per-client token

One shared token would mean every client's traffic is indistinguishable, so a
single leak would grant all of them access. A token per machine, bound to one
Access policy and revoked independently, keeps blast radius at one host and makes
`proxy_api_keys` attribution meaningful.

## Service tokens are the answer, for enrollment too

A `302` to `<team>.cloudflareaccess.com` means only one thing: Access received no
credential to inspect. It does **not** mean service tokens cannot work. Verified
on the live deployment:

| Request to `/health` | Result |
|---|---|
| no token | `302` |
| fabricated token | `302` (`service_token_status: false`) |
| real service token | `200` |

The `302` cannot distinguish "no token" from "wrong token", because in both cases
Access examined nothing — which is exactly why it must not be read as "tokens are
impossible here".

Enrollment therefore uses a service token like every other call. The bridge sends
the same pair for the exchange and for inference, and persists it at enrollment
so later turns are not anonymous. No bypass policy and no second hostname are
required.

What *is* required is one Access application policy with action **Service Auth**
covering the hostname, plus one service token per client machine. If that policy
is missing, the hostname demands interactive login and no machine can pass:
`service_token_status` stays `false` no matter what the client sends.

A bypass policy or a dedicated unprotected enrollment hostname remain valid
alternatives, but they are optional hardening, not a prerequisite. Do not open
`/v1/*` under any of them: that removes the gate from the surface that matters.

Configure the enrollment URL on the client with `--edge` at enroll time, or by
writing `edgeBaseUrl` into the bridge config.

The full operator flow — issue a code, render the prompt, offboard a machine — is
in `docs/hermes-remote-capacity.md`, section "Onboarding a client".

## Create the application

1. Zero Trust → **Access → Applications → Add an application → Self-hosted**.
2. Name: `MultiVibe inference (service)`.
3. Public hostname: `multivibe`  (example), domain `example.invalid`, path **`v1`**.
   Verified: today the whole hostname returns `302`, so this path-scoped
   application is a **change** to make, not a description of the status quo.
4. Session duration: irrelevant for service tokens; leave the default.
5. **Do not** add an identity-provider rule that requires interactive login.
   Instead, under **Policies**, add one policy:
   - Name: `hermes-bridge-<client>`
   - Action: **Service Auth**
   - Include → **Service Token** → the token created below.

The existing human policies stay attached to their own applications; this is
additive. Until the path-scoped application exists, `doctor` will report a
credential failure — which is the honest answer.

## Create a service token per client

Zero Trust → **Access → Service Auth → Create Service Token**, name
`hermes-bridge-<client>`. The client id and secret are shown **once**.

Provision them **out of band**, before enrolment: create the token in the
dashboard, then hand the client its id in the prompt and its secret in a `0600`
file on that machine. The enrollment exchange does **not** mint them — it issues
only the edge API key, because Access tokens are per-host infrastructure that must
exist before the machine can reach a gated surface at all. Putting one in the
exchange response would also mean storing a Cloudflare credential in the edge's
store, where it does not belong.

The prompt therefore carries only the `mvenr_` code plus the client id; the
client passes the pair with `--access-id` / `--access-secret`.

The bridge sends them as:

```
CF-Access-Client-Id: <client id>.access
CF-Access-Client-Secret: <client secret>
```

`doctor` treats a `302` to `cloudflareaccess.com` as a credential failure, so a
missing policy fails loudly instead of appearing as ordinary latency.

## Rotation and revocation

| Event | Action |
| --- | --- |
| Routine | Rotate every 90 days: create the new token, deploy it, then delete the old one. Overlap is safe: a client uses exactly one pair. |
| Offboarding | Delete the service token **and** the client's `proxy_api_keys` entry. Either alone leaves a usable path. |
| Suspected leak | Delete the token first; the edge then refuses that identity immediately. Rotate the `proxy_api_keys` entry as well, because a leaked token alone cannot reach inference without a key. |

## Defence in depth

The Access policy is not the only gate. Add a WAF rate-limiting rule on
`/v1/*` keyed by `CF-Access-Client-Id`, as a bound that survives a policy
mistake. Access decides *who*; the WAF bounds *how much* even for a legitimate
identity.

## Verifying whether it is fixed

`doctor` answers the question directly. It posts a deliberately invalid code to
the exchange path and reads the *redirect*:

```
multivibe-hermes-bridge doctor
```

| Result | Meaning |
| --- | --- |
| `enrollment surface: ok (HTTP 401)` | The path is reachable; the bad code was refused, which is correct |
| `enrollment surface: Access intercepts enrollment...` | Still gated — apply the Bypass policy or the separate hostname |

Verified on 2026-11-16 against the live hostname: the second line, with a redirect
to `cloudflareaccess.com` carrying `service_token_status:false`. That is the
current state, not a guess.

## Verifying

From the client machine, with the token installed:

```sh
multivibe-hermes-bridge doctor
```

Expected: `edge reachability: ok` with a model count, and every mapping `ok`.
A `302`, `401`, or `403` means the token is not attached to the policy, or the
policy does not cover the requested path.

A quick manual check, which must return JSON rather than HTML:

```sh
curl -sS -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
  -H "Authorization: Bearer $EDGE_API_KEY" \
  https://host.example.invalid/v1/models | head -c 120
```

HTML means Access answered instead of the edge; JSON with `401` means Access let
you through and the *API key* is wrong — a different fix.

## What this does not cover

The admin surfaces (`/admin/*`) are deliberately outside this application. They
keep the existing interactive Access policy, because an operator is a person and
a service token must never reach them.

## Current verified state (2026-11-16)

Every path on the hostname answers `302` to the Access login **when no token is
presented**, including `/hermes-bridge/enrollment/exchange`. That is expected
behaviour for a protected host and is not by itself evidence that `/v1/*` is
misconfigured.

Two facts to establish in the dashboard, neither of which can be read from here:

1. **Does a `/v1/*` Service Auth application already exist?** A sibling service's
   notes record that one was created to grant a `translation` token access to
   `host.example.invalid/v1/*`. If it does, inference is already reachable
   with a service token and only the enrollment surface is missing.
2. **Is the enrollment path covered by any Bypass policy?** The `302` on
   `/hermes-bridge/enrollment/exchange` says no.

The enrollment gap is the real blocker: a machine must exchange its code *before*
it holds any token, so that one path cannot be gated by the same policy. The code
is complete; the Access configuration described above has not been verified as
applied.

For dashboard API keys, the admin can optionally mint and revoke a service token
with the key itself. That flow, its environment variables and its failure
semantics are documented in
[`docs/proxy-api-keys-cloudflare-access.md`](proxy-api-keys-cloudflare-access.md).
