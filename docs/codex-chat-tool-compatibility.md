# Codex tools on Chat Completions providers

Codex can advertise the hosted Responses `web_search` tool on ordinary coding
turns, including when the user did not request a search. Function-only upstreams
cannot execute this server-side tool. Its presence must not prevent the client
from using its shell, custom tools, namespaces, or MCP tools.

The native Responses-to-Chat bridge handles optional `web_search`,
`web_search_preview`, and `web_search_preview_2025_03_11` declarations by omitting
those hosted tools from the upstream function list and appending a capability
notice to the model instructions. The notice preserves existing instructions,
explains that native search is unavailable, and directs the model to available
client search/browser functions or to disclose the limitation. Success responses
include `x-multivibe-unavailable-tools` in both buffered and streaming modes.
This is a capability fallback, not an implementation of hosted web search.

An explicit selection of hosted search still fails before dispatch. Likewise,
`tool_choice: required` fails when no executable tool remains. Unknown tools
remain errors, now identifying their type and position in the tool list. Native
Responses upstreams retain the original tool contract.

Regression coverage lives in `rust/v1-edge/src/chat_tools.rs` and the z.ai HTTP
round-trip fixture in `rust/v1-edge/src/lib.rs`. Validation on 2026-09-09 also used
the installed Codex binary with the real `glm-5.3` provider: one `exec_command`
printed `CODEX_BRIDGE_OK`, its result returned to the model, and Codex completed
successfully. This was verified against both an isolated candidate and the
installed local service on port 1455; it did not resume the user's layout task.
