#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
BUILD=$(mktemp -d "${TMPDIR:-/tmp}/multivibe-apple-core.XXXXXX")
trap 'rm -rf "$BUILD"' EXIT HUP INT TERM
swiftc -emit-library -emit-module -enable-testing -module-name AppleVerifiedCore "$ROOT"/Sources/AppleVerifiedCore/*.swift -o "$BUILD/libAppleVerifiedCore.dylib" -emit-module-path "$BUILD/AppleVerifiedCore.swiftmodule"
clang -fsyntax-only -I "$ROOT/Sources/CHardening/include" "$ROOT/Sources/CHardening/Hardening.c"
