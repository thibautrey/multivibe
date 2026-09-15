# Pre-download model memory estimates

Discovery uses metadata only, independently of Host connection or model download.
The existing Host runtime estimate takes precedence when it provides allocation
numbers. Estimates never authorize installation or bypass preparation preflight.

References checked 2026-09-15:
- Ollama v0.33.2 `fs/ggml/ggml.go`, `GraphSize`:
  https://github.com/ollama/ollama/blob/v0.33.2/fs/ggml/ggml.go#L648
  Separates weights, per-layer attention/recurrent caches and compute graphs.
- LM Studio `lms load --estimate-only`:
  https://lmstudio.ai/docs/cli/local-models/load
  Documents estimation without loading a locally downloaded model, including
  context, GPU offload, flash attention and vision. This is not evidence of a
  public pre-download API or a published LM Studio estimation formula.

Our catalog-memory-v2 estimate uses complete published artifact sizes, f16 KV
cache, f32 Qwen recurrent state, one sequence and 8,192 tokens. Q4_K_M is preferred
when present; otherwise an actual complete artifact is used. MoE uses all weight
bytes, never just active parameter count. The compute reserve is explicitly our
approximation: 512-token batch, non-flash attention workspace plus 25% and 1 GiB.
It is not a port of a runtime's exact allocation planner. Vision/audio processing
is excluded, even when text generation uses a multimodal model.

Supported metadata: Llama, Qwen2, Qwen3 (including MoE), Qwen3 Next,
Qwen3.5 text configurations (including MoE), Mistral/Mixtral, Phi/Phi3,
Gemma/Gemma2/Gemma3 text and StarCoder2. Sliding-window attention uses the
full-context cache as a conservative upper bound. Unsupported architectures,
missing dimensions and models whose context limit is below 8,192 remain explicit
non-estimates. This is an approximation, not certification of runtime support.

The persistent v2 queue covers every catalog repository, with three workers.
Opening a model/variant prioritizes its repository; every fifth dispatch is FIFO
to prevent background starvation. One config read estimates every complete weight
artifact in the repository. The queue is local to each Host (separate demo store),
with an append-only journal, atomic snapshot compaction every 200 writes, at most
10,000 repositories, and a 64 MiB read bound per persistence file. Queue entries
include model and original revisions, estimator version and context identity.
Changed revisions invalidate results; interrupted jobs resume after restart.

Successful results expire after six hours. Unsupported/missing data is reconsidered
after 24 hours; temporary fetch failures retry after 1, 5 and 30 minutes. Queued,
estimating, unsupported architecture, incomplete configuration/weights, access,
context and fetch failures are reported separately. Fresh runtime allocations
still take precedence. UI selection requests are checked against declared model
families; they cannot enqueue arbitrary external URLs. No weights are downloaded.

Metadata predictions can classify a total user budget or shared CPU/Metal memory.
CUDA allocation across RAM/VRAM remains unknown without a runtime estimate.
The chart tooltip names the artifact, estimation source and text-only scope.
