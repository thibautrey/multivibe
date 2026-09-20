#!/bin/bash
# Run on an Apple Intelligence capable Mac with macOS 27 and Xcode 27.
# The harness compiles the real model/tools/HTTP implementation with UI-only stubs.
set -euo pipefail
validation_root="$(cd "$(dirname "$0")/.." && pwd)"
validation_build="$(mktemp -d /private/tmp/multivibe-local-agent-validation.XXXXXX)"
trap 'python3 -c '\''import shutil,sys; shutil.rmtree(sys.argv[1])'\'' "$validation_build"' EXIT
xcrun swiftc -parse-as-library -target arm64-apple-macos27.0 \
  -module-cache-path "$validation_build/cache" \
  "$validation_root/MultiVibeChat/Core/AgentMemory.swift" \
  "$validation_root/MultiVibeChat/Core/LocalAgent.swift" \
  "$validation_root/MultiVibeChat/Core/LocalWebFetch.swift" \
  "$validation_root/validation/LocalAgentMacHarness.swift" \
  -o "$validation_build/check"
python3 -c 'import subprocess,sys; result=subprocess.run([sys.argv[1]],timeout=90); sys.exit(result.returncode)' "$validation_build/check"
