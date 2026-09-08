# Plugin API reference and migration guide

This is the source-controlled reference for the plugin API implemented in this
checkout. The manifest still uses **`apiVersion: 1`**, but installed plugins now
run in an isolated runtime: this is a compatibility change from unrestricted
Node.js execution, even though the version number has not changed.

- [Changes and migration](#changes-and-migration)
- [Manifest and packaging](#manifest-and-packaging)
- [Hooks and return values](#hooks-and-return-values)
- [Hook context](#hook-context)
- [Conversation evidence](#conversation-evidence)
- [Model discovery and inference services](#model-discovery-and-inference-services)
- [Settings pages and model selector](#settings-pages-and-model-selector)
- [Private SQLite storage](#private-sqlite-storage)
- [Completion telemetry](#completion-telemetry)
- [Admin HTTP API](#admin-http-api)
- [Virtual model](#virtual-model)
- [Runtime limits](#runtime-limits)
- [Working plugin example](#working-plugin-example)

## Changes and migration

| Change | Required action for plugin authors |
| --- | --- |
| Installed plugins execute in separate QuickJS WASM heaps, not the Node host. | Bundle JavaScript dependencies; replace filesystem, network, native-addon, process, and unsupported Node APIs with supported capabilities. There is no unrestricted fallback. |
| `context.storage` supplies private SQLite-backed JSON data and events. | Use it instead of opening a file or database connection. Catch storage/quota failures when persistence is optional. |
| `context.conversation`, `sessionId`, `internal`, and `services` are available at `request.received`. | Feature-detect optional capabilities; distinguish observed history from a prediction about future messages. |
| `services.listModels()`, `complete()`, and optional `completeWithUsage()` use configured instance models. | Use the broker rather than `fetch`; handle missing pricing and cancelled or failed inference. |
| Settings pages render `settingsSchema`; model fields use `format: "multivibe-model"`. | Supply titles/descriptions and save the entire settings object. No custom plugin page scripts are loaded. |
| `request.completed` delivers sanitized, read-only trace telemetry. | Deduplicate with `traceId`; filter `traceKind` for the metric you want. It is not an exactly-once billing event. |
| `/admin/modules/:id/analytics` exposes retained event aggregates. | Record finite numeric metrics with stable event IDs; do not treat rolling totals as lifetime totals. |
| Module views include `execution`; `/admin/modules` includes `inferencePluginsSupported`. | Distinguish installed sandbox code from trusted host built-ins and unsupported inference profiles. |
| Enabling Automatic model router exposes `multivibe/autorouter`. | Clients opt in with that model ID. Explicit models are unchanged; the old `routeModel` setting is ignored. |

JavaScript inference hooks run in the **JavaScript inference profile**. Native
Rust inference does not execute them; enabling plugins through the admin API in
that profile is rejected. An API/schema declaration alone does not mean a hook
runs on every protocol path; see the hook coverage table below.

## Manifest and packaging

A public GitHub plugin repository contains `multivibe.module.json` and its built
JavaScript entrypoint. Installation clones and pins a commit; it does not run a
package installation or build. The repository URL must be public GitHub HTTPS
with an owner and repository, without credentials, query strings, or fragments.
The manifest repository must match the submitted/installed origin. Ship dependencies
as relative JavaScript modules or bundle them into the entrypoint.

```json
{
  "id": "com.example.usage-observer",
  "name": "Usage observer",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Record measured model usage in private plugin storage.",
  "entrypoint": "index.js",
  "repository": "https://github.com/example/usage-observer",
  "hooks": ["request.received", "request.completed"],
  "priority": 100,
  "timeoutMs": 5000,
  "failurePolicy": "open",
  "categories": ["Analytics"],
  "tags": ["usage"],
  "settingsSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean", "title": "Record usage" },
      "preferredModel": {
        "type": "string",
        "format": "multivibe-model",
        "title": "Preferred model",
        "description": "An optional model selection for this plugin."
      }
    }
  },
  "defaultSettings": { "enabled": true, "preferredModel": "" }
}
```

The ID must match `[a-z0-9][a-z0-9.-]{2,127}`. `hooks` must contain supported
names. `author` and `homepage` are optional; homepage must be HTTPS without
credentials. Categories allow up to eight nonempty strings of at most 40
characters; tags allow up to sixteen of at most 32 characters. The entrypoint
and resolved imports must stay inside the checkout.

Export an object as the module's default export or named `module` export. Only
handlers listed in the manifest are invoked. The SDK is defined in
[`src/module-sdk.ts`](../src/module-sdk.ts); TypeScript authors may consume its
types at build time, but installed code must be JavaScript.

## Hooks and return values

| Hook | Value and current execution coverage |
| --- | --- |
| `request.received` | Parsed request body on the JavaScript Chat Completions/Responses proxy path, including supported compact handling. For `multivibe/autorouter`, it runs before admission and is not repeated in the proxy. For ordinary requests, it runs inside the proxy after admission. |
| `request.beforeUpstream` | Provider-ready request payload after model/provider selection and protocol conversion. May run again for retries. |
| `response.received` | Buffered upstream text, which may be JSON or SSE text. Invoked on the implemented buffered response paths; do not assume it transforms live streaming chunks. |
| `response.beforeClient` | Parsed response object on the buffered native Responses-stream-to-JSON path. Not a universal final-response interceptor. |
| `request.completed` | Sanitized completed trace object after persistence, including telemetry from streaming requests. Read-only and best effort. |
| `stream.open` | Accepted hook name, but no current invocation site. |
| `request.error` | Accepted hook name, but no current invocation site. Use completion status telemetry where available. |

There is no general JavaScript hook coverage for WebSocket, Realtime, or native
Rust inference. Do not infer protocol support from the `transport` type alone.

A handler receives `(value, context)` and can return a result or a promise:

```js
return { action: "continue" };
return { action: "replace", value: { ...value, example: true } };
return {
  action: "respond",
  response: {
    status: 400,
    headers: { "content-type": "application/json" },
    body: { error: { message: "Request rejected by plugin" } }
  }
};
```

`replace` replaces the whole value; it is not a patch. Return the same kind of
value the hook receives (for example, text from `response.received`). Mutating a
local copy without returning `replace` does not update the request.

The request hooks and implemented `response.beforeClient` path honor `respond`.
Current `response.received` callers use only the returned value: do not rely on
`respond` there. `request.completed` ignores both replacement and response results;
one observer cannot rewrite the telemetry supplied to another observer.

Enabled, healthy plugins run in increasing `priority` order (default 100), then
by ID. Settings and values are copied for each invocation. Installed-plugin calls
are serialized within that plugin's runtime. Timeouts default to 5,000 ms and are
clamped to 10–60,000 ms. Capabilities are revoked on hook completion or timeout.

An uncaught error/timeout marks the plugin unhealthy and closes its sandbox.
`failurePolicy: "open"` (default) continues processing; `"closed"` propagates the
failure to the caller. Completion-observer failures cannot change a finished
HTTP response. Disable and re-enable an unhealthy plugin to reload it. Catch
expected transient failures inside the handler when they should not disable it.

## Hook context

| Field | Meaning |
| --- | --- |
| `requestId: string` | Correlation ID for the client request. Multiple provider attempts can share it. |
| `route: string` | Current route, commonly `/responses` or `/chat/completions`. |
| `transport: "http" \| "sse" \| "websocket"` | Transport reported by the invocation site; not a guarantee that all values have hook coverage. |
| `settings: Readonly<Record<string, unknown>>` | Copied settings snapshot for this invocation; the top-level object is frozen. |
| `signal` | Host-enforced cancellation/deadline. Sandbox guests get `aborted` and `throwIfAborted()`, not a full DOM `AbortSignal`. |
| `log.info/warn/error(message)` | Host-prefixed logging. In the sandbox these are asynchronous bridge operations; await them when completion matters. |
| `storage?` | Plugin-bound data/event capability, supplied by the manager for managed hook calls. Optional in the SDK for compatibility with other hosts/tests. |
| `sessionId?` | Session identifier when available. Now populated at `request.received`, and also on the implemented upstream/response hooks. |
| `application?` | Request application identity when available. |
| `provider?`, `model?` | Selected upstream details when known; not necessarily present at `request.received`. Inspect `value.model` there. |
| `conversation?` | Conversation evidence at `request.received`. |
| `internal?` | At `request.received`, identifies nested plugin inference, for which services are omitted. Do not assume it is populated on later hooks. |
| `services?` | Model discovery/inference broker at non-internal `request.received`; omitted on later hooks and nested classifier requests. |

Do not retain a context capability to use after the hook returns. Await work
before returning. Guest code has no ambient `process`, `require`, filesystem,
network, timer, or full Web API environment.

## Conversation evidence

```ts
type ModuleConversation = {
  phase: "start" | "continuation";
  mode: "one-off" | "multi-turn" | "unknown";
  hasTools: boolean;
  stateful: boolean;
  sessionId?: string;
  messageCount: number;
};
```

- `phase` is `continuation` when there is a `previous_response_id`, more than one
  user message, assistant/tool history, function-call or tool-result items, or
  tool-use/result content blocks. Otherwise it is `start`.
- `mode` honors `x-multivibe-conversation-mode: one-off` or `multi-turn`. Without
  either recognized value, a nonempty `tools` array implies `multi-turn`; otherwise
  it is `unknown`. Invalid hints do not prove one-off intent.
- `stateful` is true for `previous_response_id` or `conversation` in the body.
- `messageCount` counts `messages` or array `input` items, or one for string input.
- Session lookup accepts `session_id`, `session-id`, `x-session-id`, or
  `x-session_id`, with Codex session extraction (including `thread-id`) as fallback.

These are observed evidence and client hints, not knowledge of future user
behavior. A first user message by itself does not establish a one-off task.

## Model discovery and inference services

```ts
services.listModels(): Promise<ModuleModel[]>;
services.complete(input, context.signal): Promise<string>;
services.completeWithUsage?(input, context.signal): Promise<{
  text: string;
  model: string;
  costUsd?: number;
}>;
```

`listModels()` returns configured executable provider models and aliases, with
`id` and metadata such as `supports_tools` and nullable `context_window`. It does
not add the router's virtual model. Check availability and the capabilities your
request needs; a model's presence does not guarantee free capacity or successful
inference.

Both completion methods accept:

```js
const input = {
  model: "a-model-id-from-listModels",
  messages: [
    { role: "system", content: "Return only a short classification." },
    { role: "user", content: "Classify this task." }
  ],
  max_tokens: 80
};
```

The broker uses local non-streaming Chat Completions with the same application,
normal admission/provider selection, and output tokens clamped to 1–512. Nested
requests have `internal: true` and no services at `request.received`, preventing
recursive router classification. Other hooks still run. Calls incur normal
inference cost. Network errors, non-success responses, unconfigured models, or
missing text can reject; catch them and honor the hook deadline.

In a sandbox the second signal argument is a compatibility parameter: the host
uses the active hook's signal. A guest-created signal cannot extend that deadline.
`completeWithUsage` is optional. `costUsd` is an estimate from reported usage and
known pricing, not a provider invoice; absent cost means unknown, not zero. It
reflects the returned completion and does not guarantee accounting for unreported
failed/retried classifier attempts.

## Settings pages and model selector

The installed plugin's **Settings** page renders `settingsSchema.properties`:

| Schema field | Dashboard behavior |
| --- | --- |
| `title`, `description` | Field label and help text. |
| `type: "string", format: "multivibe-model"` | Configured-model dropdown. Empty selection is `""`; a saved unavailable ID remains visible as unavailable. |
| `type: "boolean"` | Checkbox. |
| String `enum` | Select control. |
| `type: "integer"` or `"number"` | Numeric input; supports minimum/maximum and integer steps. |
| `type: "object"` or `"array"` | JSON editor. |
| Other string fields | Text input. |
| `deprecated: true` | Hidden in the page; retained saved data is not automatically removed. |

Disabled plugins retain their manifest and can be configured before enabling.
`defaultSettings` initializes a new installation. `PATCH` settings **replace the
entire settings object**, not individual fields; defaults are not re-merged on
save. Already running hooks keep their copied snapshot.

The current server validator is a small JSON Schema subset: root object type,
provided property types, enum membership, numeric bounds, and
`additionalProperties: false`. It does **not** implement `required`, nested schema
validation, model-ID availability validation via `format`, or a full JSON Schema
engine. Validate semantic requirements in your plugin and handle missing fields.

For dashboard contributors, the reusable exports are in
[`web/src/components/ModelSelect.tsx`](../web/src/components/ModelSelect.tsx):

```tsx
<ModelSelect
  id="preferred-model"
  value={selectedModel}
  onChange={setSelectedModel}
  disabled={saving}
  excludeVirtual={true}
/>
```

`listPluginModels()` returns the admin model catalog. `excludeVirtual` defaults
to false and filters displayed options marked `metadata.is_virtual`; the router
uses it to avoid selecting itself as a classifier or target. The component is
host React code, not a component loaded into the sandbox. No custom settings-page
script registration or public plugin UI bundle API is currently provided.

## Private SQLite storage

Each plugin gets a host-bound database identity derived from its ID and canonical
repository origin. No path, plugin-ID selector, SQL string, or connection handle
is exposed to the guest. Shipped built-ins use a separate built-in owner identity.

| Method | Contract |
| --- | --- |
| `get(key)` | Parsed JSON value, or `null` when absent/expired. A stored JSON null is also returned as null. |
| `set(key, value, ttlSeconds?)` | Upsert a JSON value. Optional TTL is finite and between 1 and 31,536,000 seconds; omitted TTL persists until replaced/deleted. |
| `delete(key)` | Remove a key; returns no value. |
| `list(prefix?, limit?)` | Sorted matching key names. Defaults: empty prefix, 100 keys. Literal prefix matching, not SQL patterns. No pagination cursor. |
| `recordEvent({id, type, data?, metrics?})` | Atomically insert an event and prune retention. Duplicate IDs within the retained window are ignored. Host supplies timestamp. |
| `readEvents(type?, limit?)` | Newest inserted events first, optionally filtered by exact type. Defaults to 100. Each record has `id`, `type`, `at`, `data`, and `metrics`. `at` is Unix milliseconds. |

All methods return promises. `data` defaults to `{}`; `metrics` defaults to `{}`
and must contain finite numbers. Event IDs are unique across event types in that
plugin's retained database window. There is no public transaction, increment,
arbitrary SQL, custom-table, export, reset, or data-purge API.

Keys and event IDs/types: 256-byte maximum, nonempty. JSON values, event data,
and event metrics each have a 64 KiB serialized limit. There are at most 10,000
live keys, a rolling 10,000-event window, and a 64 MiB SQLite page quota. List/event
read limits must be integers from 1 to 1,000. Quota and database failures reject.

Files are created lazily at
`MODULES_PATH/data/<identity-hash>/state.sqlite`; directories use 0700 and files
0600. Data survives disable, restart, update, and uninstall. Reinstalling from the
same canonical repository restores it; another origin reusing the ID gets a
separate store. Administrators and trusted host code can access files: this is
plugin isolation, not encryption against the operator. See
[storage operations and sandbox details](plugin-storage.md) for backups/retention.

## Completion telemetry

`request.completed` receives this JSON-compatible shape (optional values may be
omitted):

```ts
{
  traceId: string;
  traceKind?: "diagnostic" | "upstream-attempt" | "client-request";
  model?: string;
  status: number;
  usageStatus?: "measured" | "missing";
  costUsd?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensInputCached?: number;
  tokensInputCacheWrite?: number;
  latencyMs: number;
  pricingVersion?: string;
}
```

Notifications require a client request ID and trace status >= 200, and happen
after persistence. They are **per trace**, not per request: retry attempts,
client outcomes, and diagnostics can share `context.requestId`. Filter
`traceKind === "upstream-attempt"` for provider usage and deduplicate with
`traceId`. Do not sum client-request and attempt traces as independent spend.
The hook also carries `application`, `route`, actual `model`, and `http`/`sse`
transport when known, but no services or conversation context.

Raw prompts, response bodies, headers, account IDs/emails, credentials, and session
IDs are omitted from this telemetry delivery. A request's normal lifecycle hooks
can still inspect their own payloads. Returning a replacement cannot alter the
completed response or the telemetry seen by another observer.

Delivery has a 5-second host signal and at most 256 pending observer notifications.
Overload, crashes, missing trace correlation, or unhealthy/disabled plugins can
leave gaps. This is not a durable queue, replay interface, or billing ledger.
Unknown token counts/prices must remain unknown; do not turn absent costs into
zero savings.

## Admin HTTP API

These are dashboard/admin endpoints. When admin authentication is configured,
use an admin session, `x-admin-token`, or Bearer admin token. An ordinary inference
API key is not an admin credential. Sandboxed plugins cannot directly fetch these
endpoints; use their bound capabilities.

| Method and path | Request / success response |
| --- | --- |
| `GET /admin/modules` | `{ inferencePluginsSupported, modules, marketplace }`. |
| `GET /admin/modules/models` | `{ models: [...] }`, including enabled virtual models in the supported profile. |
| `GET /admin/modules/:id/analytics` | `{ retention: 10000, types: { [eventType]: { count, metrics } } }`. Metrics are sums over retained events. |
| `POST /admin/modules/submit` | `{ "url": "https://github.com/owner/repo" }` → 201 `{ marketplaceModule }`. Validates a temporary checkout; does not install/run it. |
| `POST /admin/modules/install` | Same URL body → 201 `{ module }`. New external plugins start disabled and require restart before loading. |
| `POST /admin/modules/:id/update` | → `{ module }`; pins an updated checkout, requiring restart. Host built-ins update with MultiVibe and reject this operation. |
| `PATCH /admin/modules/:id` | `{ "settings": {...} }` or `{ "enabled": true/false }` → `{ module }`. Save settings first, then enable. |
| `DELETE /admin/modules/:id` | → `{ "ok": true }`. External plugin must be disabled; bundled plugins cannot be removed. Retained data is not purged. |

IDs in path segments should be URL-encoded. Manager unavailability generally
returns 503. Mutation errors return 400 with `{ error: "message" }`; the analytics
route returns 404 for lookup/summary errors. The settings/enable PATCH is not a
transaction: if both are supplied, enable is processed before settings validation.
Use separate calls to avoid partial changes.

A module view contains `id`, `origin`, `commit`, `enabled`, `settings`, `source`
(`external`/`bundled`), optional `restartRequired` and `manifest`, `loaded`,
`healthy`, optional `error`, `removable`, and
`execution: "wasm-sandbox" | "host-builtin"`. Healthy/loaded does not prove that a
plugin's configured models are available. Marketplace entries contain `id`,
`origin`, `commit`, `submittedAt`, and `manifest`.

```json
{
  "retention": 10000,
  "types": {
    "usage": {
      "count": 2,
      "metrics": { "inputTokens": 1200, "outputTokens": 160 }
    }
  }
}
```

The analytics summary intentionally omits raw event data. Plugins can read their
own events through storage. Dashboard aggregates cover retained events, not an
aligned billing cohort or a lifetime total.

## Virtual model

Automatic model router exposes **`multivibe/autorouter`** only while enabled,
loaded, healthy, and not awaiting restart. It appears immediately in `/v1/models`
(`data` and native Codex `models` arrays); retrieval accepts
`/v1/models/multivibe%2Fautorouter`. Entries use `owned_by: "multivibe"`,
`metadata.is_virtual: true`, `metadata.plugin_id`, and `catalog_source: "plugin"`.
Enabling an unconfigured plugin can expose the name, but inference then returns
a configuration error. Disabling removes it without waiting for provider discovery
cache expiry. The admin model catalog includes it too.

There is **no general manifest field or guest SDK function for registering
virtual models yet**. This model is registered by host code for the shipped
router. `ModelSelect` supports virtual entries for client-side selection, while
router settings exclude them to prevent recursion.

Use the virtual name with HTTP Chat Completions or Responses, including SSE.
It resolves to a configured model before capacity admission; the virtual name
is not forwarded upstream. Explicit model requests are untouched. Stable session
IDs preserve the first selection for multi-turn work. The balanced model is the
fallback for a failed classifier when safe. Lost continuation affinity does not
silently pick another provider.

| Status / code | Meaning |
| --- | --- |
| 404 `model_not_found` | Router disabled, unhealthy, or not loaded. |
| 503 `router_not_configured` | Missing classifier/targets, unsupported target tools, or recursive configuration. |
| 503 `router_unavailable` | Missing services, failed resolution/catalog lookup, or another routing failure without safe fallback. |
| 503 `router_cancelled` | Classification was cancelled on the corresponding resolution path. |
| 400 `router_session_required` | Explicit/implied multi-turn request lacks a stable session ID. |
| 409 `router_affinity_missing` | Unknown continuation/provider-held state; continue with the actual model returned previously. |
| 400 `unsupported_router_endpoint` | Unsupported endpoint, such as compact. |
| 400 `unsupported_router_payload` | Unsupported rich input/provider-specific features. |
| 400 `router_context_limit` | Classification/target context limits exceeded. |
| 400 `unsupported_router_privacy` | Use an explicit model for verified confidential inference. |

The configured advanced model at decision time is the analytics price baseline:
the virtual name has no price. Known classifier and failed-attempt costs are
deducted; absent costs are reported as unknown. Comparisons hold observed token
counts/cache use fixed and therefore are estimates, not invoice savings. See
[router setup and request examples](automatic-router-plugin.md).

## Runtime limits

| Resource | Current limit |
| --- | --- |
| Guest heap / stack | 32 MiB / 512 KiB per installed plugin. |
| Module initialization | 2-second interrupt deadline; no top-level await. |
| Source files | 1 MiB per file, 8 MiB cumulative loader reads. |
| Imports | Relative `.js`, `.mjs`, or `.cjs` paths inside the checkout, interpreted as ES modules; no CommonJS `require`. |
| Hook duration | Manifest timeout, default 5 seconds, clamped to 10 ms–60 seconds; context cancellation can be earlier. |
| Per-plugin queue | 100 hook invocations. |
| Host bridge calls | 1,000 per hook. |
| Serialized hook / bridge messages | 16 Mi / 4 Mi JavaScript string code units, respectively. |
| Host logging | Messages truncated to 2,000 characters in sandbox dispatch. |

Only `node:crypto` has a limited compatibility adapter:
`randomBytes(1..4096)` returns a `Uint8Array`, and
`createHash("sha256").update(stringOrBytes).digest("hex")` supports chained
updates. It does not expose Node objects or the full crypto module. The bundled
Security plugin uses this adapter. No arbitrary host object is passed through
the JSON bridge. Unsupported imports fail closed, and runaway code is interrupted.

## Working plugin example

Save this as `index.js` alongside the manifest above. It uses no Node imports and
records usage without persisting prompt/response content:

```js
export default {
  async "request.received"(body, context) {
    if (!context.settings.enabled || context.internal || !context.storage) {
      return { action: "continue" };
    }
    try {
      await context.storage.set(`request:${context.requestId}`, {
        requestedModel: body.model,
        phase: context.conversation?.phase ?? "unknown",
        mode: context.conversation?.mode ?? "unknown"
      }, 86400);
    } catch {
      await context.log.warn("Could not save request metadata");
    }
    return { action: "continue" };
  },

  async "request.completed"(trace, context) {
    if (!context.settings.enabled || !context.storage ||
        trace.traceKind !== "upstream-attempt" ||
        trace.usageStatus !== "measured") {
      return { action: "continue" };
    }
    try {
      const request = await context.storage.get(`request:${context.requestId}`);
      if (!request) return { action: "continue" };
      const metrics = {};
      if (typeof trace.tokensInput === "number") metrics.inputTokens = trace.tokensInput;
      if (typeof trace.tokensOutput === "number") metrics.outputTokens = trace.tokensOutput;
      if (typeof trace.costUsd === "number") metrics.estimatedCostUsd = trace.costUsd;
      await context.storage.recordEvent({
        id: `usage:${trace.traceId}`,
        type: "usage",
        data: { model: trace.model, status: trace.status },
        metrics
      });
    } catch {
      await context.log.warn("Could not record usage analytics");
    }
    return { action: "continue" };
  }
};
```

Do not fire-and-forget storage/logging/inference promises. Test failure paths,
missing context capabilities, incomplete usage, duplicates, and quota exhaustion
before enabling the plugin in a live instance.
