# Native local inference

MultiVibe links llama.cpp (MIT), pinned to `53ed051ce5e8193652e449f43216ca3859454f49`, through an Objective-C++ bridge. No React Native dependency or inference server is used. The library includes Metal kernels and llama.cpp common chat templates/parsers. Model weights retain their individual licenses.

From the main checkout, prepare the native dependency before generating/building the Xcode project:

```sh
native/ios/scripts/build-local-inference.sh
xcodegen generate --spec native/ios/project.yml
```

The build produces ignored artifacts under `native/ios/.build`; source pinning and build configuration are versioned. Device and simulator builds run sequentially. `cmake`, `ninja`, Xcode and network access for the pinned source archive are required.

The application saves models and an atomic installation registry under Application Support/LocalModels, excluded from backup. Immutable Hugging Face revisions and SHA-256 protect downloaded artifacts. Background URLSession transfers use 32 MiB ranges, keeping committed segments across failures and launches; iOS force-quit can defer recovery until reopening.

Catalog recommendations and tool eligibility are separate from architecture compatibility. The bundled manifest's validation fields must only be populated after physical validation; an empty validation list is intentional, not evidence of device support. Runtime compatibility also accounts for weights, a 4096-token F16 KV cache and scratch memory.

Source reference: PocketPal AI, MIT, copyright 2024 Asghar Ghorbani, at `6cf3944a47a196d2a68b1ba05d2534bd0ec20dd5`. This implementation uses its architectural approach, not its React Native code.

## Bundled catalog

The catalog includes the original three Qwen3 models and the twelve downloadable model families/sizes listed by [mobileLLM](https://github.com/ahui69/mobileLLM/blob/main/Packages/LLMCore/Sources/LLMCore/Catalog.swift): Bonsai 1.7B/4B/8B/27B, Qwen3.5 4B/9B, Qwen3.6 27B, Hunyuan 4B, DeepSeek-R1 Qwen3 8B, and Gemma 4 E2B/E4B/12B. Apple Foundation Models remains a separate system provider. These are GGUF text chat variants, not MLX, image or audio inference.

Artifact revisions, LFS SHA-256 digests, sizes and GGUF architecture metadata were checked against Hugging Face on 2026-09-24. The manifest pins each revision. Bonsai uses Q1_0 supported by the pinned llama.cpp Metal kernels. Gemma 4 12B uses the available official Q4_0 artifact; the Q4_K_M file named by mobileLLM was absent. License values come from the artifact repository card; Hunyuan leaves an explicit link-to-license fallback where the card supplies no license.

Memory estimates conservatively count every layer at the largest KV head count and key/value width, including Gemma 4 global 512-wide heads. Qwen3.5-family models also reserve F32 recurrent state using GGUF SSM dimensions. Missing recurrent metadata blocks hybrid models. Large models remain listed. Exceeding the estimated memory budget displays a non-blocking warning on available and installed model cards; downloading and inference remain allowed. Insufficient download storage and unsupported architecture metadata still block attempts. None of the new models is marked device-recommended or tool-validated; metadata/backend support is not physical-device inference validation. Bundled search results remain available offline.
