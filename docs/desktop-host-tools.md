# Browser and computer tools supplied by Desktop Host

MultiVibe Desktop supplies its integrated Chromium browser and macOS application
controller to locally supervised harness sessions. The harness keeps its own
reasoning loop, model, tools and conversation history. Host executes graphical
operations and handles consent, macOS permissions, observations and user takeover.

Codex and Claude Code receive a session-specific stdio MCP server. Hermes,
Gemini CLI and registered ACP harnesses receive that server in their ACP session
configuration. OpenCode receives an additional MCP entry in its process
configuration. Pi receives a native extension with the same tool definitions.
Existing user and project configuration is preserved.

The tools are `browser` and `computer` (Pi: `multivibe_browser` and
`multivibe_computer`). They accept `observe`, `navigate`, `click`, `double_click`,
`type`, `key`, `scroll`, `drag` and `back`. `computer` also accepts `list_apps`.
`browser` always targets the embedded Chromium surface. macOS applications use
their bundle identifiers as `target`. Input requires the ID of the latest
observation of that target. Results include text and, when available, an image.

Open the conversation in MultiVibe Desktop before submitting its first turn.
Desktop attaches an ephemeral provider before starting the harness. Tools added
to a previously running harness become available when its process is restarted
and its native session is resumed. No global MCP configuration is modified.

The provider uses the authenticated Host runtime API. Harnesses receive only a
random session capability for a private Unix socket, with no Host admin or model
credentials. Requests and screenshots are held in memory by the bridge. The
harness may retain tool results according to its own native history policy.
Only an active turn can use the capability. At most one graphical conversation
owns the Mac. Stopping a turn or cancelling a tool dismisses pending approval
and releases ownership. Delivered actions are never automatically replayed after
a timeout or disconnect; observe again before deciding what to do next.

The initial provider targets the local macOS Desktop Host. Headless Hosts,
SSH/container targets and externally managed LibreChat/Open WebUI agents do not
receive access to this Mac automatically. Such agents require their own explicit
tool transport and authorization; their model endpoint alone cannot grant desktop
access. A harness must support MCP/ACP or a native tool extension to consume the
capability. Model image/tool support also remains a prerequisite.
