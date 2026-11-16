# Prompt to hand to a client's Hermes

Paste the block below into the client's Hermes (or give it to whoever runs that
machine). It contains a **one-time enrollment code**, never a long-lived secret:
once the machine enrols, the code is spent. Replace the three placeholders
before sending.

> `{{ENROLLMENT_CODE}}` — a `mvenr_...` code, valid once and for at most 24 hours.
> `{{ENROLL_URL}}` — the enrollment base URL (not the inference URL).
> `{{MODEL}}` — the model name the Hermes already uses (see `LLM_MODEL` in
> `~/.hermes/.env`).
> `{{ACCESS_CLIENT_ID}}` / `{{ACCESS_CLIENT_SECRET_PATH}}` — only when the
> enrollment hostname is gated by Cloudflare Access. The **id** is not secret and
> can sit in this text; the **secret** must be a path to a file on the machine
> (or `-` for stdin), never a value pasted here.
>
> The enrollment code carries the mapping between `{{MODEL}}`, the equivalent
> model on MultiVibe, and the equivalent model on Nous Research. If Nous does not
> list that model, `doctor` fails and the bridge waits instead of substituting a
> different model: a silent downgrade would be worse than a delay.

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

`multivibe.pleiades.solutions` sits behind Cloudflare Access, which is a gate for
*browsers*; this machine is not one. If `doctor` or this command reports
`invalid` while a browser can reach the same hostname, the gate is the reason:
an anonymous exchange is answered with a `302` to a login page, and the bridge
cannot log in because it has no credential yet.

Two deployments answer this. Check which one you are on **before** running the
command above:

- **Enrollment bypassed or on its own hostname** — nothing more to do, run the
  command as written. Do not add Access arguments "just in case": a stray header
  on an ungated surface is noise, not safety.
- **Enrollment gated by Access** — you were given an Access **service token**
  for this machine: a client id and a client secret. Add both:

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
inference request, so the gate needs no further attention from you. If you were
given neither a bypassed hostname nor a service token, stop and ask. Enrolment
cannot succeed without one of them, and guessing wastes a single-use code.

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

In `~/.hermes/.env`, find the block delimited by these exact lines:

```
# >>> MultiVibe Host >>>
# <<< MultiVibe Host <<<
```

Replace what is **between** them with:

```
LLM_PROVIDER=openai
LLM_MODEL={{MODEL}}
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<the value printed by print-key>
```

Keep the two marker lines themselves: MultiVibe uses them to find and rewrite its
own block, and to remove it cleanly on rollback. Everything outside the block is
yours and must stay untouched.

If there is no marker block at all, append one rather than editing an existing
setting — the markers are what make this change reversible.

Back up the file first (`cp ~/.hermes/.env ~/.hermes/.env.before-bridge`) so
returning to the previous configuration is one copy away.

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

Restore `~/.hermes/.env.before-bridge`, stop the bridge service, and point
OpenAI back at your previous endpoint. Nothing else was modified, so nothing else
needs undoing.

## If something fails

Run `multivibe-hermes-bridge doctor --json` and send that output. It contains
model names, HTTP statuses and check results only — never a prompt and never a
credential.
