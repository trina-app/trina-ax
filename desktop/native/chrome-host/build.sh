#!/bin/bash
# Build the <app> in Chrome extension's native messaging helper (main.swift) for the Mac app: one universal program
# (arm64 + x86_64), Swift command line tools only, macOS 12 and later (the Electron floor). The dist:mac* scripts run
# this before electron-builder, which copies desktop/native-build/chrome-host next to the app's program in
# Contents/MacOS (electron-builder.config.ts mac.extraFiles) and signs it with the app. It is a separate small program
# because the app's fuses forbid running Electron as Node (runAsNode: false).
# The app's data folder name (PRODUCT.desktopDataDir) is written into config.swift here: the helper finds the app's
# socket under ~/Library/Application Support/<it>/chrome/pair.sock.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(uname -s)" = Darwin ] || { echo "chrome-host: build on a Mac" >&2; exit 2; }

out=../../native-build
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dir=$(bun -e 'import { PRODUCT } from "../../../shared/src/product"; process.stdout.write(JSON.stringify(PRODUCT.desktopDataDir))')
printf 'let appDataDir = %s\n' "$dir" > "$work/config.swift"
# release builds (dist:mac:release) name the Developer ID team whose signature the socket's program must carry
team="${CHROME_HOST_TEAM_ID:-}"
[[ "$team" =~ ^[A-Z0-9]{0,10}$ ]] || { echo "chrome-host: bad CHROME_HOST_TEAM_ID" >&2; exit 2; }
printf 'let requiredTeam = "%s"\n' "$team" >> "$work/config.swift"
for arch in arm64 x86_64; do
  xcrun --sdk macosx swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" main.swift "$work/config.swift" -o "$work/chrome-host-$arch"
done
lipo -create "$work/chrome-host-arm64" "$work/chrome-host-x86_64" -output "$out/chrome-host"
chmod 755 "$out/chrome-host"
lipo -archs "$out/chrome-host"
