# Prompt to hand to a client's Hermes

Paste the block below into the client's Hermes (or give it to whoever runs that
machine). It contains a **one-time enrollment code**, never a long-lived secret:
once the machine enrols, the code is spent. Replace the three placeholders
before sending.

> `{{ENROLLMENT_CODE}}` — a `mvenr_...` code, valid once and for at most 24 hours.
> `{{ENROLL_URL}}` — the enrollment base URL (not the inference URL).
> `{{MODEL}}` — the model name the Hermes already uses (see `LLM_MODEL` in
> `~/.hermes/.env`).
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

For a service that starts at login and restarts on failure:

```
sudo ./install-hermes-bridge.sh --binary /absolute/path/to/multivibe-hermes-bridge
```

macOS installs a per-user LaunchAgent; Linux installs a systemd user unit. To run
it in the foreground instead:

```
multivibe-hermes-bridge run
```

It listens on `127.0.0.1:8787` only. Then read the key the harness must present:

```
multivibe-hermes-bridge print-key
```

The key is generated on the first start and kept in the system secret store. It
is **stable across restarts**, so the value you write into `.env` keeps working
after an update, a reboot, or a crash. Re-run `print-key` only if the store was
cleared; if it ever prints a different value than `.env` holds, update `.env`
rather than assuming the bridge is broken.

## 4. Point Hermes at the bridge

In `~/.hermes/.env`, inside the MultiVibe-managed block, set:

```
LLM_PROVIDER=openai
LLM_MODEL={{MODEL}}
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<the value printed by print-key>
```

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
