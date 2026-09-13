#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu
APP=${1:?Provide the signed MultiVibeVerifiedHost.app}
codesign --verify --deep --strict "$APP"
META=$(codesign -dvv "$APP" 2>&1)
printf '%s' "$META" | grep -q 'runtime' || { echo 'Hardened runtime required' >&2; exit 1; }
ENT=$(mktemp "${TMPDIR:-/tmp}/multivibe-entitlements.XXXXXX")
trap 'rm -f "$ENT"' EXIT HUP INT TERM
codesign -d --entitlements :- "$APP" > "$ENT" 2>/dev/null
python3 - "$ENT" "$APP" <<'PY'
import json, pathlib, plistlib, sys
ent = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
allowed = {'com.apple.security.app-sandbox', 'com.apple.security.network.client', 'com.apple.developer.aps-environment', 'com.apple.application-identifier', 'com.apple.developer.team-identifier', 'keychain-access-groups'}
assert not set(ent) - allowed, 'Unreviewed entitlement'
assert ent.get('com.apple.security.app-sandbox') is True
assert ent.get('com.apple.security.network.client') is True
assert ent.get('com.apple.developer.aps-environment') == 'production'
app = pathlib.Path(sys.argv[2])
assert (app / 'Contents/embedded.provisionprofile').is_file(), 'APNs provisioning profile required'
config = json.loads((app / 'Contents/Resources/runtime.json').read_text())
assert config.get('enabled') is False, 'Distributed app must default to disabled'
assert (app / 'Contents/MacOS/MultiVibeVerifiedHost').is_file()
print('Signature, hardened runtime, entitlement allowlist and disabled default checked; remote qualification remains required.')
PY
