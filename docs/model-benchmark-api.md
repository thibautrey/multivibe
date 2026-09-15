# Model benchmark API

The local admin API exposes benchmark data for a future dashboard UI. All routes
inherit the existing `/admin` authentication boundary.

| Route | Source | Purpose |
| --- | --- | --- |
| `GET /admin/benchmarks/sources` | MultiVibe | Report configured sources and capabilities. |
| `GET /admin/benchmarks/models?model=owner%2Fmodel` | Hugging Face | Return every evaluation observation recorded for one model. |
| `GET /admin/benchmarks/leaderboards?dataset=owner%2Fbenchmark&limit=100` | Hugging Face | Return ranked entries for one official benchmark dataset. |
| `GET /admin/benchmarks/artificial-analysis/models?page=1&access=free` | Artificial Analysis | Return a page of model indices, pricing and median performance. |
| `GET /admin/benchmarks/artificial-analysis/models/{slug}?prompt_type=long` | Artificial Analysis | Return Pro model detail, including individual evaluations when the configured tier permits it. |

Set `ARTIFICIAL_ANALYSIS_API_KEY` only in the server environment. It is sent in
the `x-api-key` header to the fixed Artificial Analysis origin and is never
returned by these endpoints. Without it, Hugging Face remains available and the
sources route reports Artificial Analysis as unconfigured.

Hugging Face results are observations, not canonical scores. The response keeps
the benchmark/task identity, source URL and type, verification flag, date,
filename and pull request so the UI can explain why two superficially identical
scores may not be comparable.

Artificial Analysis requires visible attribution. Its Free tier is for internal
use; use in a customer-facing dashboard depends on the applicable redistribution
rights.

Sources:

- <https://huggingface.co/docs/hub/leaderboard-data-guide>
- <https://artificialanalysis.ai/data-api/docs>
