#!/usr/bin/env bash
# Keep daemon access and registry credentials consistent across release steps.
# The self-hosted runner may mount a socket whose numeric GID differs from docker.
set -euo pipefail
export DOCKER_CONFIG="${RUNNER_TEMP:?RUNNER_TEMP must be set}/multivibe-release-docker-config"
mkdir -p "$DOCKER_CONFIG"
if ! command docker info >/dev/null 2>&1; then
  if ! sudo -n --preserve-env=DOCKER_CONFIG docker info >/dev/null 2>&1; then
    echo 'Docker daemon is inaccessible to the runner and its non-interactive sudo context.' >&2
    return 1
  fi
  docker() { sudo -n --preserve-env=DOCKER_CONFIG docker "$@"; }
fi
