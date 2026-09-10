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
