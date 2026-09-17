# Local-runtime discovery while running or stopped

MultiVibe probes only reviewed loopback endpoints. It never scans the LAN and
never accepts an arbitrary URL during automatic discovery.

## Running runtimes

The following runtimes are automatically probed on their standard local API:

| Runtime    | Endpoint          | Catalog      |
| ---------- | ----------------- | ------------ |
| Ollama     | `127.0.0.1:11434` | `/v1/models` |
| LM Studio  | `127.0.0.1:1234`  | `/v1/models` |
| OMLX       | `127.0.0.1:8000`  | `/v1/models` |
| Exo        | `127.0.0.1:52415` | `/models`    |
| MTPLX      | `127.0.0.1:8000`  | `/v1/models` |
| Jan        | `127.0.0.1:1337`  | `/v1/models` |
| GPT4All    | `127.0.0.1:4891`  | `/v1/models` |
| KoboldCpp  | `127.0.0.1:5001`  | `/v1/models` |
| Xinference | `127.0.0.1:9997`  | `/v1/models` |
| SGLang     | `127.0.0.1:30000` | `/v1/models` |
| Aphrodite  | `127.0.0.1:2242`  | `/v1/models` |

Equivalent IPv6-loopback endpoints are also probed. Responses are size- and
time-bounded, and only the declared origin and known inference paths can be
used afterward.

## Model names exposed to clients

Models served by a local runtime are exposed with a runtime-prefixed catalog
id, for example `omlx/Qwen3.8-27B-4bit` or `lm-studio/qwen3:4b`. The prefix is
the runtime adapter and keeps the model list unambiguous across runtimes: a
model exposed by several runtimes is listed once per runtime, and each entry is
routed to the runtime that exposes it. The runtime upstream keeps receiving its
own bare model id, and the unprefixed id remains accepted on input for
backward compatibility.

## Stopped runtimes

When an API is stopped, MultiVibe can still configure a provider if it finds
runtime-specific model evidence:

| Runtime    | Offline model source                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Ollama     | `$OLLAMA_MODELS/manifests`, `~/.ollama/models/manifests`, and the Linux service model directory                        |
| LM Studio  | `~/.lmstudio/models` and the absolute `downloadsFolder` in `~/.lmstudio/settings.json`                                 |
| OMLX       | `~/.omlx/models`                                                                                                       |
| Jan        | `$JAN_MODEL_PATH`, Jan's home directory, and its macOS/Linux/Windows application-data directories                      |
| GPT4All    | `$GPT4ALL_MODEL_PATH`, its platform application-data/cache directories, and an absolute `modelPath` from `GPT4All.ini` |
| Xinference | `$XINFERENCE_MODEL_SRC` and `~/.xinference/cache`                                                                      |
| KoboldCpp  | `$KOBOLDCPP_MODELS` or `$KOBOLDCPP_MODEL_PATH`                                                                         |
| SGLang     | `$SGLANG_MODEL_PATH`                                                                                                   |
| Aphrodite  | `$APHRODITE_MODEL_PATH`                                                                                                |

The environment-variable roots are MultiVibe discovery overrides; they do not
need to be variables defined by the upstream runtime. KoboldCpp, SGLang, and
Aphrodite require an explicit root because their model location is selected by
the launch command or commonly uses a shared cache, which is not sufficient
evidence that a particular runtime is installed.

Filesystem scanning does not follow symbolic links, is limited to five levels,
50,000 directory entries, and 10,000 discovered models. A file is accepted only
when it has a recognized model-weight or model-configuration extension. Live
API results take precedence over disk evidence.

Stopped discovery makes the provider and known models visible; it **does not
start the runtime**. Inference remains unavailable until its server is running
on the configured loopback endpoint.

## Why other registered runtimes remain manual

vLLM, LocalAI, llama.cpp, MLX-LM, TGI, Transformers Serve, text-generation-webui,
TabbyAPI, llama-box, mistral.rs, NIM, TensorRT-LLM, Triton, OpenLLM, and BentoML
remain manual unless already represented by a runtime-specific integration.
Their default ports can collide with another server, their storage is arbitrary
or shared, or both. Probing a generic port or treating a shared Hugging Face
cache as installation proof would create false providers and could route a
request to the wrong local process.
