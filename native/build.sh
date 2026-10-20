#!/bin/bash
# Build the native helpers for macOS and Linux (arm64; amd64 too when asked).
set -euo pipefail
cd "$(dirname "$0")"
ARCHS="${ARCHS:-arm64}"
for os in darwin linux; do
  for arch in $ARCHS; do
    out="bin/$os-$arch"; mkdir -p "$out"
    for c in mycel-bridge mycel-gate mycel-launcher; do
      CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$out/$c" "./cmd/$c"
    done
    echo "built $out"
  done
done
