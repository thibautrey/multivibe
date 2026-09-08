# Automatically managed inference engines

The Host downloads and installs a compatible engine when it prepares a reviewed
model. It needs no user-installed runtime, Python environment, package manager,
compiler, or Docker daemon. Ollama remains the artifact downloader and fallback;
llama.cpp and llamafile execute the same verified GGUF weights without making a
second model download.

| Host | First candidate | Fallback |
| --- | --- | --- |
| Apple Silicon | llama.cpp Metal | Ollama |
| Linux x86-64 CPU | llamafile | llama.cpp CPU, then Ollama |
| Linux ARM64 CPU | llama.cpp CPU | Ollama |
| Windows x86-64 NVIDIA | llama.cpp CUDA 12.4, including its runtime DLLs | Ollama |
| Linux x86-64, one NVIDIA GPU | llama.cpp Vulkan, if its device probe matches | Ollama |
| Other existing supported Host configurations | Ollama | — |

GPU drivers must already be installed. The Linux Vulkan build is **not** a CUDA
build. It is rejected when there are multiple NVIDIA GPUs or when the Vulkan
probe reports another/ambiguous device. This preserves the selected-device
boundary until UUID-based Vulkan discovery is available. Existing Host hardware
eligibility still applies; this change does not enable AMD or Intel GPU hosting.

The initial reviewed model is Qwen 2.5 0.5B Instruct, matching the existing Host
model catalog. Unsupported models, formats or hardware retain Ollama. MLX-LM,
vLLM, SGLang and TensorRT-LLM remain external-server integrations: automatic
installation and their distinct model/dependency distributions are not included.

## Selection and lifecycle

The embedded release list supplies deterministic candidate order. A candidate
must match a reviewed model × hardware × runtime profile, including its artifact
hash, model manifest, license assessment, context, batch size, offload and memory
budget. The initial settings are conservative static profiles, not benchmark
results or a guarantee of a speedup. In particular, this implementation does not
perform automatic benchmarking or continuous batching across requests.

Model preparation installs the runtime, verifies the GGUF, stops Ollama to free
its resident memory, and starts an authenticated loopback server with one model
and one slot. The server stays warm between requests. Native requests use the
same cancellation, streaming and output-size controls as the existing worker.
The qualification test also executes through the selected engine.

A download, compatibility or startup failure tries the next candidate **before
sending a prompt**. It records `optimized_runtime_unavailable` when Ollama is
used. A failing candidate/profile is suppressed until agent restart; disabling
downloads does not permanently suppress it. Once dispatch begins, failures are
returned without retrying inference on another engine. Pausing sharing, stopping
the worker or changing the policy stops the native process; a policy change also
cancels an in-progress installation.

Automatic-download consent is required for new runtime bytes. A verified cached
installation can be reused with downloads disabled. Installations are staged in
private directories under the existing managed root, checked against compiled
SHA-256 and size pins, then atomically committed after policy revalidation.
Archives cannot execute installation scripts. Internal library symlinks are
materialized as regular files, and an installed tree is re-attested before a
new process is launched. Runtime output and prompts are not persisted in logs.

The legacy `ollama` model/inventory protocol identifies the existing registry
artifact binding. That binding, signed request validation, model licensing and
Cloud consent remain enforced. The actual inference process is exposed through
`execution_runtime`, `execution_version`, and optional `fallback_reason` on the
managed status response. The legacy `version` field continues to describe the
Ollama artifact manager for older clients.

## Release maintenance and validation

- `provider-agent/managed_engines.json`: embedded upstream release URLs, archive
  formats, byte counts, SHA-256 hashes, platform and accelerator constraints.
- `provider-agent/managed_engine_profiles.json`: embedded, digest-checked native
  profiles. These are separate from the existing Ollama benchmark catalog so
  previously recorded benchmark evidence retains its original catalog identity.
- `provider-agent/managed_engines_test.go`: offline installer, integrity,
  selection, policy, request and fallback regression tests.
- `provider-agent/managed_engines_integration_test.go`: opt-in real Linux CPU
  installation, qualification, streaming and shutdown checks for both engines.

Run the provider suite with `go -C provider-agent test ./...`. The real smoke test
requires an existing Ollama-format directory containing the exact catalog model:

```sh
MULTIVIBE_ENGINE_SMOKE_MODEL_STORAGE=/absolute/path/to/models \
  go -C provider-agent test . -run '^TestManagedEngineRealCPUInference$' -v -count=1
```

It downloads the pinned runtime releases, verifies all model bytes, and never
uses a discovered server. An optional `MULTIVIBE_ENGINE_SMOKE_ARTIFACT_CACHE`
directory supplies release archives offline, still subject to the normal hash
and size checks. GPU and macOS validation requires the corresponding hardware.

llama.cpp is MIT-licensed; llamafile is Apache-2.0-licensed and contains upstream
third-party notices. Their published release files retain those notices. These
licenses are independent of each model's existing hosted-inference assessment.
