# OpenCode Big Pickle

Big Pickle is a free, limited-availability model. A paid Go subscription is not
required for its free offer. OpenCode currently restricts this offer to its own
client; an authenticated generic API request can return `403 FreeTierError`.
The official client can also trigger that error when its shell tool is removed
([upstream report](https://github.com/anomalyco/opencode/issues/50627)).

MultiVibe's optional local adapter runs the genuine OpenCode v1 CLI and exposes
`big-pickle-opencode-local` through an authenticated loopback Chat Completions endpoint.
It does not impersonate OpenCode headers, add pretend tools to API requests,
select a paid fallback, or circumvent provider limits.

## Start the local adapter

Install the official OpenCode **v1.18.x** CLI. The adapter uses its `run --pure`
JSON event interface; OpenCode v2 has a different CLI and is not supported by
this adapter. The default executable is `~/.opencode/bin/opencode` and can be
selected with `OPENCODE_BIN`.

Create a private file containing a random local key (at least 24 characters),
then start the service from the repository:

```sh
OPENCODE_BRIDGE_KEY_FILE=/absolute/path/to/private-key \
  node scripts/opencode/runtime.mjs
```

The default address is `http://127.0.0.1:14957` (override the port with
`OPENCODE_BRIDGE_PORT`). Add it to MultiVibe as an OpenAI-compatible account,
with that key and Chat Completions mode. Its model endpoint advertises only
`big-pickle-opencode-local`. A macOS LaunchAgent can run the same command at login.
The OpenCode account sign-in integration remains separate and supports
workspace-scoped authorization for direct Console/Go access.

## Contract and limits

- Text conversations, including previous user and assistant turns. The CLI
  receives the conversation as structured text in stdin, under its own agent
  instructions. This is an agent-backed text interface, not a raw model API.
- The adapter rejects images, client-defined tools, structured-output requests,
  and sampling overrides rather than dropping them. OpenCode's tools remain
  present with `ask` permissions; unattended tool calls are not auto-approved.
- Streaming is buffered: OpenCode emits the completed text, which the adapter
  wraps in Chat Completions SSE. It is not token-by-token streaming.
- Two simultaneous requests, 256 KiB input, 120-second execution timeout, and
  output token limit up to 32,000. Rate limiting remains controlled by OpenCode;
  no remaining free allowance is invented.
- Requests use isolated working/configuration/data directories, no external
  plugins, no global provider credentials, and no repository context. Temporary
  session data is removed after execution. Model caches are reusable.
- Token usage includes the official agent's instructions and tools. These can
  substantially exceed the user's message size. A free offer can change;
  errors propagate and no paid model is chosen automatically.

OpenCode states that data sent to Big Pickle during its free period may be used
to improve the model. See [OpenCode Zen pricing and privacy](https://opencode.ai/docs/zen/).

## Verification

```sh
node --test scripts/opencode/runtime.test.mjs
```

The tests exercise authorization, unsupported-input rejection, concurrency,
cancellation, CLI stdin/configuration, cleanup, text replies, and buffered SSE.
A working `/models` response alone does not prove access: verify a real chat
through the Host with `model: "big-pickle-opencode-local"`.
