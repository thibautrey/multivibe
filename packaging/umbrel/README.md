# MultiVibe Host on Umbrel

The Umbrel image supports Linux amd64 and ARM64 and runs the AI API proxy and
account dashboard. It requires no GPU, local model, or inference-engine setup.

`scripts/umbrel/generate.mjs` generates a package from a stable version and an
immutable multiarchitecture image descriptor. The Compose package retains
Umbrel proxy authentication, publishes no direct web port, and persists only
`${APP_DATA_DIR}/data`. It requires no Docker socket or GPU permission.

The public origin uses `${DEVICE_DOMAIN_NAME}` and the app proxy port. IP, Tor,
and other proxy URLs require explicit Host origin configuration. Check port
1455 against the destination catalog before submission. Umbrel manages image
upgrades. Gallery assets and official store review remain publication work.

An upgrade leaves any previously mounted model directory on the host. It is no
longer mounted or used by MultiVibe; preserve or remove it manually as needed.
