# Community benchmarks (opt-in)

MultiVibe Core can publish an anonymous, daily aggregate of how this machine runs
open models, so the public community benchmarks pages can show real behaviour
instead of only modeled projections.

Reporting is **off by default**. An operator enables it in the dashboard
(Activity → *Publish community model benchmarks*), and switching it back off
deletes any unsent report. The toggle is stored as
`communityBenchmarksSharingEnabled` with the activation time
`communityBenchmarksSharingEnabledAt`; nothing is sent while it is unset.

## What is sent

One envelope per completed UTC day, at most once per machine, to
`POST /telemetry/v2/community-report` using the same single-use proof-of-work
admission ticket as the anonymous demand aggregate
(`POST /telemetry/v1/admission`). The server publishes the accepted model list at
`GET /telemetry/v2/allowlist`.

Per model and execution scope (`local` or `personal-cluster`) the envelope contains
request and token counters plus bounded, mergeable histograms: time to first token,
total latency, output tokens per second, the context sizes used, and time to first
token per context bucket. It also carries the results of the local synthetic
runtime benchmark store (`provider-runtime-benchmark-store-v1`), keyed by their
own `result_digest` so a measurement is never sent twice.

Cloud-routed traffic is excluded: the gateway already measures it, and adding it
here would double count.

## What is never sent

Prompts, responses, project or account names, API keys, request headers, host
names, serial numbers, source addresses, file paths and any installation
identifier. The machine is described by a bounded descriptor (accelerator kind, a
sanitized accelerator name, two memory sizes, OS, CPU architecture and, locally
only, the machine model used to disambiguate the hardware profile). Cloud reduces
that descriptor to a published landing hardware profile or a bounded generic
bucket before storing anything, and discards the raw strings.

## Local modules

- `src/community-report.ts` builds the envelope from completed local traces
  (`collectCommunityReportTraces`) and reads the synthetic benchmark store.
- `src/community-host-profile.ts` derives the bounded host descriptor from the
  supervised Provider Agent capability, falling back to bounded local detection
  (`sysctl`, `nvidia-smi`, `rocm-smi`).
- `src/community-report-sharing.ts` owns the opt-in gate, the daily schedule, the
  durable pending state and the retry with a fresh admission ticket.

## Configuration

- `COMMUNITY_BENCHMARKS_ENABLED` (default `false`) enables the reporting worker.
- `COMMUNITY_BENCHMARKS_API_BASE_URL` (defaults to `ANONYMOUS_USAGE_API_BASE_URL`).
- `COMMUNITY_BENCHMARKS_STATE_PATH` (default `/data/community-report-state.json`).
- `COMMUNITY_BENCHMARK_STORE_PATH` (default `/data/runtime-benchmark-store.json`).

Rollout order, the wire format, the histogram bounds and the publication floor are
documented in the Cloud repository at `docs/community-benchmarks.md`.
