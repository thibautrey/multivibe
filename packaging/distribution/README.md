# Additional Host distribution channels

These are packaging implementations, not claims of store acceptance. Only
Unraid has been submitted. Work through the channels in the order below.

## 1. Docker Hub

`distribution-dockerhub.yml` mirrors an existing, attested GHCR release using
Skopeo with digest preservation. It rejects conflicting version tags and updates
`latest` only when the requested version is GitHub's latest stable release.

Create the public `multivibe-host` repository in the publisher's Docker Hub
namespace, then configure the GitHub `dockerhub` environment:

- Variables `DOCKERHUB_NAMESPACE` and `DOCKERHUB_USERNAME`.
- Secret `DOCKERHUB_TOKEN`, scoped to the destination repository.

The publishing script requires a modern GitHub CLI with `gh attestation verify`,
Skopeo, jq and Node. The GitHub-hosted workflow supplies these tools.

Run **Publish Host image to Docker Hub** with the existing stable release tag.
This does not claim Docker Official Image status. Configure the public Docker
Hub description from the container guide; keep GHCR as the canonical release
identity. Re-run the workflow per release. Do not move Unraid or the catalogs to
the mirror until public pulls have been verified.

## 2. Homebrew (macOS)

`packaging/homebrew/Casks/multivibe-host.rb` pins the two DMGs and their respective
SHA-256 values from v0.2.32. Copy the contents of `packaging/homebrew/` to a
publisher-maintained `homebrew-multivibe` repository and publish it. Then users
can install with:

```sh
brew tap thibautrey/multivibe https://github.com/thibautrey/homebrew-multivibe
brew install --cask thibautrey/multivibe/multivibe-host
```

The tap URL above is the intended publication target, not an assertion that it
already exists. Before publication, test with Homebrew on both supported Macs:

```sh
brew audit --cask --online multivibe-host
brew install --cask multivibe-host
brew uninstall --cask multivibe-host
```

Launch from Applications to complete setup. The cask declares the existing
native auto-updater, quits the app/stops its LaunchAgents on removal, and keeps
private data and model files. Default Homebrew catalog acceptance is separate
from operating our own tap. Test updates as well as first installation.

## 3. TrueNAS Apps

The catalog package is `packaging/truenas/multivibe-host/`. Copy it into
`ix-dev/community/multivibe-host/` in the upstream `truenas/apps` repository.
The upstream CI helper supplies the pinned rendering library; do not copy the
library from an arbitrary latest version. Follow CONTRIBUTIONS.md and run:

```sh
./.github/scripts/ci.py --app multivibe-host --train community --test-file basic-values.yaml --render-only=true
```

The package requires a selected NVIDIA GPU, a public URL and two dedicated host
paths. Startup assigns their ownership to UID/GID 10001. Select datasets meant
only for this app. `templates/test_values/basic-values.yaml` contains reserved
example addresses and a dummy GPU UUID for rendering, not live deployment.
Test GPU inference, permissions, non-default port, restart/update and retention
on TrueNAS before opening a catalog PR. Increment the catalog `version` for
subsequent package updates independently of upstream `app_version`.

`packaging/truenas/docker-compose.custom.yml` also supports a custom Compose
installation. Supply the required origin, GPU UUID and dedicated storage paths;
these inputs deliberately fail validation when omitted.

## 4. CasaOS / ZimaOS

Copy `packaging/casaos/Apps/MultiVibeHost/` into the upstream app-store tree, run
its `scripts/build_dist.sh`, and submit a PR after a real installation test.
The Compose file uses the NVIDIA runtime, amd64 only, version/digest pinning and
standard `/DATA/AppData/multivibe-host/` persistence. The public URL is blank on
purpose: set `MULTIVIBE_HOST_PUBLIC_URL` in app settings before startup, for
example `http://192.168.1.10:1455`. A blank URL fails closed in the Host. Set
`NVIDIA_VISIBLE_DEVICES` to one GPU UUID when desired and keep container CUDA
index 0. Match the public URL and store launch port when changing the host port.
This package requires the NVIDIA runtime to be installed and configured.

Current v2 contribution rules:
https://github.com/IceWhaleTech/CasaOS-AppStore/blob/main/CONTRIBUTING.md

## 5. Windows installer and WinGet

`packaging/windows/multivibe-host.iss` wraps the existing verified native
installer. It installs per-user, delegates setup and rollback to `install.ps1`,
and registers an Apps & Features uninstaller in a separate maintenance directory
so it does not interfere with the managed native version layout. Uninstall
preserves user data and models. An installer failure is propagated; a native
uninstaller failure keeps the maintenance entry for retry.

Set `WINDOWS_INSTALLER_ENABLED=true` in repository variables to include the
installer in future **stable** Host releases. Configure code-signing secrets
`WINDOWS_CODESIGN_PFX_BASE64` and `WINDOWS_CODESIGN_PFX_PASSWORD` on the disposable
Windows release runner. Signing is required when this feature is enabled;
missing credentials fail the job. Use a suitable trusted code-signing identity.
The workflow downloads a checksum-pinned Inno compiler, verifies the native ZIP,
builds the EXE, signs and timestamps it, verifies Authenticode, attests the EXE,
and includes it in the signed release checksum ledger. Do not add a new EXE to
an existing immutable release.

The release workflow emits WinGet manifests only when the setup EXE exists.
Hashes are computed after signing. Before submitting those files to
`microsoft/winget-pkgs`, run `winget validate` and Microsoft's SandboxTest.ps1,
and test on Windows x64 with a supported NVIDIA GPU. The clean-runner wrapper
CI test checks silent install/uninstall and error propagation using tiny native
script stand-ins; it does not prove GPU installation or inference works.

The existing native updater remains in charge after installation. Its native
version can advance independently of the wrapper's Apps & Features version;
WinGet may offer the wrapper update again. Users can choose notification-only
updates in MultiVibe if they prefer to update solely through WinGet.

## Umbrel

See `packaging/umbrel/README.md`. Linux ARM64 and amd64 CPU support, conservative
small-model profiles, native CI builds and a multiarchitecture package generator
are implemented. Image publication and real Umbrel hardware/browser validation
remain prerequisites for official submission.

## Refresh and validate

Use the checksum ledger and container metadata from the same trusted stable
release. Verify their GitHub attestations or release signatures before using
files downloaded outside the release workflow. This generator validates their
identity/shape, not their remote provenance:

```sh
node scripts/distribution/generate.mjs /path/container-release.json /path/SHA256SUMS packaging
node --test scripts/distribution/*.test.mjs
ruby -c packaging/homebrew/Casks/multivibe-host.rb
bash -n scripts/distribution/publish-dockerhub.sh
```

Successful stable releases also upload a `distribution-packages` workflow
artifact containing regenerated Homebrew and NAS files, plus WinGet manifests
when enabled. This neither commits the generated files nor publishes third-party
store entries. Review catalog-specific versions and complete platform validation
before publishing. Keep image builds centralized and keep the Docker socket out
of app containers.
