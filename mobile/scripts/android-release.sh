#!/usr/bin/env bash
# Build the edition's Android App Bundle (.aab) for Google Play on this machine, signed with the upload key.
# No Expo account or EAS: expo prebuild -> ./gradlew bundleRelease -> checks -> the .aab path.
#
#   ANDROID_KEYSTORE_PATH=<outside the repo>/upload.jks ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=… \
#   ANDROID_KEY_PASSWORD=… BUILD_NUMBER=<n> mobile/scripts/android-release.sh
#
# The keystore stays where it is and must lie outside the repository; the passwords reach Gradle only through the
# environment (plugins/release-signing.js) and are never printed or written. BUILD_NUMBER is the versionCode and must
# be higher than every bundle already uploaded. Optional: MYCEL_MOBILE_EDITION (default trina),
# MYCEL_MOBILE_GOOGLE_SERVICES (google-services.json: without it the app has no push on Android), ANDROID_HOME (the
# Android SDK), JAVA_HOME (JDK 17; on macOS found with /usr/libexec/java_home -v 17), BUNDLETOOL (the bundletool-all release jar, to
# print the manifest), OUT (default mobile/build/android-<BUILD_NUMBER>).
set -euo pipefail
: "${ANDROID_KEYSTORE_PATH:?set ANDROID_KEYSTORE_PATH}" "${ANDROID_KEYSTORE_PASSWORD:?set ANDROID_KEYSTORE_PASSWORD}" \
  "${ANDROID_KEY_ALIAS:?set ANDROID_KEY_ALIAS}" "${ANDROID_KEY_PASSWORD:?set ANDROID_KEY_PASSWORD}" "${BUILD_NUMBER:?set BUILD_NUMBER}"
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "BUILD_NUMBER must be a positive integer" >&2; exit 2; }
[[ -f "$ANDROID_KEYSTORE_PATH" ]] || { echo "ANDROID_KEYSTORE_PATH is not a file" >&2; exit 2; }
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd -P)"
keystore="$(cd "$(dirname "$ANDROID_KEYSTORE_PATH")" && pwd -P)/$(basename "$ANDROID_KEYSTORE_PATH")"
case "$keystore" in "$repo"/*) echo "keep the upload keystore outside the repository" >&2; exit 2 ;; esac
export ANDROID_KEYSTORE_PATH="$keystore"
edition="${MYCEL_MOBILE_EDITION:-trina}"
[[ "$edition" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || { echo "invalid MYCEL_MOBILE_EDITION" >&2; exit 2; }
edition_json="$here/../editions/$edition/branding/mobile.json"
[[ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]] || { echo "set ANDROID_HOME to the Android SDK" >&2; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"; export JAVA_HOME; fi
out="${OUT:-$here/build/android-$BUILD_NUMBER}"
mkdir -p "$out"

cd "$here"
# For the whole run: Gradle's "createExpoConfig" step runs expo config again, and that config is what the app reads.
export MYCEL_MOBILE_EDITION="$edition" MYCEL_MOBILE_BUILD_NUMBER="$BUILD_NUMBER"
npm ci --ignore-scripts --no-audit --no-fund
npx expo prebuild --platform android --clean
(cd android && ./gradlew --no-daemon bundleRelease)

name="$(node -p "require(process.argv[1]).name.replace(/[^A-Za-z0-9]+/g, '-')" "$edition_json")"
aab="$out/$name-1.0.0-$BUILD_NUMBER.aab"
cp android/app/build/outputs/bundle/release/app-release.aab "$aab"

# 1. The app reads the edition's config at runtime (name, package), not the neutral one.
unzip -p "$aab" base/assets/app.config > "$out/app.config.json"
node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')),want=require(process.argv[2]);if(c.name!==want.name||c.extra?.teamAxEdition?.bundleId!==want.bundleId||c.android?.package!==want.bundleId||String(c.android?.versionCode)!==process.argv[3]){console.error('embedded app.config is not the edition build ('+c.name+', '+c.android?.package+', '+c.android?.versionCode+')');process.exit(1)}" "$out/app.config.json" "$edition_json" "$BUILD_NUMBER"
# 2. Signed, and by the upload key given (certificate SHA-256), not the debug key.
# (no -strict: an upload key is self-signed, which -strict reports as a broken certificate chain)
jarsigner -verify "$aab" > "$out/jarsigner.txt" 2>&1 || { tail -5 "$out/jarsigner.txt" >&2; echo "the bundle signature does not verify" >&2; exit 1; }
grep -q '^jar verified' "$out/jarsigner.txt" || { tail -5 "$out/jarsigner.txt" >&2; echo "the bundle is not signed" >&2; exit 1; }
keytool -printcert -jarfile "$aab" > "$out/bundle-cert.txt"
keytool -list -v -keystore "$ANDROID_KEYSTORE_PATH" -alias "$ANDROID_KEY_ALIAS" -storepass:env ANDROID_KEYSTORE_PASSWORD > "$out/upload-cert.txt"
signed="$(sed -n 's/^.*SHA256: //p' "$out/bundle-cert.txt" | head -1)"
upload="$(sed -n 's/^.*SHA256: //p' "$out/upload-cert.txt" | head -1)"
[[ -n "$signed" && "$signed" == "$upload" ]] || { echo "the bundle is not signed with the upload key ($signed)" >&2; exit 1; }
rm -f "$out/upload-cert.txt"
# 3. Optional: the merged manifest (versionCode, versionName, SDK levels, permissions).
if [[ -n "${BUNDLETOOL:-}" ]]; then java -jar "$BUNDLETOOL" dump manifest --bundle "$aab" > "$out/AndroidManifest.xml"; fi
echo "upload key SHA-256: $upload"
echo "built $aab"
