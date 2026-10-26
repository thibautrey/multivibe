# MultiVibe Host on Unraid

Use `multivibe-host.xml` for the Linux x86_64 Host image. It runs the AI API proxy
and account dashboard without an NVIDIA GPU or driver plugin.

1. Install the template through Unraid's Docker configuration.
2. Select a dedicated persistent appdata directory for `/data`.
3. Set the Public URL to the exact browser-facing LAN or HTTPS proxy origin.
4. Start the container and connect AI provider accounts in the dashboard.

The template uses a read-only filesystem, restricted capabilities, and a
privilege-dropping entrypoint. Application data and credentials survive image
replacement. Container updates are managed by Unraid.

The image is `ghcr.io/thibautrey/multivibe-host:latest`; use an immutable version
or digest when required by your deployment policy. Official catalog publication
and testing on the destination Unraid host remain separate release work.

When upgrading an older template, remove GPU options and the unused `/models`
mount. Keep or delete the underlying model directory manually; the new app does
not use or delete its contents.
