# MultiVibe Host on Unraid

MultiVibe Host runs local models on an NVIDIA GPU and provides a local dashboard
and API. Provider sharing is opt-in. This beta container requires x86_64 Unraid,
the Nvidia Driver plugin, and an NVIDIA GPU with compute capability 7.0 or newer.

The template is ready for local evaluation. Its presence in this repository does
not mean MultiVibe is listed or approved in Community Applications (the Apps tab).
The `ghcr.io/thibautrey/multivibe-host:latest` manifest was accessible without
credentials on 2026-09-07. A real Unraid installation still needs verification.

## Install before store acceptance

1. Install the Nvidia Driver plugin and confirm your GPU is available.
2. From an Unraid terminal, download the template into CA's private repository
   directory (after this change has been published to GitHub):

   ```sh
   mkdir -p /boot/config/plugins/community.applications/private/MultiVibe
   curl --fail --location \
     https://raw.githubusercontent.com/thibautrey/multivibe/main/packaging/unraid/multivibe-host.xml \
     --output /boot/config/plugins/community.applications/private/MultiVibe/multivibe-host.xml
   ```

   For an unpublished checkout, copy `packaging/unraid/multivibe-host.xml` to
   that same destination. Keep the filename ending in `.xml`.
3. Open Apps, select the Private category, and install `multivibe-host`.
4. Choose an unused Web UI port (default `1455`). Set **Public URL** to the
   actual browser origin, for example `http://192.168.1.10:1455`. If you change
   the host port, change this URL too. For a reverse proxy, enter its HTTPS
   origin instead. Do not enter `[IP]` or `[PORT:1455]` here: those tokens belong
   to the template's WebUI link. The required field is deliberately blank.
5. Select your GPU UUID from the Nvidia Driver plugin. Leave the container CUDA
   device at `0` when exposing one GPU.
6. Review Application data and Model storage paths. These are separate persistent
   mounts; the container prepares their top-level ownership as UID/GID 10001.
   Use dedicated directories, not an existing shared data directory.
7. Start the container, open WebUI, and complete the Host setup. When configuring
   local capacity, choose `/models/weights` for model weights. Downloads and
   sharing require explicit configuration.

Only port 1455 inside the container is published. The provider agent and Ollama
remain internal. The container uses a read-only root filesystem and does not
require privileged mode or access to the Docker socket.

## Updates and removal

Use Unraid's container update action (or Community Applications Auto Update).
The `latest` tag tracks the published Host image. To roll back, use the version
or immutable digest from the matching GitHub release's `container-release.json`.
Keep both storage mappings unchanged. Removing the container preserves these
folders; deleting them separately removes credentials, identity, and models.

## Community Applications submission

The source repository and template are maintained together:

- Repository: https://github.com/thibautrey/multivibe
- Template directory: https://github.com/thibautrey/multivibe/tree/main/packaging/unraid
- Template: https://raw.githubusercontent.com/thibautrey/multivibe/main/packaging/unraid/multivibe-host.xml
- Repository profile: [`ca_profile.xml`](../../ca_profile.xml) at the repository root
- Image: `ghcr.io/thibautrey/multivibe-host:latest` (Linux amd64, NVIDIA)
- Support: https://github.com/thibautrey/multivibe/issues

Before requesting inclusion:

1. Publish the reviewed files to the public repository. Confirm the raw template,
   profile, PNG icon, and support links are accessible without signing in.
2. Confirm an anonymous image pull succeeds on the intended Unraid server:
   `docker pull ghcr.io/thibautrey/multivibe-host:latest`.
3. Complete the installation above on a supported Unraid/NVIDIA machine. Record
   Unraid version, GPU, image digest, successful setup and inference, and evidence
   that restart and container recreation preserve identity and model storage.
   Also check a non-default host port and its matching Public URL, WebUI access,
   update detection, and removal without deleting appdata.
4. Open the official [Community Applications submission portal](https://ca.unraid.net/submit/new)
   and sign in with an Unraid account. Enter the public repository URL, run
   **Validate** and **Scan**, resolve reported issues, review the listing, and
   submit. The former Asana form now redirects authors to this portal; do not
   send a forum PM as the normal submission route. Keep `ca_profile.xml` at the
   repository root, as required by the
   [official starter repository](https://github.com/unraid/unraid-community-apps-starter).
   Check the current [CA policies](https://forums.unraid.net/topic/87144-ca-application-policies/),
   including the repository-owner two-factor authentication requirement, before
   making any attestations. Never claim unverified hardware testing or 2FA status.
5. After acceptance and indexing, verify a fresh Apps search finds `multivibe-host`,
   displays its icon and requirements, and installs the expected image. Remove
   the private template file when verifying public discovery so it cannot mask
   an absent public listing. Update this document only after that check succeeds.

Suggested submission text (fill in the actual test evidence before sending):

> Please review MultiVibe Host for inclusion in Community Applications.
> Repository: https://github.com/thibautrey/multivibe
> Template: packaging/unraid/multivibe-host.xml on main; profile: ca_profile.xml at the repository root.
> Public image: ghcr.io/thibautrey/multivibe-host:latest.
> This is a beta Linux amd64 NVIDIA application requiring the Nvidia Driver
> plugin and compute capability 7.0+. It runs local AI models, with opt-in provider
> sharing, persistent appdata and model storage, and no Docker socket or
> privileged mode. Support is available through the repository's issue tracker.
> Unraid installation and update test evidence: [add verified results].

Reference: the [Unraid Docker FAQ](https://forums.unraid.net/topic/57181-docker-faq/page/2/)
describes CA private repositories under
`/config/plugins/community.applications/private/NameOfRepository` on the flash drive.
