# Durable trace analytics

The HTTP control plane delegates analytics to one worker thread and a SQLite WAL database. Set `TRACE_ANALYTICS_DB_PATH` to place this index on local SSD storage; by default it is next to the historical statistics JSONL file. Avoid network filesystems for SQLite WAL. The database contains private usage metadata and uses mode 0600.

## Import and recovery

The existing statistics JSONL is imported once and retained. To roll back to a legacy reader after new events have been indexed, stop the writers, run `node scripts/export-trace-analytics.mjs <index.sqlite> <new-history.jsonl>`, retain a backup of the original JSONL and atomically replace it with that export. Disable journal rotation for the legacy deployment. The frozen original JSONL alone does not include new events. New statistics go to SQLite, without extending that legacy history. The Rust trace journal is consumed incrementally in the background. Entry IDs provide persistent deduplication. Entries, hourly aggregates and each source inode's byte offset commit in a single transaction, so restart and replay do not double count. Invalid complete lines are counted; incomplete UTF-8/JSON lines remain behind the durable cursor until completed. I/O failures are reported instead of being interpreted as an empty history.

When the historical import has not finished, statistics endpoints return 503 with `Retry-After` and an `analytics` status object. Normal responses expose indexing progress, pending bytes and the latest ingestion time. Requests do not wait for the journal to catch up. `/health` and inference remain independent of the import worker.

`TRACE_JOURNAL_MAX_BYTES` is enabled by the container supervisor (64 MiB by default). Only the Rust writer rotates the live journal, under its append mutex. It never overwrites an existing `.previous` segment. The worker removes that segment only after consuming every complete line and committing its cursor with SQLite synchronous FULL. If the reader falls behind, disk usage can temporarily exceed the rotation threshold; preserving events takes precedence over overwriting unread data. Standalone Rust deployments leave rotation disabled unless the compatible consumer is configured.

## Queries and bounded resources

Complete hours use persistent trace and dimension aggregates. Only partial edge hours visit indexed raw entries, so short-window queries do not decode the entire lifetime history. Average inference speed stores a sum and count. Latency percentiles use bounded samples and are estimates; token counts, request counts and monetary sums are not sampled.

Session reports are stored for up to four filter windows. New events mark their session dirty; subsequent requests rebuild only affected sessions. Oversized sessions persist turn reduction to SQLite instead of retaining all turns in a JavaScript map. New-event revisions and the report time cursor update those turns incrementally, including late-arriving events; turn state and its cursor commit atomically. Session summaries and pagination are computed before loading response details. Session turn endpoints accept `limit` (default 200, maximum 500) and `offset`, and return `turns`, `total`, `limit`, and `offset`.

The worker bounds its query cache and the client shares identical in-flight requests. Dashboard polling runs only for the visible activity view, pauses in hidden browser tabs, prevents overlap, and discards obsolete range responses. Turn details are displayed one page at a time.

## Verification

Run `npm run build`, the trace analytics/trace/session/project tests, and `cargo test -p multivibe-v1-edge`. `node scripts/benchmark-trace-analytics.mjs --rows 3000000` generates a synthetic multi-million-event history, validates token and attempt totals, measures migration and query latency, checks repeated session reports, and measures the HTTP thread's event-loop delay. This benchmark excludes upstream model inference. The temporary synthetic history and index are removed when it finishes.

### Runtime prices and the October 2026 cost backfill

The control plane refreshes `https://models.dev/api.json` using its existing
24-hour cache. `SDK_MODELS_DEV_CACHE_PATH` selects the shared, atomically written
catalog cache (version 2 preserves context tiers). The analytics worker and Rust
edge use this cache for USD-per-million-token prices. The edge checks the local
file at most once per 30 seconds and keeps its last valid snapshot on errors.
Qualified model IDs retain the provider's price; reseller prices never override
bare origin model IDs. Missing prices remain unpriced, while published zero
prices and recorded zero costs remain valid. The UI reuses the backend estimator;
its activity totals come from backend analytics. GPT-6.1 Sol also has an offline
Standard-price fallback, including the context tier above 272,000 input tokens.

After a valid models.dev catalog is available, the indexed analytics store runs
`models-dev-missing-costs-2026-10-25-v1` once. It fills absent costs for historical
entries with measured usage, preserves all recorded costs, and repairs affected
hourly, project and session totals. JSONL journals are not rewritten. Batches,
progress and affected hours commit durably in SQLite so interruption resumes the
same migration. Completion is recorded in `metadata`; later price refreshes and
restarts do not repeat the historical scan. Unpriced models remain unpriced if
they were unknown during that migration. Newly ingested requests use the current
available prices as usual. Progress and completion counters are exposed in the
analytics persistence status under `pricingBackfill`.
