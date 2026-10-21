#!/bin/bash
# Build the native helpers for macOS and Linux: bin/<os>-<arch>/{mycel-bridge,mycel-gate,mycel-launcher,mycel-bootstrap}.
#   bash native/build.sh                     arm64 (this repo's default; dev on Apple silicon)
#   ARCHS=amd64 bash native/build.sh         Intel
#   ARCHS="arm64 amd64" bash native/build.sh both, plus bin/darwin-universal (lipo) for a universal release bundle
#                                            (bun scripts/build-bundle.ts --arch universal)
set -euo pipefail
cd "$(dirname "$0")"
ARCHS="${ARCHS:-arm64}"
for arch in $ARCHS; do
  case "$arch" in arm64|amd64) ;; *) echo "native/build.sh: ARCHS takes arm64 and/or amd64, not $arch" >&2; exit 2 ;; esac
done
CMDS="mycel-bridge mycel-gate mycel-launcher mycel-bootstrap"
for os in darwin linux; do
  for arch in $ARCHS; do
    out="bin/$os-$arch"; mkdir -p "$out"
    for c in $CMDS; do
      CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$out/$c" "./cmd/$c"
    done
    echo "built $out"
  done
done
if [[ " $ARCHS " == *" arm64 "* && " $ARCHS " == *" amd64 "* ]]; then
  mkdir -p bin/darwin-universal
  for c in $CMDS; do lipo -create "bin/darwin-arm64/$c" "bin/darwin-amd64/$c" -output "bin/darwin-universal/$c"; done
  echo "built bin/darwin-universal"
fi
