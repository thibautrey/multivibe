#!/bin/sh

set -eu

# The edge and the control plane must share this capability. Generate it once
# in the supervisor so both children receive the exact same value.
if [ -z "${V1_EDGE_INTERNAL_JOB_TOKEN:-}" ]; then
  V1_EDGE_INTERNAL_JOB_TOKEN=$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n=' | cut -c 1-43)
  export V1_EDGE_INTERNAL_JOB_TOKEN
fi

export MULTIVIBE_CONTROL_PLANE=true
export TRACE_JOURNAL_MAX_BYTES="${TRACE_JOURNAL_MAX_BYTES:-67108864}"
export CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-1456}"
export V1_EDGE_PORT="${V1_EDGE_PORT:-1455}"
export V1_EDGE_HOST="${V1_EDGE_HOST:-0.0.0.0}"
export NODE_CONTROL_PLANE_URL="${NODE_CONTROL_PLANE_URL:-http://127.0.0.1:${CONTROL_PLANE_PORT}}"
export V1_EDGE_BASE_URL="${V1_EDGE_BASE_URL:-http://127.0.0.1:${V1_EDGE_PORT}}"

# PORT/HOST are read by the Node config module. Keep Node loopback-only while
# Rust owns the public socket.
export PORT="$CONTROL_PLANE_PORT"
export HOST=127.0.0.1

# Do not start a TLS listener without its certificate: the Rust edge would
# only log a tls_error and Codex would see a connection failure. The relay is
# optional, so disable it explicitly and leave a diagnostic instead.
if [ -n "${BACKEND_RELAY_PORT:-}" ]; then
  relay_cert="${BACKEND_RELAY_CERT:-/data/tls/server.pem}"
  relay_key="${BACKEND_RELAY_KEY:-/data/tls/server.key}"
  if [ ! -f "$relay_cert" ] || [ ! -f "$relay_key" ]; then
    echo "backend relay disabled: missing TLS certificate/key ($relay_cert, $relay_key)" >&2
    echo "run scripts/generate-backend-relay-cert.sh or mount existing files" >&2
    unset BACKEND_RELAY_PORT
  fi
fi

node --import ./dist/instrument.js dist/server.js &
node_pid=$!

/opt/multivibe/bin/multivibe-v1-edge &
edge_pid=$!

terminate_children() {
  trap - INT TERM EXIT
  kill -TERM "$node_pid" "$edge_pid" 2>/dev/null || true
  wait "$node_pid" 2>/dev/null || true
  wait "$edge_pid" 2>/dev/null || true
}

trap terminate_children INT TERM EXIT

while :; do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    wait "$node_pid" || node_status=$?
    kill -TERM "$edge_pid" 2>/dev/null || true
    wait "$edge_pid" 2>/dev/null || true
    exit "${node_status:-0}"
  fi
  if ! kill -0 "$edge_pid" 2>/dev/null; then
    wait "$edge_pid" || edge_status=$?
    kill -TERM "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true
    exit "${edge_status:-0}"
  fi
  sleep 1
done
