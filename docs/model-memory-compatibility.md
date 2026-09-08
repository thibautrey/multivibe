# Catalogue memory estimates

The Models tab can filter by **Estimated to fit**, **Exceeds memory budget**, or
**Estimate unavailable** for a selected context (512–131,072 tokens). Click
**Check memory fit** to request estimates; changing context recomputes them and
clears the previous results. Refresh after changing Host policy or downloads.
This status is separate from account availability and never enables a route.

The host invokes the pinned llama.cpp b10865 `llama-fit-params --fit-print on`
with a fixed batch of 128, microbatch 128, one sequence, and the requested
context. Upstream creates a metadata-only model with `no_alloc=true` and
`LLAMA_LOAD_MODE_NONE`; it does not decode tokens or start an inference server.
Model, context and compute memory figures come from llama.cpp. MultiVibe only
adds those reported components and compares them with the configured device
budget (and a separate OS-derived RAM budget for discrete GPUs). Metal uses
its shared-memory budget. Unknown budgets/devices produce unknown results.

References for the pinned implementation:
- https://github.com/ggml-org/llama.cpp/blob/b10865/tools/fit-params/README.md
- https://github.com/ggml-org/llama.cpp/blob/b10865/common/fit.cpp

## Coverage and meaning

The current managed model catalogue contains Qwen 2.5 0.5B Instruct
(`qwen2.5:0.5b`). Estimates require that exact pinned GGUF to be present and
pass manifest/blob verification. Models outside this managed catalogue,
missing artifacts, ambiguous aliases and unsupported devices remain unknown.
There is no size-based approximation or fuzzy name matching. This operation
does not download weights. Download-free evaluation of other remote variants
requires trustworthy runtime-compatible metadata; it is not yet supported.

This is a memory capacity estimate for the named variant and llama.cpp
configuration, not a guarantee of available memory at execution time, trained
context support, model quality, speed, or compatibility with other runtimes.
Numbers reported by upstream are truncated to MiB; a budget equal to the
reported requirement is treated as insufficient. Normal runtime validation
and admission checks still apply when a model is actually launched.

`POST /admin/provider-agent/model-compatibility` proxies the authenticated host
control endpoint `POST /v1/model-compatibility`. The only accepted input is
`{"context_tokens":8192}`. Results are not cached. The call may install the
pinned diagnostic runtime only with existing Host automatic-download permission
and an unpaused policy. An installed tool can be used while hosting is paused.
The versioned installation layout enables the companion diagnostic executable
without modifying an already attested runtime installation.

## Validation

`go -C provider-agent test -race ./...` covers parsing, memory classification,
request validation and download restrictions. The opt-in
`TestCompatibilityRealRuntime` uses locally verified smoke artifacts and checks
that context memory increases between 2,048 and 8,192 tokens without an
inference server. Web tests cover exact identity matching, ambiguous variants
and independence from routing availability; admin tests cover the proxy.
