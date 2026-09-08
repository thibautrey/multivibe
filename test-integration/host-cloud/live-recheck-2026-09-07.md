# Live Host/Cloud recheck — 2026-09-07

This is a partial verification of an installed Host, **not a successful Cloud
end-to-end result**. No simulated provider or HTTP fixture was used for these
observations.

## Observations

- Verification time: approximately 19:46 UTC.
- Installed development Host: Core `dbae36267307c0bc42fdfc9122419172c9edb676`,
  Node `v22.18.0`, CPU profile, separate private lab directory.
- Current source checkout: `efbf7b82e3bc` when verification started. The installed
  bundle is an earlier snapshot; this check does not certify the latest source.
- Local health: HTTP 200 at `http://127.0.0.1:18455`.
- Anonymous admin request: HTTP 401.
- Authenticated local Cloud status endpoint: HTTP 200, `disconnected`.
- Persisted enabled Cloud account: absent.
- `lab.mjs verify --require-connected`: exit **1**, as expected for a disconnected
  Host. HTTP 200 from the local status endpoint is not Cloud authentication.
- Dedicated test mailbox: zero messages at recheck. This does not independently
  establish whether an external account exists.
- Public Cloud OIDC discovery endpoint: HTTP 200. This demonstrates availability,
  not successful signup, token exchange or authenticated inference.
- Stop/start succeeded. SHA-256 comparisons performed privately on credentials,
  account and OAuth state files confirmed all three files unchanged. Neither
  contents nor hashes were printed. This verifies local file persistence only;
  there is no Cloud enrollment whose persistence can be tested.

## Blocking condition

The prior browser account-creation action was rejected with:

> Strict automated review failed. Do not proceed or ask the user for approval.

No more specific review reason is available. This is an execution-control refusal,
not evidence that Cloud rejected the email, that email delivery failed, or that
OAuth is defective. The declined action was not retried through a different
transport, alternate identity, or modified workflow.

OpenBao metadata was checked without displaying credential values. It lists a
MultiVibe API key and a Matomo token, but neither metadata entry establishes an
OAuth session for the new test identity. Existing credentials were not substituted
for the requested new-account journey.

## Result by stage

| Stage | Result |
| --- | --- |
| Isolated development Host installation | Present and running |
| Fresh test mailbox | Present |
| Cloud account creation | Not verified; execution blocked |
| Cloud OAuth connection | Not completed; local status disconnected |
| Local state persistence | Verified across restart |
| Cloud enrollment persistence | Not verified; no enrollment exists |
| Real Cloud model retrieval | Not verified |
| Real inference | Not performed; required account connection unavailable |

Host remains running with its existing private state intact. The reproducible
installation/lifecycle commands are in [README.md](README.md). No subscription,
payment, provider enrollment, model generation or production credential change
was performed during this recheck.
