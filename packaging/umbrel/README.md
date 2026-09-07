# Umbrel CPU Host (amd64 and ARM64)

The native packager now supports Linux ARM64, including pinned Node, Ollama,
SQLite prebuilds, Go binaries and native ELF verification. ARM64 Linux defaults
to CPU mode. Set `MULTIVIBE_PROVIDER_ACCELERATOR=cpu` on amd64 to select the
same path; existing amd64 NVIDIA installations retain their default behavior.

CPU mode requires cgroup v2 and at least 4 GiB effective physical/container
capacity. It reserves half for the operating system and other apps, then applies
the operator's capacity percentage to the remainder. 8 GiB RAM is recommended.
The reviewed static Qwen 2.5 0.5B profiles use 2048 context tokens, batch 32,
one parallel request, no GPU offload, 1 GiB estimated model/runtime memory and
512 MiB reserve. These are conservative configuration estimates, **not measured
benchmarks**. Larger contexts and unreviewed model/runtime combinations remain
rejected. GPU discovery is disabled in the managed CPU process as well.

## Build and publication

Run `.github/workflows/umbrel-host.yml` on a stable release tag. It builds and
verifies archives on native `ubuntu-24.04` and `ubuntu-24.04-arm` runners, runs
CPU/backend tests, executes each archive's doctor and SQLite smoke test, and
builds and checks the corresponding CPU container. The default is build-only.

With its explicit `publish` input, the workflow publishes versioned images to
`ghcr.io/thibautrey/multivibe-host-umbrel`, creates an amd64/arm64 index, attests
it, and generates an `umbrel-package` artifact from the actual index descriptor.
Existing version tags are never deliberately replaced. If a publication stops
partway through, inspect and reconcile the published artifacts before retrying;
the immutable tag checks intentionally stop a blind rerun.

No image digest is committed in advance. The generator rejects single-platform
images, missing architectures, prereleases and unpinned references. Its generated
Compose file retains Umbrel proxy authentication, publishes no direct web port,
uses persistent `${APP_DATA_DIR}/data` and `${APP_DATA_DIR}/models`, and requires
no GPU permission or Docker socket. Browser setup should use `/models/weights`
for model storage. The public origin uses `${DEVICE_DOMAIN_NAME}` and Umbrel's
app proxy port; IP, Tor and other proxy URLs require explicit Host origin
configuration. Port 1455 must be checked against the destination catalog before
submission. Gallery assets and official store review remain publication work.

The ARM archives are build artifacts for the CPU image, not native installer or
auto-update releases. The existing four native archives, NVIDIA container image,
signed checksums and five-target updater feed remain unchanged. Umbrel manages
CPU container upgrades. Do not install the legacy amd64 Linux installer on ARM.

## Validation and remaining hardware checks

Local tests cover memory/cgroup bounds, CPU-only subprocess configuration,
reviewed profile selection and native Ollama parameters on both architectures,
ARM SQLite selection, archive safety and package generation. Native ARM archive
execution, real Ollama inference and the complete browser/proxy/storage lifecycle
on an Umbrel device must still be exercised before claiming official support.
This checkout has not published an image or submitted an Umbrel listing.

Upstream requirements checked 2026-09-07:
https://github.com/getumbrel/umbrel-apps/blob/master/.claude/skills/umbrel-package-app/SKILL.md

Validated locally on 2026-09-07:

- Worktree: 27 archive/native dependency/package tests passed; `git diff --check`
  and `actionlint` passed.
- Main: all provider Go tests passed with the race detector; Host application
  tests passed; 45 packaging/distribution tests and 14 supervisor tests passed.
- Main: API TypeScript build and catalog digest validation passed; Linux ARM64
  provider and Host Go binaries cross-compiled and were identified as AArch64 ELF.
- Main: the real amd64 CPU `doctor` reported `supported: true` and bounded memory.
- The supervisor test's initial `spawn go ENOENT` was resolved by adding the
  existing pinned Go toolchain directory to that test command's PATH.
