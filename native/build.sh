#!/bin/bash
# Build the native helpers for macOS and Linux: bin/<os>-<arch>/{mycel-bridge,mycel-gate,mycel-launcher,mycel-bootstrap,
# mycel-safeops} (mycel-safeops: the image normalizer of AI reads, server/src/files/vision.ts, and the safe-ops 1A helper),
# plus Linux only bin/linux-<arch>/{mycel-enroll,mycel-sandbox,mycel-ctl} (ee/cloud/README.md; linux-runtime spec 3.3.4,
# 3.6.5) and bin/darwin-<arch>/mycel-ocr (Swift: PDFKit / ImageIO / Apple Vision; only when built on a Mac with swiftc).
# Linux has no OCR (docs/DECISIONS.md "AI sees images and PDF pages"): the AI sees images and scanned pages instead.
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
CMDS="mycel-bridge mycel-gate mycel-launcher mycel-bootstrap mycel-safeops"
LINUX_CMDS="mycel-enroll mycel-sandbox mycel-ctl"
for os in darwin linux; do
  for arch in $ARCHS; do
    out="bin/$os-$arch"; mkdir -p "$out"
    cmds="$CMDS"; if [[ $os == linux ]]; then cmds="$CMDS $LINUX_CMDS"; fi
    for c in $cmds; do
      CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$out/$c" "./cmd/$c"
    done
    echo "built $out"
  done
done
# macOS helper (mycel-ocr): PDF text layers and page images for AI reads, HEIC decoding, and Apple Vision OCR of scanned
# PDFs for the search index; macOS 13+, skipped without swiftc
OCR=0
if [[ "$(uname)" == Darwin ]] && command -v swiftc >/dev/null; then
  for arch in $ARCHS; do
    t=$([[ $arch == amd64 ]] && echo x86_64 || echo arm64)
    swiftc -O -target "$t-apple-macos13" -o "bin/darwin-$arch/mycel-ocr" ocr/main.swift
  done
  OCR=1
  echo "built mycel-ocr"
else
  echo "native/build.sh: no swiftc (or not macOS): mycel-ocr not built (no PDFKit pages, HEIC or scanned-PDF search on this Mac)" >&2
fi
# the universal Mac binaries need lipo (macOS only); a Linux CI build of both arches skips them
if [[ " $ARCHS " == *" arm64 "* && " $ARCHS " == *" amd64 "* ]] && command -v lipo >/dev/null; then
  mkdir -p bin/darwin-universal
  for c in $CMDS; do lipo -create "bin/darwin-arm64/$c" "bin/darwin-amd64/$c" -output "bin/darwin-universal/$c"; done
  if [[ $OCR == 1 ]]; then lipo -create bin/darwin-arm64/mycel-ocr bin/darwin-amd64/mycel-ocr -output bin/darwin-universal/mycel-ocr; fi
  echo "built bin/darwin-universal"
fi
