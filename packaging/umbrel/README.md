# Umbrel compatibility gate

No official Umbrel package is emitted yet. The current upstream packaging rules
require maintained **amd64 and arm64** images. MultiVibe's Linux release is
currently amd64/NVIDIA-only. Umbrel's `GPU` permission grants `/dev/dri` access;
it is not evidence of an NVIDIA Container Toolkit integration.

Source checked 2026-09-07:
https://github.com/getumbrel/umbrel-apps/blob/master/.claude/skills/umbrel-package-app/SKILL.md

Before implementing an official package:

1. Add and test an arm64 Linux runtime/provider combination in the native
   dependency manifest, runtime verification, release packaging and CI. Do not
   alias the amd64 image or advertise CPU-only support without implementing it.
2. Publish and verify a multiarchitecture image index with both platforms.
3. Prove a supported GPU/runtime path on actual Umbrel hardware, including
   browser-only setup, proxy origin handling, model storage and updates.
4. Package the resulting image with `app_proxy`, a reserved unused port,
   persistent `${APP_DATA_DIR}` mounts and appropriate permissions, then run
   Umbrel's package tests before submitting.

This is a runtime compatibility project, not an omitted YAML conversion. The
other distribution channels do not depend on it.
