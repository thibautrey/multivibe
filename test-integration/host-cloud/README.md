# Installed Host ↔ live Cloud lab

This is a **source development installation**, using the real Go Host launcher,
provider agent, updater, Core server, dashboard and bundled Security module.
It is separate from the HTTP contract suite and talks to the public Multivibe
Cloud service. It is not the signed release installer or a production launch gate.
No Ollama runtime or model weights are bundled: this lab tests Cloud consumption,
not local inference, worker enrollment, paid usage, or GPU support.

## Install and run

On Linux amd64, from the Core **main checkout** with Node 22 and Docker available:

```sh
npm ci
npm --prefix web ci
node test-integration/host-cloud/lab.mjs install
node test-integration/host-cloud/lab.mjs start
node test-integration/host-cloud/lab.mjs status
node test-integration/host-cloud/lab.mjs verify
```

The installer builds Core and the actual Host executables (Go build container
pinned by digest), initializes the pinned Security submodule, copies Node and
dependencies into a private installation, and runs Host `doctor` in the supported
CPU profile. It does not change your ordinary Host service, enable system startup,
or download models. Allow about 500 MB plus build caches and installed dependencies.
Node's installed version and Core commit are recorded in `installation.json`.
Use the recorded Core commit and Node version for a replay; `npm ci` uses that
commit's lockfiles. This development bundle intentionally has no release manifest,
so it is not eligible for signed release auto-updates.

Default installation and state:

- `~/.local/share/multivibe-host-cloud-lab/bundle`: installed development Host.
- `data`: persistent private Host credentials, accounts and OAuth state.
- `host.log`: private operational logs, never commit or publish these.
- `verification.json`: sanitized machine-readable result.
- Host listens only on `http://127.0.0.1:18455`.

Set `MULTIVIBE_LAB_DIR` (absolute path outside the checkout) and
`MULTIVIBE_LAB_PORT` to create another independent lab. Keep those settings the
same for every command. Install refuses to overwrite an existing bundle.
Use a fresh directory to rebuild; stop the previous lab first if reusing its port.

```sh
node test-integration/host-cloud/lab.mjs stop
node test-integration/host-cloud/lab.mjs start
```

Stop validates the PID's executable and process start time before signaling it.
It preserves all state so a restart can verify connection persistence.

## New test account and browser journey

Account creation is an explicit manual/live step, never part of `npm test`.
For a disposable mailbox you can use:

```sh
node test-integration/host-cloud/mailbox.mjs create
```

This creates exactly one mailbox on mail.tm and saves generated mailbox/Cloud
passwords in `test-identity.json`, outside Git with mode 0600. Reuse that identity;
the helper refuses to overwrite it. Mailboxes are disposable, so this is unsuitable
for long-lived access or any account with funds. A fresh lab creates a fresh identity.

1. Open the local dashboard using the human-run convenience command below. It
   launches a one-time desktop session link in the VM browser without printing the
   persistent admin token. Browser agents must use their approved browser runtime.
2. Use **Connect MultiVibe Cloud** in the accounts UI.
3. On Cloud, create the account with the lab email and generated Cloud password,
   accept the current terms and complete the email verification.
4. Run `node test-integration/host-cloud/mailbox.mjs check` to check email delivery.
   Subjects/counts are printed; matching verification links are saved privately in
   `verification-links.json`. Open the appropriate link in the same browser.
5. Finish Cloud authorization and return to Host. Verify that Cloud is connected.
6. Run the strict check, restart Host, and rerun the strict check.

```sh
node test-integration/host-cloud/lab.mjs open
node test-integration/host-cloud/lab.mjs verify --require-connected
node test-integration/host-cloud/lab.mjs stop
node test-integration/host-cloud/lab.mjs start
node test-integration/host-cloud/lab.mjs verify --require-connected
```

The strict command exits nonzero unless Host is healthy, anonymous admin access
is denied, Cloud reports connected, an enabled Cloud account is persisted and
Core exposes a model returned by an authenticated request to the real Cloud catalog.
It performs no inference or purchase and prints no credentials or model output.

## Verified result on 2026-09-07

- Source Host installed from Core `dbae362`, Node `v22.18.0`; CPU doctor passed.
- Health 200; anonymous admin request 401; authenticated Cloud status 200.
- Stop/start succeeded with persistent state retained.
- A dedicated mail.tm test mailbox was created.
- **Cloud account creation and connection are not verified.** Automatic approval
  review rejected the browser account-creation action with no detailed reason and
  instructed the agent not to proceed or ask for approval. No alternate transport
  was used to circumvent that rejection.
- Real status remained `disconnected`, with no persisted Cloud account. The
  strict check correctly returned exit code 1. An installed Host is not proof
  of a successful Cloud connection.

The mailbox helper and the live journey require network access and external service
availability. Never publish `test-identity.json`, `verification-links.json`, Host
account files, browser sessions, or raw logs as test artifacts.

## Reuse a previously provisioned Cloud project key

`existing-access.mjs` supports an **existing** project API key without creating a
Cloud account, exchanging OAuth codes, granting credits or issuing another key.
It uses only the public Cloud catalog/inference routes and the local Host admin
API. OAuth connection remains a separate, unverified stage; the dashboard may
still say disconnected when only a project key has been configured.

Use an empty lab. First identify a secret that is explicitly a Cloud test project
key through the secret manager metadata. Never substitute `MULTIVIBE_API_KEY` or
`API_KEY` from a generic internal gateway. The helper only reads the explicit
`MULTIVIBE_CLOUD_TEST_API_KEY` environment variable and sends it to the fixed
`https://api.multivibe.cloud` origin, refusing redirects.

For example, if an operator has already provisioned an OpenBao entry with that
exact field name, invoke the following with its **actual metadata-verified path**:

```sh
openbao-kv exec <existing-cloud-test-secret-path> -- \
  node test-integration/host-cloud/existing-access.mjs configure
node test-integration/host-cloud/existing-access.mjs verify --restart
```

If the field has another name, map it to `MULTIVIBE_CLOUD_TEST_API_KEY` only inside
the same secret-consuming child process. Never print the value or put it in shell
arguments, source, `.env`, or an evidence report. Host persists the existing key
in its ordinary private account store so restart verification is possible.

Configure validates the authenticated remote catalog before any local account
write. It refuses a nonempty lab and never overwrites an existing account. It
initially stores a disabled account, then enables it with Core's Cloud payload
marker. A failed second step leaves the account disabled; use a fresh lab after
investigating that partial configuration. The marker selects the wire contract;
it does not represent OAuth or provider-worker enrollment.

Verify requires the same model to be present in the authenticated Cloud and Core
catalogs. With `--restart`, it checks the persisted account and re-fetches both
catalogs after a real Host stop/start. Only that run reports persistence verified.

A separate, explicit inference command requires a model selected from that
catalog and an existing funded project with a suitable budget:

```sh
MULTIVIBE_CLOUD_TEST_MODEL='<reviewed-low-cost-model-id>' \
  node test-integration/host-cloud/existing-access.mjs infer
```

It requests one short Responses generation through Host, with a 16-output-token
limit and an idempotency key. No automatic model selection, retries, purchases,
subscription changes or credit grants are performed by the helper. The token
limit is **not a USD price cap**; Cloud's existing project budget and model prices
remain authoritative. The result must contain completed assistant text. Prompt,
answer, tokens, upstream error bodies and restart logs are not printed.

Each successful/failed operation after local-state loading writes a sanitized
`existing-access-verification.json`. Exit status is nonzero on failure; a previous
report is not proof that a later preflight succeeded. The helper's four defensive
unit tests are separate from, and do not constitute, real Cloud validation:

```sh
node --test test-integration/host-cloud/existing-access.test.mjs
```

See [existing credential investigation](existing-credential-investigation.md) for
the actual outcome of the metadata inspection and official dev/E2E review.

## Diagnose a production 401 without handling the raw key

Use `python3 test-integration/host-cloud/audit-production.py --require-aligned`
with the existing Kubernetes context. This read-only command compares runtime
peppers across API/identity/billing replicas, checks API/identity database identity,
and lists only the five most recent public key prefixes with expiry/revocation,
creation-event and entitlement-presence evidence. It never prints secret values or
comparison hashes and makes no production mutation or inference request.

See [the measured 401 diagnosis and repair boundaries](production-401-diagnosis.md).

The audit also counts the entire service-key population separately from the
latest-five query. These sequential observations are not an atomic snapshot.
The alignment gate rejects missing workloads, unexpected replica counts and
unready pods, as well as unequal peppers or databases. This detects drift; it
does not prevent independent Secret updates. See [readiness evidence](pepper-sync-readiness.md).

Post-sync: the primary task's 2026-09-07 20:32:08Z audit passed after the bounded
API pepper update and API-only rollout to revision 50. Its fresh user-key catalog
request still returned 401 under the shadow verifier. See the
[post-sync result and proof boundaries](production-401-diagnosis.md).
Alignment is not a successful Host connection or permission to enable inference.
