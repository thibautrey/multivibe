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
