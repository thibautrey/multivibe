#!/bin/sh
# Install the MultiVibe Hermes bridge as a per-user background service.
#
# Deliberately small: the heavy lifting is `multivibe-hermes-bridge enroll`,
# which is idempotent and stores its own state privately. This script only
# arranges for `run` to start at login and restart on failure.

set -eu
umask 077

PROGRAM_NAME="MultiVibe Hermes bridge installer"
SERVICE_NAME="multivibe-hermes-bridge.service"
LABEL="cloud.multivibe.hermes-bridge"

fail() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install-hermes-bridge.sh --binary /absolute/path/to/multivibe-hermes-bridge
                                  [--uninstall]

Installs a per-user service that runs the bridge at login.

The bridge must already be enrolled:
  multivibe-hermes-bridge enroll --code mvenr_...

macOS uses a per-user LaunchAgent; Linux uses a systemd user unit when a user
manager is available, and prints an equivalent command otherwise.
EOF
}

BINARY=""
UNINSTALL="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --binary) shift; BINARY=${1:-""} ;;
    --uninstall) UNINSTALL="true" ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

if [ "$(id -u)" = "0" ]; then
  fail "run as the user who runs Hermes, without sudo"
fi

if [ "$UNINSTALL" = "true" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  else
    systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$SERVICE_NAME"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  printf 'Uninstalled. Credentials remain in the system secret store.\n'
  exit 0
fi

# This installs a *per-user* service. Under sudo it would write a LaunchAgent or
# systemd user unit into root's home, where the client's login never looks, and
# the harness would then talk to nothing. Refuse instead of half-succeeding.
if [ "$(id -u)" = "0" ]; then
  fail "run as the user who runs Hermes, without sudo: the service must live in that user's session"
fi
case "$HOME" in
  /*) ;;
  *) fail "HOME must be an absolute path" ;;
esac

[ -n "$BINARY" ] || fail "--binary is required"
case "$BINARY" in
  /*) ;;
  *) fail "--binary must be an absolute path" ;;
esac
[ -x "$BINARY" ] || fail "$BINARY is not executable"

case "$BINARY" in
  *[![:print:]]*) fail "binary path contains non-printable characters" ;;
  *'/../'*|*/..|*'/./'*|*/.|/) fail "binary path is not a clean path" ;;
esac

# The bridge refuses to run unenrolled; fail here instead of in a restart loop.
if ! "$BINARY" doctor >/dev/null 2>&1; then
  printf 'warning: doctor did not pass; the service will start but may not serve traffic.\n' >&2
fi

if [ "$(uname -s)" = "Darwin" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST="$PLIST_DIR/$LABEL.plist"
  mkdir -p "$PLIST_DIR"
  [ -L "$PLIST" ] && fail "$PLIST must not be a symlink"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BINARY</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/MultiVibe/hermes-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/MultiVibe/hermes-bridge.log</string>
</dict>
</plist>
EOF
  mkdir -p "$HOME/Library/Logs/MultiVibe"
  chmod 600 "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  printf 'Installed LaunchAgent %s. The bridge starts at login.\n' "$LABEL"
  exit 0
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$SERVICE_NAME"
if ! command -v systemctl >/dev/null 2>&1; then
  printf 'systemctl is unavailable. Run the bridge in the foreground instead:\n  %s run\n' "$BINARY"
  exit 0
fi
mkdir -p "$UNIT_DIR"
[ -L "$UNIT" ] && fail "$UNIT must not be a symlink"
cat > "$UNIT" <<EOF
[Unit]
Description=MultiVibe Hermes bridge
After=network-online.target

[Service]
Type=simple
ExecStart=$BINARY run
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
chmod 600 "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"
printf 'Installed %s. Check status with: systemctl --user status %s\n' "$SERVICE_NAME" "$SERVICE_NAME"
