# MultiVibe GitHub Actions workers on Unraid

Do not send untrusted pull-request code to these runners. The workflow labels
in this directory are used only by trusted release-tag and manual-release jobs:

- `multivibe-linux`: amd64 jobs without Docker access.
- `multivibe-docker`: amd64 jobs that build or inspect container images.

The ARM64 Umbrel matrix entry and all macOS/Windows jobs remain GitHub-hosted.

## Build the image

Build this image on the Unraid host from the checked-out repository:

```sh
docker build \
  --tag multivibe/github-actions-runner:2.336.0-deploy \
  packaging/unraid/github-actions-runner
```

The `2.336.0-deploy` image includes the pinned Kubernetes client used by the
landing and Cloud deployment workflows. Actions such as `setup-node` and the
Cosign installer continue to install the workflow-pinned Node and Cosign
versions at job runtime.

The runner tool cache is `/runner/_tool`, inside the persistent runner bind
mount, so downloaded tools remain executable across jobs and container
restarts. Keep `/runner` owned by UID/GID `1001`; do not replace the tool cache
with a root-owned temporary mount.

Use a separate persistent directory for each runner. The registration token is
short-lived and must not be committed. The entrypoint accepts it from a file so
it does not appear in the container command line or persistent environment:

```sh
mkdir -p /mnt/user/appdata/multivibe-github-runner-linux
mkdir -p /mnt/user/appdata/multivibe-github-runner-docker
chown 1001:1001 /mnt/user/appdata/multivibe-github-runner-linux \
  /mnt/user/appdata/multivibe-github-runner-docker
```

Create a repository registration token with `POST
/repos/thibautrey/multivibe/actions/runners/registration-token`, write it to a
temporary `/run` file with mode `600`, and remove that file immediately after
the container starts. Use labels `multivibe-linux` and `multivibe-docker`
respectively. The runner URL is
`https://github.com/thibautrey/multivibe`.

The image's `runner` account uses UID/GID `1001`; make each persistent runner
directory owned by that numeric identity. Mount the temporary host token file
at `/run/multivibe-runner-token` inside the container, as in the command below.

The Docker worker additionally needs the host Docker socket and the socket's
numeric group as a supplementary group. This is equivalent to granting the
worker root-equivalent control over Docker on Unraid, so keep that worker
dedicated to this repository and do not use it for pull-request workflows:

```sh
docker run -d \
  --name multivibe-github-runner-docker \
  --restart unless-stopped \
  --init \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:rw,nosuid,nodev \
  --tmpfs /run:rw,nosuid,nodev \
  --mount type=bind,src=/mnt/user/appdata/multivibe-github-runner-docker,dst=/runner \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src=/run/multivibe-github-runner-docker.token,dst=/run/multivibe-runner-token,readonly \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  --env RUNNER_REPO_URL=https://github.com/thibautrey/multivibe \
  --env RUNNER_NAME=multivibe-unraid-docker-1 \
  --env RUNNER_LABELS=multivibe-docker \
  --env RUNNER_TOOL_CACHE=/runner/_tool \
  --env RUNNER_TOKEN_FILE=/run/multivibe-runner-token \
  multivibe/github-actions-runner:2.336.0-deploy
```

The Linux worker uses the same command without the Docker socket and with
`multivibe-linux` values. Verify both runners are `online` and `idle` in the
repository Actions settings before enabling the workflow changes.

## Host releases when GitHub-hosted minutes are exhausted

The Provider Host Release workflow keeps Linux build, signing, container
publication and GitHub release publication on the two self-hosted runners.
macOS and Windows remain GitHub-hosted; no such self-hosted runners were
registered during the 2026-09-11 check.

Normally all platforms are attempted. An evidence gate reads the run's jobs,
artifacts and check annotations. It accepts a missing hosted platform only
when GitHub reports a quota/spending-limit rejection before build steps ran.
Successful sibling platforms remain included. Real compilation, test,
verification, upload or signing failures still block publication, even though
the optional hosted jobs use `continue-on-error` so a recognized quota
rejection does not mark the entire workflow as failed. Unknown runner failures
fail closed rather than being misreported as quota exhaustion.

To avoid scheduling GitHub-hosted jobs at all during a known quota outage:

- Set repository variable `HOSTED_RELEASE_BUILDS_ENABLED` to `false` for tagged
  Host releases. Remove it or set it to `true` when hosted builds should resume.
- Or dispatch Provider Host Release from a release tag with
  `self_hosted_only: true` for that run.

Neither mode changes the required Linux validation or signing checks. No
billing-management token or permissions are needed for automatic fallback;
only the current run's Actions and Checks read permissions are used.

The release includes only selected, successfully uploaded native artifacts.
Signing accepts a nonempty subset while preserving archive checks, SBOMs,
source-commit consistency, GPG, Sigstore and update-feed signatures. For DMGs,
the macOS job publishes an attested verifier report. The Linux signer verifies
its GitHub attestation, expected workflow/commit, readiness and exact DMG hash
before signing; it never pretends to mount or notarization-check a DMG on Linux.

Release notes explicitly list omitted platforms. The update feed contains no
links for missing archives. Container distributions are still generated;
Homebrew is omitted unless both Mac builds exist, and WinGet is omitted when
there is no Windows installer. Existing releases are never overwritten to
backfill omitted platforms: publish a new tag after capacity is restored.

The updated Host updater accepts a nonempty supported subset and treats an
absent current-platform target as no available update. **Older Host versions
require all five targets and cannot consume a partial feed**: install the first
partial-capable Host manually, or wait for a full-platform release. Nothing
installs another platform's archive or relabels old binaries as the new version.

Scope: `provider-host-release.yml`. The separate immutable `source-v*` workflow
keeps its GitHub-hosted attestation requirement because Cloud verifies it with
`--deny-self-hosted-runners`. The manually triggered Umbrel multiarchitecture
pipeline has a separate manifest contract and is unchanged.
