#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_REPO_URL:?RUNNER_REPO_URL is required}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${RUNNER_LABELS:?RUNNER_LABELS is required}"

if [[ ! -x /runner/run.sh ]]; then
  cp -a /opt/actions-runner/. /runner/
fi

cd /runner

if [[ ! -f .runner ]]; then
  token="${RUNNER_TOKEN:-}"
  if [[ -n "${RUNNER_TOKEN_FILE:-}" ]]; then
    token="$(<"${RUNNER_TOKEN_FILE}")"
  fi
  if [[ -z "$token" ]]; then
    echo 'A registration token is required for the first runner start.' >&2
    exit 64
  fi
  ./config.sh \
    --unattended \
    --replace \
    --url "$RUNNER_REPO_URL" \
    --token "$token" \
    --name "$RUNNER_NAME" \
    --labels "$RUNNER_LABELS" \
    --work _work
  unset token
fi

exec ./run.sh
