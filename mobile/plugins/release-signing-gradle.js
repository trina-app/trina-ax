// The text change release-signing.js makes in android/app/build.gradle. No dependencies, so tests can load it.
const MARK = 'ANDROID_KEYSTORE_PATH'
const RELEASE = `signingConfigs {
        release {
            if (System.getenv('ANDROID_KEYSTORE_PATH')) {
                storeFile file(System.getenv('ANDROID_KEYSTORE_PATH'))
                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('ANDROID_KEY_ALIAS')
                keyPassword System.getenv('ANDROID_KEY_PASSWORD')
            }
        }
`

function applyReleaseSigning(gradle) {
  if (gradle.includes(MARK)) return gradle
  const buildType = /(buildTypes \{[\s\S]*?\brelease \{[\s\S]*?)signingConfig signingConfigs\.debug/
  if (!buildType.test(gradle) || !/signingConfigs \{\n/.test(gradle)) throw new Error('release-signing: unexpected app/build.gradle layout')
  return gradle
    .replace(buildType, "$1signingConfig System.getenv('ANDROID_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug")
    .replace(/signingConfigs \{\n/, RELEASE)
}

module.exports = { applyReleaseSigning }
