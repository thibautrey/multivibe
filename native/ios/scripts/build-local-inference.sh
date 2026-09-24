#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REVISION=53ed051ce5e8193652e449f43216ca3859454f49
CACHE="$ROOT/.build/local-inference"
SOURCE="$CACHE/llama-$REVISION"
mkdir -p "$CACHE"
if [[ ! -f "$SOURCE/CMakeLists.txt" ]]; then
  curl --fail --location --retry 3 "https://github.com/ggml-org/llama.cpp/archive/$REVISION.tar.gz" -o "$CACHE/source.tar.gz"
  tar -xzf "$CACHE/source.tar.gz" -C "$CACHE"
  mv "$CACHE/llama.cpp-$REVISION" "$SOURCE"
  rm "$CACHE/source.tar.gz"
fi
mkdir -p "$CACHE/headers"
cp "$ROOT/LocalInference/MVLlama.h" "$CACHE/headers/"
printf 'module MultiVibeLocalInference { header "MVLlama.h" export * }\n' > "$CACHE/headers/module.modulemap"
for SDK in iphoneos iphonesimulator; do
  BUILD="$CACHE/$SDK"
  cmake -S "$ROOT/LocalInference" -B "$BUILD" -G Ninja \
    -DLLAMA_SOURCE="$SOURCE" -DCMAKE_SYSTEM_NAME=iOS \
    -DCMAKE_OSX_SYSROOT="$(xcrun --sdk "$SDK" --show-sdk-path)" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=18.0 \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO
  cmake --build "$BUILD" --target MultiVibeLocalInference --parallel 4
  python3 - "$BUILD" <<'PY'
import pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]); output=root/'libCombined.a'
libs=[str(p) for p in root.rglob('*.a') if p!=output]
subprocess.run(['xcrun','libtool','-static','-o',str(output),*libs],check=True)
PY
done
OUTPUT="$ROOT/.build/MultiVibeLocalInference.xcframework"
if [[ -d "$OUTPUT" ]]; then
  python3 - "$OUTPUT" <<'PY'
import shutil,sys
shutil.rmtree(sys.argv[1])
PY
fi
xcodebuild -create-xcframework \
  -library "$CACHE/iphoneos/libCombined.a" -headers "$CACHE/headers" \
  -library "$CACHE/iphonesimulator/libCombined.a" -headers "$CACHE/headers" \
  -output "$OUTPUT"
cp "$SOURCE/LICENSE" "$ROOT/.build/llama-LICENSE"
