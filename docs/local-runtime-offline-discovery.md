# Offline local-runtime discovery

MultiVibe first probes each supported loopback model-catalog API. If the API is
stopped, it can still configure runtimes whose installation has a stable,
runtime-specific model layout:

| Runtime | Offline model source | Configured endpoint |
| --- | --- | --- |
| Ollama | `$OLLAMA_MODELS/manifests`, `~/.ollama/models/manifests`, and the Linux service model directory | `http://127.0.0.1:11434` |
| LM Studio | `~/.lmstudio/models` and the absolute `downloadsFolder` in `~/.lmstudio/settings.json` | `http://127.0.0.1:1234` |
| OMLX | `~/.omlx/models` | `http://127.0.0.1:8000` |

A model directory is accepted only when it contains a recognized model weight
or configuration file. Symbolic links are not traversed, and catalogs are
bounded to 10,000 models. Live API results always take precedence over disk
inspection.

Offline discovery makes the provider and its known models visible in
MultiVibe; it does not start the runtime. Inference remains unavailable until
the corresponding local server is running on its standard loopback endpoint.
Runtimes without a stable runtime-specific storage layout remain manual or
live-probe-only to avoid misidentifying a shared model cache as an installed
provider.
