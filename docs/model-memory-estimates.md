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

Our catalog-memory-v1 estimate uses complete published artifact sizes, f16 KV
cache, f32 Qwen recurrent state, one sequence and 8,192 tokens. Q4_K_M is preferred
when present; otherwise an actual complete artifact is used. MoE uses all weight
bytes, never just active parameter count. The compute reserve is explicitly our
approximation: 512-token batch, non-flash attention workspace plus 25% and 1 GiB.
It is not a port of a runtime's exact allocation planner. Vision/audio processing
is excluded, even when text generation uses a multimodal model.

Supported metadata: Llama, Qwen2, Qwen3 (including MoE), Qwen3 Next and Qwen3.5
text configurations (including MoE). Other architectures and incomplete metadata
stay unknown. File sizes are not presented as RAM. No model weights or repository
code are downloaded. Config reads use immutable revisions and fixed Hub endpoints.

Metadata predictions can classify a total user budget or shared CPU/Metal memory.
CUDA allocation across RAM/VRAM remains unknown without a runtime estimate.
The chart tooltip names the artifact, estimation source and text-only scope.
Metadata is cached in process for six hours (failures ten minutes), bounded to
512 entries, and progressively fetched with four workers for the top 24 families,
prioritizing those with scores. At most two repositories per family are estimated.
