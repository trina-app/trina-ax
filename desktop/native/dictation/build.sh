#!/bin/bash
# Build voice input's on-device helper (main.swift) for the Mac app: one universal program (arm64 + x86_64), Swift
# command line tools only (no Xcode project). It runs on macOS 12 and later (the Electron floor) and says "unavailable"
# below macOS 26 or on an Intel Mac, so the app falls back to the team server there. SpeechTranscriber needs the
# macOS 26 SDK: when the selected Xcode's is older (a CI runner's default), the newest /Applications/Xcode_26*.app or
# Xcode.app with a 26+ SDK is used instead; with none, the app is built without it (a warning; the server transcribes). The dist:mac* scripts run this before electron-builder, which copies
# desktop/native-build/dictation next to the app's program in Contents/MacOS (electron-builder.config.ts
# mac.extraFiles) and signs it with the app (hardened runtime, the inherit entitlements).
set -euo pipefail
cd "$(dirname "$0")"
[ "$(uname -s)" = Darwin ] || { echo "dictation: build on a Mac" >&2; exit 2; }

sdk_major() { DEVELOPER_DIR="$1" xcrun --sdk macosx --show-sdk-version 2>/dev/null | cut -d. -f1; }
current=$(xcode-select -p 2>/dev/null || true)
if [ "$(sdk_major "$current")" -lt 26 ] 2>/dev/null || [ -z "$(sdk_major "$current")" ]; then
  pick=""
  for x in $(ls -d /Applications/Xcode_26*.app /Applications/Xcode.app 2>/dev/null | sort -rV); do
    d="$x/Contents/Developer"
    if [ -d "$d" ] && [ "$(sdk_major "$d")" -ge 26 ] 2>/dev/null; then pick="$d"; break; fi
  done
  if [ -z "$pick" ]; then
    # the app still builds and works: without the helper the team server transcribes (a warning, never a failed DMG)
    echo "::warning::dictation: no Xcode with the macOS 26 SDK (SpeechTranscriber; found $(sdk_major "$current") at $current): the app ships without on-device voice input" >&2
    rm -f ../../native-build/dictation
    exit 0
  fi
  export DEVELOPER_DIR="$pick"
fi
echo "dictation: macOS SDK $(xcrun --sdk macosx --show-sdk-version) ($(xcrun --find swiftc))"

out=../../native-build
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for arch in arm64 x86_64; do
  xcrun --sdk macosx swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" main.swift -o "$work/dictation-$arch"
done
lipo -create "$work/dictation-arm64" "$work/dictation-x86_64" -output "$out/dictation"
chmod 755 "$out/dictation"
lipo -archs "$out/dictation"
