# Plugin sandbox, SQLite storage, and analytics

For the complete SDK, hook coverage, admin endpoints, and migration requirements,
see the [Plugin API reference](plugins-api.md).

Installed JavaScript plugins now execute in a dedicated QuickJS WebAssembly
runtime per plugin. The host does not `import()` installed code into Node.js.
Only shipped host built-ins (currently the automatic router) execute as trusted
application code. Installing a plugin with a matching name cannot grant built-in
execution privileges.

Each plugin receives `context.storage`, bound by MultiVibe to its installed ID
and canonical repository origin. A plugin cannot supply another plugin's ID,
select a database path, execute SQL, attach a database, or obtain a connection
handle. A different repository reusing an uninstalled plugin's ID gets a separate
empty database. Updates of the same repository retain its data.

SQLite files live in `MODULES_PATH/data/<identity-hash>/state.sqlite`. Directories
are mode 0700 and databases 0600. Files are host-owned and never exposed inside
the guest runtime. Administrators and the MultiVibe process can access these
files; this is plugin isolation, not encryption against the operator.

## API

```js
export default {
  async "request.received"(body, context) {
    await context.storage.set("preferences", { sampleRate: 0.1 });
    const preferences = await context.storage.get("preferences"); // null if absent
    await context.storage.set("temporary", { value: 42 }, 3600); // TTL in seconds
    const keys = await context.storage.list("temp", 100);
    await context.storage.delete("temporary");
    await context.storage.recordEvent({
      id: `decision:${context.requestId}`, // duplicate IDs are ignored
      type: "routing.decision",
      data: { model: body.model },
      metrics: { decisions: 1, estimatedDifferenceUsd: -0.002 }
    });
    const recent = await context.storage.readEvents("routing.decision", 100);
    return { action: "continue" };
  }
};
```

Values must be JSON and at most 64 KiB each. Key/event identifiers are limited
to 256 bytes. Metrics must be finite numbers. There are at most 10,000 live keys,
a rolling 10,000-event window, and a 64 MiB SQLite page quota per plugin. Reads
return at most 1,000 rows. TTL expiry is enforced on reads and reclaimed on writes.
Operations use host-prepared SQL and each event insertion/retention prune is atomic.
Plugins should catch storage errors so full or unavailable storage does not block
inference. These APIs intentionally do not expose arbitrary SQL or custom tables.

Data survives disabling, restarting, updating, and uninstalling. Reinstalling
from the same canonical origin restores it. Back up `MODULES_PATH/data` with the
rest of the instance. Uninstall does not silently delete analytics; an operator
can remove retained files while the service is stopped.

## Sandbox compatibility

This replaces the old unrestricted execution model. There is no insecure fallback
when a module cannot load. A sandbox-compatible plugin is JavaScript with relative
ES module imports within its own checkout. Parent traversal, symlinks escaping the
checkout, arbitrary filesystem reads, network calls, native addons, processes,
`require`, and Node globals are unavailable. Bundle dependencies into the plugin.
Top-level await is unsupported. A small `node:crypto` compatibility module supports
`randomBytes(1..4096)` as a Uint8Array and `createHash("sha256")` with chained
`update(string|Uint8Array)` and `digest("hex")`; it preserves the bundled Security
plugin's pseudonymization without exposing Node crypto objects.

Host services, logging, and storage use a JSON-only capability bridge. Only
explicit operations are dispatched. Hook invocations for one plugin are serialized;
different plugins have separate heaps. Limits include 32 MiB guest memory,
512 KiB guest stack, 1,000 host operations per hook, 100 queued hooks, bounded
bridge messages, and execution deadlines with CPU interruption. Hook cancellation
is host-enforced, including on service calls. Guest `context.signal` is a minimal
compatibility object; do not depend on DOM AbortSignal event listeners or timers.
A failed or timed-out plugin becomes unhealthy until disabled and re-enabled.

Native Rust inference still does not execute JavaScript inference plugins.

## Router analytics

Open the router's settings to see persistent analytics. The router records
classified/retained/sticky decisions, classifier calls and known cost, measured
input/output/cache tokens, and pricing coverage. No prompt, response, session ID,
account credentials, or application content is stored in router events.

The new `request.completed` hook receives sanitized completed trace metadata,
including actual model, status, trace ID/kind, measured token counts, cache counts,
latency, and cost/pricing status. It runs after trace persistence for buffered and
streamed responses; it cannot alter an already-completed response. Trace bodies,
headers, credentials and account identifiers are omitted. Notifications are bounded
best effort (256 pending); overload, a disabled/unhealthy plugin, or a crash can
leave gaps. Analytics are not a billing ledger.

Savings are a **counterfactual estimate**: observed token counts and cache usage
priced at the baseline model's rates minus those priced at the actual model's
rates. For `multivibe/autorouter`, the baseline is the advanced model configured
when routing occurred; the virtual name itself has no price. This cannot predict the tokens or cache hits the original model would
actually have used. Unknown usage/pricing and failed provider attempts do not
contribute savings. Classifier and failed-attempt costs are deducted only when known; failed classifier
calls can have unmeasured spend. Negative differences are retained. The UI exposes
coverage and labels the net difference as known-cost-only. Aggregates cover retained
events, not lifetime totals or an aligned billing cohort.

`GET /admin/modules/:id/analytics` returns event-type counts and metric sums under
normal admin authentication. Other plugins cannot call admin endpoints from their
sandbox. A plugin can read only its own events through `context.storage`.
