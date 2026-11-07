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
edition_json="$here/../editions/$edition/branding/mobile.json"
# paths go to node as arguments, never into the JavaScript text
edition_team="$(node -p "require(process.argv[1]).appleTeamId || ''" "$edition_json")"
team="${APPLE_TEAM_ID:-$edition_team}"
[[ "$team" =~ ^[A-Z0-9]{10}$ ]] || { echo "set APPLE_TEAM_ID or appleTeamId in editions/$edition/branding/mobile.json" >&2; exit 2; }
# The notification service extension's keychain group carries the edition's team id (plugins/notification-service.js):
# a build signed by another team could not share it, and the app would show no names.
[[ -z "$edition_team" || "$team" == "$edition_team" ]] || { echo "APPLE_TEAM_ID must be the edition's appleTeamId ($edition_team)" >&2; exit 2; }
bundle_id="$(node -p "require(process.argv[1]).bundleId" "$edition_json")"
out="${OUT:-$here/build/ios-$BUILD_NUMBER}"
auth=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

cd "$here"
mkdir -p "$out"
# For the whole run, not only prebuild: Expo's build phase "Generate app.config for prebuilt Constants.manifest" runs
# `expo config` again inside xcodebuild, and that config (name, user agent, push flags) is what the app reads at runtime.
export MYCEL_MOBILE_EDITION="$edition" MYCEL_MOBILE_BUILD_NUMBER="$BUILD_NUMBER"
npm ci --ignore-scripts --no-audit --no-fund
npx expo prebuild --platform ios --clean
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
# The app must read the edition's config at runtime, not the neutral one.
unzip -p "$ipa" 'Payload/*.app/EXConstants.bundle/app.config' > "$out/app.config.json"
node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')),want=require(process.argv[2]);if(c.name!==want.name||c.extra?.teamAxEdition?.bundleId!==want.bundleId){console.error('embedded app.config is not the edition ('+c.name+')');process.exit(1)}" "$out/app.config.json" "$edition_json"
# The export signs with the distribution profile: push must be production there. Files, not pipes, so set -o pipefail
# cannot turn an early-exiting reader into a false warning.
unzip -p "$ipa" 'Payload/*.app/embedded.mobileprovision' > "$out/embedded.mobileprovision" 2>/dev/null || true
security cms -D -i "$out/embedded.mobileprovision" > "$out/profile.plist" 2>/dev/null || true
aps="$(plutil -extract Entitlements.aps-environment raw -o - "$out/profile.plist" 2>/dev/null || true)"
[[ "$aps" == production ]] || echo "warning: the exported profile says aps-environment='$aps', not production; check push before uploading" >&2
if [[ -n "$edition_team" ]]; then
  # The notification service extension (who and where in a room push): embedded, its own bundle id, its own
  # distribution profile, the app's version and build number, and the keychain groups as signed: the app's own group
  # first (where its other keychain items have always been), then the group it shares with the extension; the extension
  # only that shared group.
  rm -rf "$out/payload"; mkdir -p "$out/payload"
  unzip -q "$ipa" 'Payload/*' -d "$out/payload"
  app_dir="$(ls -d "$out"/payload/Payload/*.app | head -1)"
  appex="$app_dir/PlugIns/NotificationService.appex"
  [[ -d "$appex" ]] || { echo "the app has no notification service extension" >&2; exit 1; }
  [[ -f "$appex/embedded.mobileprovision" ]] || { echo "the notification service extension has no provisioning profile" >&2; exit 1; }
  plist_value() { plutil -extract "$1" raw -o - "$2" 2>/dev/null || true; }
  [[ "$(plist_value CFBundleIdentifier "$appex/Info.plist")" == "$bundle_id.NotificationService" ]] || { echo "the extension's bundle id is not $bundle_id.NotificationService" >&2; exit 1; }
  for key in CFBundleShortVersionString CFBundleVersion; do
    [[ "$(plist_value "$key" "$appex/Info.plist")" == "$(plist_value "$key" "$app_dir/Info.plist")" ]] || { echo "the extension's $key differs from the app's" >&2; exit 1; }
  done
  codesign -d --entitlements - --xml "$app_dir" > "$out/app-entitlements.plist" 2>/dev/null
  codesign -d --entitlements - --xml "$appex" > "$out/extension-entitlements.plist" 2>/dev/null
  access_groups() { plutil -extract keychain-access-groups json -o - "$1" 2>/dev/null || echo null; }
  node -e "const [a,x,t,b]=process.argv.slice(1),eq=(v,w)=>JSON.stringify(JSON.parse(v))===JSON.stringify(w)
if(!eq(a,[t+'.'+b,t+'.'+b+'.notifications'])){console.error('the app is signed with keychain groups '+a);process.exit(1)}
if(!eq(x,[t+'.'+b+'.notifications'])){console.error('the extension is signed with keychain groups '+x);process.exit(1)}" \
    "$(access_groups "$out/app-entitlements.plist")" "$(access_groups "$out/extension-entitlements.plist")" "$team" "$bundle_id"
fi
echo "built $ipa"

if [[ $upload == 1 ]]; then
  xcrun altool --validate-app -f "$ipa" -t ios --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" --p8-file-path "$ASC_KEY_PATH"
  xcrun altool --upload-app -f "$ipa" -t ios --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID" --p8-file-path "$ASC_KEY_PATH"
  echo "uploaded build $BUILD_NUMBER; it appears in TestFlight after Apple's processing"
fi
