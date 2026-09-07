# MultiVibe Host distribution review

Reviewed 2026-09-07. Recommendations, not submissions or platform certification.
Unraid has accepted the repository; catalog publication is a separate step.

## Current fit

The latest release inspected was v0.2.32: macOS has arm64/amd64 DMGs,
Windows has an amd64 ZIP (~1.54 GB), and Linux has a split amd64 archive
(~2.78 GB combined). The Linux container and native Linux/Windows Host require
a supported NVIDIA GPU. The container exposes a dashboard/API and persists
application state and model storage separately. A generic ARM or CPU-only NAS
listing would misrepresent the current supported deployment.

## Recommended channels

| Priority | Channel | Submission and implementation | Maintenance / limitation |
| --- | --- | --- | --- |
| 1 | TrueNAS Apps | Submit a catalog PR with app metadata, configuration questions and Jinja-rendered Compose. Reuse the published GHCR image. | Medium. Test GPU selection, dataset ownership, origin configuration and updates on TrueNAS. Closest match to the Unraid audience. |
| 2 | CasaOS / ZimaOS | Submit an app PR to IceWhale's store with Compose, `x-casaos` metadata and artwork. Current contribution docs target ZimaOS v2 and retain legacy compatibility output. | Medium. Explicitly restrict architecture and verify NVIDIA support on the target OS/version; do not assume every CasaOS device is compatible. |
| 3 | Homebrew | Start with a publisher-maintained macOS cask tap for the existing signed/notarized DMGs; consider an upstream homebrew/cask PR after checking acceptance policies. | Low–medium. Version/checksum updates, both architectures, install/uninstall tests and clear handling of the native updater. An own tap does not grant inclusion in the default catalog. |
| 4 | Docker Hub | Publish the existing release image to a public publisher repository with deployment documentation. | Low–medium. Synchronize releases with GHCR and preserve provenance; this is a registry/discovery channel, not one-click NAS setup or Docker Official Image status. |
| 5 | WinGet | Submit manifests to microsoft/winget-pkgs after making the Windows installation suitable for supported unattended install/uninstall. | Medium–high. The current ZIP requires install.ps1; plan a signed EXE/MSI installer or validate a supported archive installer design. A ZIP manifest alone does not reproduce scheduled tasks and protocol registration. |
| 6 | Umbrel | Submit an app package to umbrel-apps, with web-based first-run setup and platform integration. | Medium–high. Investigate supported NVIDIA access first; the current Linux image cannot target ARM/CPU-only devices. |

## Lower priority

Runtipi's official store explicitly says it accepts no new applications. Use a
community-maintained or publisher-owned store if demand warrants maintaining one.
It is not currently a normal official-store submission opportunity.

For all container channels, keep one upstream image and a thin platform-specific
package. Verify GPU access, public URL/reverse-proxy behavior, private setup,
state/model persistence through recreation, and platform-controlled updates.
Use each catalog's required versioning scheme; do not blindly copy Unraid's
rolling-tag policy. Do not duplicate the native updater inside containers.

Recommended execution order: TrueNAS, CasaOS/ZimaOS, Homebrew tap, then Docker
Hub. WinGet follows Windows installer work. Estimates are relative engineering
judgments, not promised review times or measured audience reach.

## Primary sources

- Release assets: https://github.com/thibautrey/multivibe/releases/tag/v0.2.32
- TrueNAS contribution guide: https://github.com/truenas/apps/blob/master/CONTRIBUTIONS.md
- CasaOS/ZimaOS contribution guide: https://github.com/IceWhaleTech/CasaOS-AppStore/blob/main/CONTRIBUTING.md
- ZimaOS packaging: https://github.com/IceWhaleTech/CasaOS-AppStore/blob/main/docs/quick-start/overview.md
- Homebrew cask policy: https://docs.brew.sh/Acceptable-Casks
- Docker Hub repository creation: https://docs.docker.com/docker-hub/repos/create/
- WinGet submission: https://learn.microsoft.com/en-us/windows/package-manager/package/repository
- WinGet manifests: https://learn.microsoft.com/en-us/windows/package-manager/package/manifest
- Umbrel packaging standards: https://github.com/getumbrel/umbrel-apps
- Runtipi submission restriction: https://github.com/runtipi/runtipi-appstore
