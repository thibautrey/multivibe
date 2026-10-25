# Open WebUI in Desktop

Select **Open WebUI** in the conversation harness picker. The first selection opens a connection sheet for the server URL, API key and model. After configuration, selection is direct; the card's **Configure connection…** context-menu action reopens the sheet. Root URLs, reverse-proxy prefixes and `/api` or `/api/v1` bases are accepted.

The key must be enabled by the administrator and allow `/api/models`, `/api/v1/auths/`, saved-chat listing and mutation, chat completions and task status. Saving validates the authenticated account and conversation access as well as the selected model.

Desktop synchronizes native active and archived chats, pinned state, titles and the active message branch. The catalog is polled every three seconds and the selected chat every second while the conversation view is open. Failures preserve the cache and show a synchronization error. Remote deletions remove cached entries after a complete successful catalog; unsent drafts are preserved. Identity includes the normalized server URL and authenticated user, so key rotation keeps the chat mapping and changing accounts does not grant access to old chats.

Replies append to the same saved remote chat using its current native branch. A completed reply added in the web client becomes part of the next Desktop request. An unfinished remote reply or a branch change detected while preparing a message prevents overwriting it. Desktop creates new chats on the server, submits `/api/chat/completions` using native function calling and polls saved responses and task status. Open WebUI owns the model's tools and permissions. Renaming, archiving, pinning and deleting chats update the server; deletion is explicitly confirmed as a server action.

Connections are stored separately from LibreChat in private Host files. Credentials are omitted from read APIs and event logs. Redirects are rejected; use HTTPS outside trusted local networks. Text and text documents are supported. Binary uploads, manual compaction, acknowledged remote cancellation and client-side configuration of optional web search, image generation or code-interpreter feature flags remain unavailable.
