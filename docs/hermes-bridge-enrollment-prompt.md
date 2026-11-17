# Prompt to hand to a client's Hermes

Paste the block below into the client's Hermes (or give it to whoever runs that
machine).

> **This text carries a one-time enrollment code, never a long-lived secret.**
> Once the machine enrols, the code is spent and the rest of this page is inert.
> The Access *secret* is deliberately absent: only the path where it lives on
> that machine appears below, so this document can be forwarded without handing
> out a credential.

### Values for this enrollment

| Item | Value |
|---|---|
| Enrollment code (single use, **≤ 24 h**) | `{{ENROLLMENT_CODE}}` |
| Enrollment base URL (not the inference URL) | `{{ENROLL_URL}}` |
| Model this Hermes already uses (`LLM_MODEL` in `~/.hermes/.env`) | `{{MODEL}}` |
| Cloudflare Access client id (not secret) | `{{ACCESS_CLIENT_ID}}` |
| Path to the Access client secret on this machine | `{{ACCESS_CLIENT_SECRET_PATH}}` |

The enrollment code carries the mapping between `{{MODEL}}`, the equivalent
model on MultiVibe, and the equivalent model on Nous Research. The Nous side is
looked up in Nous's published catalogue at enrollment time; if that model is not
listed, no fallback is recorded and `doctor` says so, rather than the bridge
silently answering with a different model.

---

## Objective

Keep this Hermes exactly as it is — same model, same tools, same memory, same
skills, same MCP servers — but make it run on MultiVibe's machines when they have
room, and on your own Nous Research account when they do not. You should not have
to think about which one served any given message.

**Do not change anything about how Hermes behaves.** The only things that change
are two values in `~/.hermes/.env` and one background service on this machine.

## 1. Enroll this machine

Run:

```
multivibe-hermes-bridge enroll --code {{ENROLLMENT_CODE}} --edge {{ENROLL_URL}}
```

`{{ENROLL_URL}}` is the enrollment endpoint, which is deliberately separate from
the inference endpoint because the machine has no credential yet.

This exchanges the code for this machine's credentials, stores them in the
system secret store (macOS Keychain, or the Linux Secret Service), and writes the
model mapping table. The code cannot be reused; if it has expired, ask for a
fresh one.

### If enrollment is behind Cloudflare Access

`host.example.invalid` sits behind Cloudflare Access. A *service token*
is what lets a machine through — not the absence of a gate. The **same token**
covers enrollment and inference, because both live on that hostname.

Check which situation you are in **before** running the command above:

- **No service token supplied** — the exchange is answered with a `302` to
  `<your-team>.cloudflareaccess.com`, because Access has no credential to
  inspect. This is not an invalid code and not a broken edge. Ask for a service
  token and stop; do not try to work around the gate.
- **Service token supplied** — add both values:

```
multivibe-hermes-bridge enroll --code {{ENROLLMENT_CODE}} --edge {{ENROLL_URL}} \
  --access-id {{ACCESS_CLIENT_ID}} --access-secret {{ACCESS_CLIENT_SECRET_PATH}}
```

The client id is the token's id (the bridge appends `.access` if you omit it).
The secret is read from a **file** or stdin — put it in a temporary file with
mode `0600` first, and delete that file afterwards. Never paste the secret into
this conversation, a shell history, or a chat message: it is a credential for
this machine and it is revocable independently of every other client.

Once enrolled, the same token is stored in the secret store and sent on every
inference request, so the gate needs no further attention from you. That is the
whole point of passing it once: an enrolled machine that did not keep the token
would reach the edge anonymously and every call would be redirected to a login
page.

If you were given no service token, stop and ask. Enrollment cannot succeed
without one, and guessing wastes a single-use code.

## 2. Supply your Nous key locally

Your Hermes already has a Nous Research account. Give the bridge that key
**without copying it anywhere else**. Find where this Hermes keeps it — it is the
same credential it uses today; the usual places are an environment variable in
`~/.hermes/.env`, or the credential store the Hermes was configured with. Then
either:

```
multivibe-hermes-bridge enroll --code {{ENROLLMENT_CODE}} --nous-key <path-to-that-file>
```

or paste it on stdin, which avoids writing the key to any new file:

```
multivibe-hermes-bridge enroll --code {{ENROLLMENT_CODE}} --nous-key -
```

Do not invent a path: if you cannot locate the key, run the enrollment without
`--nous-key` first — inference through MultiVibe still works, and `doctor` will
say plainly that the fallback is unavailable. The key stays on this machine and is
used only for direct requests to `inference-api.nousresearch.com`.

## 3. Install and start the bridge

### Get the binary

The bridge ships inside the MultiVibe Host archive for your platform. There is no
separate download and no installer to compile: pick the asset that matches this
machine from

```
https://github.com/thibautrey/multivibe/releases/latest
```

| This machine | Asset | Contains |
|---|---|---|
| macOS (Apple silicon) | `multivibe-host_<version>_darwin_arm64.dmg` | app bundle |
| macOS (Intel) | `multivibe-host_<version>_darwin_amd64.dmg` | app bundle |
| Linux x86_64 | `multivibe-host_<version>_linux_amd64.tar.gz` | archive |
| Windows | not yet supported; stop and ask | — |

Do **not** install the whole Host if you only need the bridge: the Host runs its
own services and is not required for routing. Extract just what the bridge needs
from the archive you downloaded, and keep it somewhere stable such as
`~/.local/opt/multivibe-host/` — the path is referenced by the login service, so
moving or deleting it later breaks the bridge.

On macOS the app bundle is the archive:
`MultiVibe Host.app/Contents/Resources/app/bin/multivibe-hermes-bridge`.
On Linux the same file is `bin/multivibe-hermes-bridge` at the archive root, and
the installer travels beside it as `install-hermes-bridge.sh`.

Verify the archive before using it, so a truncated download is not mistaken for a
broken bridge:

```
gh attestation verify <archive> --repo thibautrey/multivibe
```

If `gh` is unavailable, at minimum check the file size and that `tar tzf` (Linux)
or `hdiutil verify` (macOS) succeeds.

If `multivibe-hermes-bridge` does not exist in the archive you downloaded, **stop
and report it**: the archive predates the bridge and no amount of configuration
will create the binary. Do not substitute a different tool, and do not build from
source unless you were explicitly asked to.

### Start it at login

For a service that starts at login and restarts on failure, run the installer
**as yourself — never with `sudo`**:

```
./install-hermes-bridge.sh --binary /absolute/path/to/multivibe-hermes-bridge
```

macOS installs a per-user LaunchAgent; Linux installs a systemd user unit. Both
belong to *your* login session, so root's home is the one place they would never
run; the installer refuses to run as root for that reason. To run it in the
foreground instead:

```
multivibe-hermes-bridge run
```

It listens on `127.0.0.1:8787` only.

The binary lives inside the installed MultiVibe Host app, at a path that survives
Host updates, so the service keeps working after one. It does **not** survive
deleting that app: if you remove the Host, run
`./install-hermes-bridge.sh --uninstall` first, or the service will restart into a
missing file.

Then read the key the harness must present:

```
multivibe-hermes-bridge print-key
```

The key is generated on the first start and kept in the system secret store. It
is **stable across restarts**, so the value you write into `.env` keeps working
after an update, a reboot, or a crash. Re-run `print-key` only if the store was
cleared; if it ever prints a different value than `.env` holds, update `.env`
rather than assuming the bridge is broken.

## 4. Point Hermes at the bridge

Back up the file first, so going back is one copy away:

```
cp ~/.hermes/.env ~/.hermes/.env.before-bridge
```

Then let the bridge write its own block:

```
multivibe-hermes-bridge configure --env "$HOME/.hermes/.env"
```

That replaces only the region between

```
# >>> MultiVibe Host >>>
# <<< MultiVibe Host <<<
```

and leaves every other line untouched — tokens, model overrides, dashboard
credentials, anything you have added. It is idempotent: running it twice produces
one block, not two. The file is written atomically at mode `0600`, so an
interrupted run cannot leave a truncated `.env` that reads as "no API key".

**Do not edit this block by hand.** `configure` is the same code path the Host
uses for its own integrations, and a hand edit is the one step in this whole flow
that cannot be verified — a stray newline or a duplicated block breaks the
harness silently, and the symptom later looks like "the model behaves oddly"
rather than "the config is wrong".

If the file already contains an opening marker with no closing one, `configure`
refuses rather than guessing which region to delete. Inspect the file and fix the
block by hand in that case; do not delete regions you cannot delimit.

The model written is the first mapping stored at enrollment. Everything else in
the block is the loopback endpoint and the key from the secret store; neither
needs your attention.

## 5. Verify

```
multivibe-hermes-bridge doctor
```

Every check must pass except, at most, a warning about a missing fallback. Then
run three smoke tests:

1. **Nominal turn.** Ask something simple. The answer must arrive normally and
   the bridge log must show `"upstream":"edge"`.
2. **Forced switch.** Stop the bridge's connection to the edge (or temporarily
   set `--mode nous-only`) and repeat the question. It must still answer, served
   by Nous, with no visible difference to you.
3. **Resume.** Restart the bridge and confirm the conversation continues where it
   left off.

## What not to touch

- **Tools, skills, MCP servers, memory files** — untouched. This change is
  transport only.
- **Model names.** Do not rename the model to make routing work; the mapping
  table handles the translation. A missing mapping is reported, never guessed.
- **The Nous key.** Do not paste it into a chat, an issue, or any request to
  MultiVibe. It is yours and stays local.

## Going back

Restore `~/.hermes/.env.before-bridge`, then stop the bridge service with
`./install-hermes-bridge.sh --uninstall`. Nothing else was modified: the managed
block is the only change to that file, so the copy is a complete rollback.

## If something fails

Run `multivibe-hermes-bridge doctor --json` and send that output. It contains
model names, HTTP statuses and check results only — never a prompt and never a
credential.
