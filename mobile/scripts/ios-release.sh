#!/usr/bin/env bash
# Build the edition's iOS app on this Mac and (with --upload) send it to App Store Connect / TestFlight.
# No Expo account or EAS: expo prebuild -> xcodebuild archive (automatic signing) -> export -> altool upload.
#
#   ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id> ASC_KEY_PATH=<path to AuthKey_<key id>.p8> BUILD_NUMBER=<n> \
#     mobile/scripts/ios-release.sh [--upload]
#
# ASC_*: an App Store Connect API key (App Manager or Admin). The key is only passed to xcodebuild/altool as a path;
# this script never copies, prints or stores it. BUILD_NUMBER must be higher than every build already uploaded for
# the same version. Optional: MYCEL_MOBILE_EDITION (default trina), APPLE_TEAM_ID (default: the edition's
# appleTeamId), OUT (default mobile/build/ios-<BUILD_NUMBER>).
set -euo pipefail
upload=0
case "${1:-}" in --upload) upload=1 ;; '') ;; *) echo "usage: $0 [--upload]" >&2; exit 2 ;; esac
: "${ASC_KEY_ID:?set ASC_KEY_ID}" "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}" "${ASC_KEY_PATH:?set ASC_KEY_PATH}" "${BUILD_NUMBER:?set BUILD_NUMBER}"
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "BUILD_NUMBER must be a positive integer" >&2; exit 2; }
[[ -f "$ASC_KEY_PATH" ]] || { echo "ASC_KEY_PATH is not a file" >&2; exit 2; }
here="$(cd "$(dirname "$0")/.." && pwd)"
case "$(cd "$(dirname "$ASC_KEY_PATH")" && pwd)/" in "$(cd "$here/.." && pwd)/"*) echo "keep the API key outside the repository" >&2; exit 2 ;; esac
edition="${MYCEL_MOBILE_EDITION:-trina}"
[[ "$edition" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || { echo "invalid MYCEL_MOBILE_EDITION" >&2; exit 2; }
team="${APPLE_TEAM_ID:-$(node -p "require('$here/../editions/$edition/branding/mobile.json').appleTeamId || ''")}"
[[ "$team" =~ ^[A-Z0-9]{10}$ ]] || { echo "set APPLE_TEAM_ID or appleTeamId in editions/$edition/branding/mobile.json" >&2; exit 2; }
out="${OUT:-$here/build/ios-$BUILD_NUMBER}"
auth=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

cd "$here"
mkdir -p "$out"
npm ci --ignore-scripts --no-audit --no-fund
MYCEL_MOBILE_EDITION="$edition" MYCEL_MOBILE_BUILD_NUMBER="$BUILD_NUMBER" npx expo prebuild --platform ios --clean
workspace="$(ls -d ios/*.xcworkspace | head -1)"
scheme="$(basename "$workspace" .xcworkspace)"

xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$out/$scheme.xcarchive" "${auth[@]}" DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic archive

cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$out/$scheme.xcarchive" -exportPath "$out/export" -exportOptionsPlist "$out/ExportOptions.plist" "${auth[@]}"
ipa="$(ls "$out"/export/*.ipa | head -1)"
# The export signs with the distribution profile: push must be production there.
unzip -p "$ipa" 'Payload/*.app/embedded.mobileprovision' 2>/dev/null | security cms -D 2>/dev/null | grep -A1 aps-environment | grep -q production \
  || echo "warning: the exported profile does not say aps-environment=production; check push before uploading" >&2
echo "built $ipa"

if [[ $upload == 1 ]]; then
  xcrun altool --validate-app -f "$ipa" -t ios --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" --p8-file-path "$ASC_KEY_PATH"
  xcrun altool --upload-app -f "$ipa" -t ios --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" --p8-file-path "$ASC_KEY_PATH"
  echo "uploaded build $BUILD_NUMBER; it appears in TestFlight after Apple's processing"
fi
