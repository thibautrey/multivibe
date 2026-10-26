# Local inference retirement — 2026-10-26

MultiVibe Host no longer installs, starts, discovers or shares local inference
engines. Releases omit Ollama, the provider agent, the runtime benchmark binary,
runtime profiles and downloadable-model catalogs. The local model setup,
hardware estimates, worker enrollment and Team machine-sharing interfaces and
API routes have been removed. NAS/container definitions no longer request a GPU
or a model-storage volume. Provider connections, proxy routing, Cloud access and
Team account sharing remain available.

Existing accounts carrying `localRuntime` metadata are disabled on load and
cannot be reenabled. The Rust edge also rejects them independently and refuses
the reserved `multivibe-local-*` model IDs. Metadata is retained for recovery;
previously downloaded model files and managed-runtime directories are not
deleted. Upgrading replaces the application bundle, removing its bundled
engine. Windows upgrade cleanup still recognizes old owned engine processes.

The external Ollama Cloud provider and the proxy's Ollama-compatible model-list
endpoint remain remote-provider/compatibility features. Neither runs Ollama.
Legacy community-report payloads remain readable, but the retired runtime
benchmark store is no longer read or uploaded for new reports.

The API build clears `dist` before compilation so deleted engine modules cannot
survive in a locally rebuilt release. The demo also omits local engine fixtures
and no longer starts local-model catalog or memory-estimation services.

## Expected size

The [v0.2.133 inventory](macos-release-size-2026-10-26.md) measured
545,308,739 bytes of bundled Ollama on Apple Silicon and 545,919,811 bytes on
Intel. Removing that payload plus the agent and benchmark helpers should bring
the app to approximately 570–600 MB. This is an estimate from the old release,
not a measurement of a newly signed application. CEF and Node remain bundled.

## Validation

Worktree checks used dependency-free archive, packaging, menu-source and NAS
generator tests. Initial failures exposed a missing updater build call and
obsolete fixture expectations; these were corrected before final validation.

After integration into local `main`:

- API TypeScript compilation and the web TypeScript/Vite production build pass.
- The application suite passes 903 tests, with one existing skipped test.
- The Rust edge suite passes 135 tests.
- 85 packaging, archive-verification, menu-source and distribution checks pass.
- Go tests pass for the Host application, updater and Linux GTK menu. The
  Windows menu cross-compiles successfully; its executable was not run here.
- Changed JSON/YAML configuration parses successfully, and `git diff --check`
  passes.

Two broader checks have failures already present in the parent commit
`ca6f14b1`: the dashboard source-boundary check rejects the existing
`packages/ui/src/model-pricing.ts` reexport from server source, and the source
release test expects `NOTICE` to mention only `LICENSE`, although the existing
notice also names Chromium and provider-icon notices. These checks are outside
the inference removal. The dashboard capability and export checks pass.

The dedicated macOS build host at `192.168.1.114` was unreachable from this VM
(`No route to host`). Native Swift compilation, signing/notarization and actual
post-build macOS application size remain unverified. No release was published.
