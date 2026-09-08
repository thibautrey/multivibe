# Automatic model router and plugin settings API

For the complete SDK, hook coverage, admin endpoints, and migration requirements,
see the [Plugin API reference](plugins-api.md).

The bundled **Automatic model router** is installed disabled. Open Plugins →
Installed → Automatic model router → Settings. Choose a cheap classifier and
an economy, balanced, and advanced model from the configured instance catalog.
Save, then enable the plugin. It immediately exposes `multivibe/autorouter` in
`GET /v1/models` (OpenAI and Codex catalog formats). Disabling it removes the model
without a restart. Built-in plugin updates ship with MultiVibe itself.

```json
{
  "model": "multivibe/autorouter",
  "messages": [{"role": "user", "content": "Explain how a solar eclipse works."}]
}
```

Send this to `POST /v1/chat/completions`, or use `POST /v1/responses` with an
`input` field. Add `stream: true` for SSE. Requests naming actual models are
unchanged. The former `routeModel` setting is ignored and hidden. The virtual
name resolves before capacity admission and is never sent to a provider.
`GET /v1/models/multivibe%2Fautorouter` retrieves its metadata.

JavaScript lifecycle plugins run in the JavaScript inference profile. Native
Rust inference does not execute these hooks; enabling them there is rejected.
WebSocket, compact, rich multimodal and provider-specific features are not
supported by the virtual router. Use an explicit model for those requests and
for verified confidential inference.

Plain first-turn requests without a session ID can be classified. For agentic or
multi-turn work, send `x-multivibe-conversation-mode: multi-turn` and a stable
`session_id` header (Codex `thread-id` is also recognized). Tools imply multi-turn
intent. Use `x-multivibe-conversation-mode: one-off` for independent calls sharing
a client/session identifier. Without a hint, mode remains `unknown`: the router
does not claim to predict future user turns. The plugin never edits messages or
cache keys.

The classifier assesses task difficulty as easy, medium, or hard. Each eligible
new task adds a bounded classifier call, billed and traced for the same application.
Internal classification suppresses recursive routing; other lifecycle plugins
still run. Classifier failure or malformed output uses the configured balanced
model, and that fallback is pinned for an identified conversation. Missing or
incompatible target models return `503 router_not_configured`; unsupported inputs
return a clear `400`. Disabled or unhealthy routers return `404 model_not_found`.

Conversation decisions are bounded in memory (10,000 entries), scoped by
application/session/requested model and invalidated by settings changes, TTL,
or restart. Later turns reuse the selection without another classifier call.
Providers still control cache availability and account affinity. Unknown
continuations return `409 router_affinity_missing`: use the actual model from the
previous response to continue safely. Explicit multi-turn calls without a session
return `400 router_session_required`. Known stateful continuations retain the
pinned model. The plugin does not currently escalate an already pinned task.

Router analytics use the advanced model configured when the decision was made as
the counterfactual price baseline, because the virtual name has no token price.
These are same-token-count estimates, not invoice savings.

## APIs for plugin authors

`GET /admin/modules/models` returns `{ models: [...] }` from the same configured
catalog as the instance model endpoint, under admin authentication. Entries have
`id` and capability metadata, including `is_virtual` for plugin models.
`context.services.listModels()` provides executable provider models to request
hooks; it excludes virtual models to prevent recursive classification. `context.services.complete({ model, messages, max_tokens }, signal)`
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
from `web/src/components/ModelSelect.tsx` (`id`, `value`, `onChange`, `disabled`, optional `excludeVirtual`).
`listPluginModels()` is exported alongside it. Other schema fields render as
strings, numbers, booleans, enums, or JSON editors. Settings pages are host-rendered
from `settingsSchema`; they do not load arbitrary plugin UI scripts.
Save through `PATCH /admin/modules/:id` with `{ "settings": {...} }`.
Disabled plugins retain their manifest so they can be configured before enabling.

Persistent router analytics and isolated plugin storage are documented in
[Plugin storage and sandbox](plugin-storage.md). The first-party router remains a
trusted host built-in; installed third-party modules now run in isolated WASM heaps.
