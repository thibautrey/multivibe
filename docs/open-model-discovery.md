# Live open-model discovery

The Models UI is English. Beginner, Advanced and Expert preserve the existing view preference.

`GET /admin/open-model-catalog` fetches a fixed public Hugging Face Hub endpoint server-side (no credentials or chat text). It merges 100 trending and 100 newest text-generation repositories, keeps conversational/public/ungated entries tagged with an allowlisted permissive license, and excludes adapters. These are reference entries, not verified recommendations or executable routes. The feed is bounded, not a complete index of all releases. Repository creation dates are not release dates. License tags are publisher metadata, not a full open-source AI audit.

The process caches successful results for one hour, deduplicates concurrent loads and marks retained results stale if refresh fails. With no previous results it returns 503. The UI refreshes hourly while mounted and on reopen (subject to the cache); there is no background scheduler when MultiVibe is stopped. Restarting the service loses its in-memory cache. Discovery never downloads model weights, executes repository code, grants access, or changes runtimes.

Beginner shows three discovery cards separately from reviewed ready-to-chat selections. Advanced and Expert expose search, newest/trending ordering and more results. Popularity is not quality or hardware suitability. The demo uses this real public feed while its account/inference data remain fictional.

Local guided installation and authenticated Cloud execution are separate work; this feed proves neither. Model cards are external links and are the next review step, not installation actions.
