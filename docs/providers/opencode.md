# OpenCode free models

OpenCode restricts its free models to its own client. A direct Zen request, and
even the local server's raw generation endpoint, returns
`429 FreeUsageLimitError` — with a valid OAuth token and from the genuine Bun
runtime. Only a real agent session (session ID, agent instructions, declared
tools, streaming) is accepted.

MultiVibe's optional local adapter therefore runs the official OpenCode **v2
server** and drives a real session per request. It does not impersonate OpenCode
headers, replay fingerprints, strip tools, add pretend tools, select a paid
fallback, or circumvent provider limits. Free allowance remains controlled by
OpenCode; no remaining quota is invented.

## Start the local adapter

Install the official OpenCode CLI **v2.4 or newer**. The adapter starts
`opencode serve` on a private loopback port and authenticates with the password
that server prints at startup. The default executable is
`~/.opencode/bin/opencode` and can be selected with `OPENCODE_BIN`.

Create a private file containing a random local key (at least 24 characters),
then start the service from the repository:

```sh
OPENCODE_BRIDGE_KEY_FILE=/absolute/path/to/private-key \
  node scripts/opencode/runtime.mjs
```

The default address is `http://127.0.0.1:14957` (override with
`OPENCODE_BRIDGE_PORT`). Add it to MultiVibe as an OpenAI-compatible account with
that key and Chat Completions mode. Its model endpoint advertises every
zero-cost chat model the server reports, as `<upstream>-opencode-local`
(`big-pickle-opencode-local`, `deepseek-v4.1-flash-free-opencode-local`,
`flint-40b-free-opencode-local`, …). A macOS LaunchAgent can run the same
command at login. The OpenCode account sign-in integration remains separate and
supports workspace-scoped authorization for direct Console/Go access.

### Environment

| Variable | Purpose |
| --- | --- |
| `OPENCODE_BIN` | OpenCode CLI path (default `~/.opencode/bin/opencode`) |
| `OPENCODE_BRIDGE_PORT` | Loopback port (default `14957`) |
| `OPENCODE_BRIDGE_KEY_FILE` | Required file holding the local API key |
| `OPENCODE_BRIDGE_MODELS` | Optional comma-separated upstream free-model IDs to restrict the catalog |
| `OPENCODE_BRIDGE_TIMEOUT_MS` | Request timeout (default `120000`) |
| `OPENCODE_BRIDGE_WORKSPACE` | Session location, for an attached server |
| `OPENCODE_SERVER_URL` + `OPENCODE_SERVER_PASSWORD` | Attach to an already running v2 server instead of spawning one |

## Contract and limits

- Text conversations, including previous user and assistant turns. They are
  passed as structured text to an OpenCode agent session. This is an
  agent-backed text interface, not a raw model API.
- The adapter rejects images, client-defined tools, structured-output requests,
  and sampling overrides rather than dropping them.
- Tools remain declared in the session (removing them triggers the free-tier
  rejection) with `ask` permissions. A tool request is never approved: the
  adapter interrupts the session and returns `422`.
- `max_tokens` is validated but advisory: the v2 session API has no per-request
  output cap. Advertised catalog limits come from the server; the adapter caps
  them at 32,000 output tokens.
- Streaming is buffered: OpenCode emits the completed text, which the adapter
  wraps in Chat Completions SSE. It is not token-by-token streaming.
- Two simultaneous requests, 256 KiB input, and a 120-second execution timeout.
- A `429 FreeUsageLimitError` is surfaced as a free-tier rejection, not as an
  exhausted token quota, and never triggers a paid fallback. `retryAfter` can be
  several hours; do not retry in a loop.
- Requests use isolated configuration/state/cache directories, no external
  plugins, no MCP servers, no repository context, and the official agent's
  built-in tools. The user's real OpenCode credential store is reused, because
  the free offer is tied to their own account. Temporary sessions are deleted
  after execution; model caches are reusable.

OpenCode states that data sent to free models may be used to improve the model.
See [OpenCode Zen pricing and privacy](https://opencode.ai/docs/zen/).

## Verification

```sh
node --test scripts/opencode/runtime.test.mjs scripts/opencode/client.test.mjs
```

The tests exercise authorization, unsupported-input rejection, model discovery,
session creation, buffered SSE, usage mapping, tool interrupts, cancellation,
timeout, spawn parsing, and cleanup.

A `/v1/models` response alone does not prove access. Verify a real chat through
the Host with a `-opencode-local` model. Raw generation
(`/api/experimental/generate/text`) and direct Zen calls are expected to answer
`429 FreeUsageLimitError`; the adapter deliberately does not use them.
