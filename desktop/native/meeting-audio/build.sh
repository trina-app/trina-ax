#!/bin/bash
# Build the meeting notes' sound helper (main.swift) for the Mac app: one universal program (arm64 + x86_64), macOS
# 14.2+ (Core Audio process taps), Swift command line tools only (no Xcode project, as menubar/build.sh). The dist:mac*
# scripts run it before electron-builder, which copies desktop/native-build/meeting-audio next to the app's program in
# Contents/MacOS (electron-builder.config.ts mac.extraFiles) and signs it with the app (the inherit entitlements carry
# the microphone).
set -euo pipefail
cd "$(dirname "$0")"
[ "$(uname -s)" = Darwin ] || { echo "meeting-audio: build on a Mac" >&2; exit 2; }
out=../../native-build
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos14.2" main.swift -o "$work/meeting-audio-$arch"
done
lipo -create "$work/meeting-audio-arm64" "$work/meeting-audio-x86_64" -output "$out/meeting-audio"
chmod 755 "$out/meeting-audio"
lipo -archs "$out/meeting-audio"
