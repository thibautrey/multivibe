# Durable trace analytics

The HTTP control plane delegates analytics to one worker thread and a SQLite WAL database. Set `TRACE_ANALYTICS_DB_PATH` to place this index on local SSD storage; by default it is next to the historical statistics JSONL file. Avoid network filesystems for SQLite WAL. The database contains private usage metadata and uses mode 0600.

## Import and recovery

The existing statistics JSONL is imported once and retained as a rollback source. New statistics go to SQLite, without extending that legacy history. The Rust trace journal is consumed incrementally in the background. Entry IDs provide persistent deduplication. Entries, hourly aggregates and each source inode's byte offset commit in a single transaction, so restart and replay do not double count. Invalid complete lines are counted; incomplete UTF-8/JSON lines remain behind the durable cursor until completed. I/O failures are reported instead of being interpreted as an empty history.

When the historical import has not finished, statistics endpoints return 503 with `Retry-After` and an `analytics` status object. Normal responses expose indexing progress, pending bytes and the latest ingestion time. Requests do not wait for the journal to catch up. `/health` and inference remain independent of the import worker.

`TRACE_JOURNAL_MAX_BYTES` is enabled by the container supervisor (64 MiB by default). Only the Rust writer rotates the live journal, under its append mutex. It never overwrites an existing `.previous` segment. The worker removes that segment only after consuming every complete line and committing its cursor with SQLite synchronous FULL. If the reader falls behind, disk usage can temporarily exceed the rotation threshold; preserving events takes precedence over overwriting unread data. Standalone Rust deployments leave rotation disabled unless the compatible consumer is configured.

## Queries and bounded resources

Complete hours use persistent trace and dimension aggregates. Only partial edge hours visit indexed raw entries, so short-window queries do not decode the entire lifetime history. Average inference speed stores a sum and count. Latency percentiles use bounded samples and are estimates; token counts, request counts and monetary sums are not sampled.

Session reports are stored for up to four filter windows. New events mark their session dirty; subsequent requests rebuild only affected sessions. Oversized sessions spill turn reduction to SQLite instead of retaining all turns in a JavaScript map. Session summaries and pagination are computed before loading response details. Session turn endpoints accept `limit` (default 200, maximum 500) and `offset`, and return `turns`, `total`, `limit`, and `offset`.

The worker bounds its query cache and the client shares identical in-flight requests. Dashboard polling runs only for the visible activity view, pauses in hidden browser tabs, prevents overlap, and discards obsolete range responses. Turn details are displayed one page at a time.

## Verification

Run `npm run build`, the trace analytics/trace/session/project tests, and `cargo test -p multivibe-v1-edge`. `node scripts/benchmark-trace-analytics.mjs --rows 3000000` generates a synthetic multi-million-event history, validates token and attempt totals, measures migration and query latency, checks repeated session reports, and measures the HTTP thread's event-loop delay. This benchmark excludes upstream model inference. The temporary synthetic history and index are removed when it finishes.
