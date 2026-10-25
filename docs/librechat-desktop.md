# LibreChat in Desktop

Select **LibreChat** in the Desktop harness picker, enter the server endpoint and a LibreChat API key, then click **Charger les agents**, choose an agent and save. The endpoint accepts the server root (including a reverse-proxy prefix) or the complete `/api/agents/v1` base URL. Use HTTPS for servers outside a trusted local network.

The server must expose the [LibreChat remote-agent API](https://github.com/danny-avila/LibreChat/blob/main/api/server/routes/agents/openai.js), enable remote agents and grant the key access to the selected agent. The adapter discovers agents with `GET /api/agents/v1/models` and runs them with `POST /api/agents/v1/chat/completions`. The key belongs to LibreChat, rather than its underlying model provider.

The Host saves the connection in `librechat-connection.json` under its harness-runtime data directory with owner-only permissions. Read APIs, session metadata and event exports omit the key. Leaving the key field empty preserves it only when the normalized endpoint is unchanged. Redirects are rejected. Agent discovery and validation must succeed before a configuration is saved.

Agent tools execute on the LibreChat server. Desktop displays text, reasoning, usage and tool events that the remote completion API exposes. Text documents are included as inline text. Binary uploads, native conversation import, manual compaction, agent editing and acknowledged remote cancellation are unavailable through this adapter.

Desktop retains successful turns privately and supplies that transcript on subsequent requests, including after a Host restart. This preserves conversational text context; it does not resume a LibreChat UI conversation or promise persistent remote tool sessions. Existing Desktop conversations keep their selected agent and endpoint. Changing the connection selects the agent for new conversations; after restart an older conversation requires its original endpoint. An interrupted or incomplete response is failed without automatic retry, since remote tool effects may already have occurred.

The connection is configured on the executing Host, including when Desktop reaches that Host over its SSH bridge. Direct container execution requires a Host inside the container.
