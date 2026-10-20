#!/bin/bash
# Build the Team AX menubar app with the command line tools only (swiftc; no Xcode project).
#   menubar/build.sh                 -> menubar/build/Team AX.app (unsigned; Developer ID signing needs the owner's
#                                       Apple certificate, see docs/WORKPLAN.md "막힌 것")
#   menubar/build.sh --test          -> compile and run the status-model tests
#   menubar/build.sh --id mycel-test -> app that watches /Library/Application Support/mycel-test (test installs)
set -euo pipefail
cd "$(dirname "$0")"
ID=mycel TEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --test) TEST=1; shift ;;
    --id) ID=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
ARCH=$(uname -m)
TARGET="$ARCH-apple-macos13.0"
mkdir -p build
if [ "$TEST" = 1 ]; then
  swiftc -O -target "$TARGET" -o build/status-model-tests Sources/StatusModel.swift Tests/main.swift
  ./build/status-model-tests
  exit $?
fi
APP="build/Team AX.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -parse-as-library -target "$TARGET" -o "$APP/Contents/MacOS/TeamAXMenubar" Sources/StatusModel.swift Sources/App.swift
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Team AX</string>
  <key>CFBundleDisplayName</key><string>Team AX</string>
  <key>CFBundleIdentifier</key><string>app.treesoop.$ID.menubar</string>
  <key>CFBundleExecutable</key><string>TeamAXMenubar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>MycelProductId</key><string>$ID</string>
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>CFBundleLocalizations</key><array><string>ko</string><string>en</string><string>id</string></array>
</dict></plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null
# ad-hoc signature so Gatekeeper on this Mac runs it; release builds are signed with Developer ID + notarized
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built $APP"
