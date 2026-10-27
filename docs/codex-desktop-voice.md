# ChatGPT Voice with MultiVibe inference on macOS

Codex Desktop's native voice feature requires a real ChatGPT sign-in and the
account's voice permission. Some desktop releases also require the built-in
`openai` provider. A custom `multivibe` provider can therefore hide native voice
even when the gateway supports Realtime.

The supported `openai_base_url` setting keeps the built-in provider and changes
its inference destination. However, that provider sends the ChatGPT OAuth token,
whereas MultiVibe expects its managed application key. The optional local bridge
in `scripts/codex-desktop-bridge.mjs` translates these credentials without
modifying the signed desktop application or its permission checks.

```text
Codex Desktop -- native voice / account permission --> OpenAI
       |
       +-- inference with local ChatGPT identity --> 127.0.0.1:1459
                                                       |
                                           managed application key
                                                       |
                                                  MultiVibe :1455
```

This preserves ChatGPT Voice; it does not replace its audio service with local
Whisper/Kokoro or reproduce the private GPT-Live protocol. The selected reasoning
model and tool work use MultiVibe's existing routing.

## Install

Requirements: macOS, Node.js 22 or newer, MultiVibe running on `127.0.0.1:1455`,
and an existing managed `[model_providers.multivibe]` entry with its
`experimental_bearer_token` in `~/.codex/config.toml`.

From the checkout:

```sh
node scripts/codex-desktop-bridge.mjs --install
```

The installer backs up the entire config, preserves the model catalogue and
unrelated settings, and selects these root keys:

```toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:1459/v1"
cli_auth_credentials_store = "file"
```

The unused `model_providers.multivibe` entry remains the bridge's application-key
source. The bridge reads it and `auth.json` on each request, so credential rotation
does not require restarting the listener. Installation also copies the helper
into the Codex home and creates the user LaunchAgent
`com.pleiades.multivibe-codex-bridge`. It binds only to `127.0.0.1`.

Sign in to ChatGPT using the desktop's Codex login, or `codex login` with the same
Codex home, then reopen the desktop app when existing tasks are safely stopped.
A stale local `auth.json` does not become valid by changing providers: the bridge
rejects expired tokens. No account permission or rollout flag is overridden.

The installer refuses to replace an existing LaunchAgent or use an occupied
port. `--port 1459` and `--codex-home /absolute/path` can select another local
port or Codex home. The current automatic installer targets only the local
MultiVibe endpoint above. Reinstalling the normal MultiVibe harness may replace
the selected provider; this opt-in bridge configuration must then be reapplied.

## Verification and removal

Run the transport and credential tests with:

```sh
node --test scripts/codex-desktop-bridge.test.mjs
```

Check the LaunchAgent with `launchctl print
"gui/$(id -u)/com.pleiades.multivibe-codex-bridge"`. Its stderr is written to
`~/.codex/multivibe-desktop-bridge.log` without request headers or tokens.

A working installation needs all of these independent observations: Codex
reports ChatGPT authentication, an inference turn reaches MultiVibe and returns
a response, and a native voice session starts with audible input/output.
Transport tests alone do not prove account eligibility or microphone playback.

To undo the setup, boot out the LaunchAgent, compare the current config with the
backup path recorded in `~/.codex/multivibe-desktop-bridge.json`, and restore only
the bridge's three root settings. Preserve any later user edits. The backup
contains the managed application key and must remain private. Remove the bridge
script, settings and LaunchAgent only after the original routing is restored.

Official configuration reference:
[Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).
