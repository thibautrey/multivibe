# ChatGPT Voice with MultiVibe inference on macOS

Codex Desktop's native voice feature requires a real ChatGPT sign-in and the
account's voice permission. Some desktop releases also require the built-in
`openai` provider. A custom `multivibe` provider can therefore hide native voice
even when the gateway supports Realtime.

The supported `openai_base_url` setting keeps the built-in provider and changes
its inference destination. However, that provider sends the ChatGPT OAuth token,
whereas MultiVibe expects its managed application key. The local bridge
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

## Configure through MultiVibe Host

Use **Connect** on the Codex card, or **Repair connection** for an installation
created with the older custom provider. Host starts and supervises the loopback
relay automatically, selects an available private port, persists it for the next
Host startup, and retains its managed model catalogue. No separate service or
manual bridge installation is needed. The relay helper is included in Host
packages for macOS, Windows and Linux.

The card reports whether the local ChatGPT sign-in is ready, expired or missing.
The managed configuration selects file-based Codex credential storage; existing
`auth.json` contents and any keyring entries remain untouched. If sign-in is
needed, use `codex login --device-auth` on this computer. This avoids the hidden
sign-in button in an already-running custom-provider GUI. It is not possible to
create a paid ChatGPT entitlement through the configurator.

Reopen Codex after current tasks finish. The configurator does not restart it.
The exact old configuration is retained for disconnect, and later file edits
block destructive restoration until they have been reviewed. A separately
installed standalone bridge is left running; it can be removed after the
Host-managed connection has been verified.

## Standalone installation on macOS

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
MultiVibe endpoint above. The Host configurator can migrate this standalone configuration to its own
managed listener through Connect or Repair. It preserves the standalone
configuration in the installation backup and does not stop that service.

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

## Exhausted ChatGPT plan with a third-party provider

Codex Desktop locks the composer when the signed-in ChatGPT plan is out of
messages, even while a custom `model_provider` is selected
(openai/codex#59175). The lock comes from `GET /backend-api/wham/usage` on
`chatgpt_base_url`, so it cannot be fixed by the provider response alone.

v1-edge exposes that backend as an optional HTTPS listener
(`BACKEND_RELAY_PORT`, `BACKEND_RELAY_CERT`, `BACKEND_RELAY_KEY`). Point Codex
at it while keeping the real ChatGPT sign-in:

```toml
chatgpt_base_url = "https://<multivibe-host>:1457/backend-api"
```

The relay is mounted only on the TLS listener (`1457`), never on the public
`1455` HTTP listener. It handles `/backend-api`, `/backend-api/` and every
subpath, forwarding method, path, query, headers and body to
`CHATGPT_BASE_URL` with the caller's ChatGPT bearer. Responses are streamed;
redirects are returned to the caller instead of being followed, and the wait
for upstream response headers is bounded by `BACKEND_RELAY_TIMEOUT_MS`
(default 60 s). Each request emits a structured `backend_relay.request` log
with method, path, status, duration and whether the usage payload was
rewritten; tokens and headers are never logged.

It rewrites only an exhausted `/wham/usage` payload: `allowed` becomes true,
`used_percent` 1, credits present, upsell and `rate_limit_reached_type`
cleared. A payload that still has quota is returned untouched, so the usage
display stays truthful. The custom provider keeps `requires_openai_auth =
true`, which preserves the ChatGPT identity and native voice. Official OpenAI
models remain bound to the real plan and will still return a quota error if
selected.

The listener needs a private CA and a server certificate whose SANs match the
host used by Codex. Generate them once (existing files are never overwritten):

```sh
BACKEND_RELAY_SAN=192.168.1.149,multivibe.local,localhost \
  ./scripts/generate-backend-relay-cert.sh
```

The script writes the CA to `BACKEND_RELAY_CA` (default
`/data/tls/ca.pem`) and the server files to `BACKEND_RELAY_CERT`/`_KEY`. Set
`CODEX_CA_CERTIFICATE` on the Codex host to that CA bundle. If the certificate
or key is missing at startup, the supervisor disables the relay and logs the
reason instead of starting a TLS listener that Codex cannot reach.

