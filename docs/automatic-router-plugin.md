# Automatic model router and plugin settings API

The bundled **Automatic model router** is installed disabled. Open Plugins →
Installed → Automatic model router → Settings. Choose a cheap classifier and
an economy, balanced, and advanced model from the configured instance catalog.
Optionally restrict routing to one requested model. Save, then enable the plugin.
Settings persist immediately; a restart is unnecessary. Built-in plugin updates
ship with MultiVibe itself.

JavaScript lifecycle plugins run in the JavaScript inference profile. Native
Rust inference does not execute these hooks; enabling them there is rejected.
HTTP Chat Completions and Responses (including SSE) are supported. WebSocket,
compact, rich multimodal payloads and provider-specific features are not routed.

For a single call, send `x-multivibe-conversation-mode: one-off`. For agentic or
multi-turn work, send `x-multivibe-conversation-mode: multi-turn` and the existing
`session_id` header (Codex `thread-id` is also recognized). Tools imply multi-turn
intent. Without an explicit hint the mode is `unknown`; a session ID allows
first-turn routing, but an unidentified request is left unchanged. A first user
message alone cannot prove a conversation is one-off. The plugin never edits
messages or cache keys.

The classifier assesses the overall task as easy, medium, or hard. Each eligible
new task adds a bounded classifier call, billed and traced as ordinary inference
for the same application. Internal classification suppresses recursive routing;
other lifecycle plugins still run. Invalid output, timeout, cancellation, missing
models or incompatible tool support retain the requested model. A classifier's
difficulty estimate is heuristic, not a guarantee of quality or lower total cost.
Review traces to compare classifier overhead and downstream savings.

Conversation decisions are bounded in memory (10,000 entries), scoped by
application/session/requested model and invalidated by settings changes, TTL,
or process restart. Later turns reuse the selection without a classifier call.
This supports cache reuse but providers still control cache availability and
account affinity. Unrecognized continuations keep their requested model, so
clients should retain the returned model after restarts/expiry. Known stateful
continuations retain the pinned model; unknown provider-held state is never
reclassified. The plugin does not currently escalate an already pinned task.

## APIs for plugin authors

`GET /admin/modules/models` returns `{ models: [...] }` from the same configured
catalog as the instance model endpoint, under admin authentication. Entries have
`id` and capability metadata. `context.services.listModels()` exposes that catalog
to request hooks. `context.services.complete({ model, messages, max_tokens }, signal)`
runs non-streaming inference through the instance with recursion suppressed, a
512-token output cap, ordinary admission and provider selection. Pass a bounded
abort signal. Services are optional for compatibility and unavailable in nested
classifier requests. `context.internal` identifies those nested requests.

`context.conversation` provides `phase` (`start`/`continuation`), `mode`
(`one-off`/`multi-turn`/`unknown`), `hasTools`, `stateful`, `sessionId`, and
`messageCount` at `request.received`. These describe observed evidence and hints,
not a prediction of future user behavior. `context.sessionId` is now populated
at that hook too. Hook timeout signals are aborted when their deadline expires.

Declare a settings field using:

```json
{
  "type": "string",
  "format": "multivibe-model",
  "title": "Classifier model",
  "description": "Select a configured inexpensive model"
}
```

The dashboard renders this with the reusable `ModelSelect` component exported
from `web/src/components/ModelSelect.tsx` (`id`, `value`, `onChange`, `disabled`).
`listPluginModels()` is exported alongside it. Other schema fields render as
strings, numbers, booleans, enums, or JSON editors. Settings pages are host-rendered
from `settingsSchema`; they do not load arbitrary plugin UI scripts.
Save through `PATCH /admin/modules/:id` with `{ "settings": {...} }`.
Disabled plugins retain their manifest so they can be configured before enabling.

Persistent router analytics and isolated plugin storage are documented in
[Plugin storage and sandbox](plugin-storage.md). The first-party router remains a
trusted host built-in; installed third-party modules now run in isolated WASM heaps.
