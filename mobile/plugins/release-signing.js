// Android release signing from the environment (scripts/android-release.sh). The upload keystore stays outside the
// repository and no password is written into any file: Gradle reads ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD,
// ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD when it signs. Without ANDROID_KEYSTORE_PATH a release build keeps the debug
// key (local tests only; the release script refuses to run without the upload key and checks the signature).
const { withAppBuildGradle } = require('expo/config-plugins')

const { applyReleaseSigning } = require('./release-signing-gradle.js')

module.exports = config => withAppBuildGradle(config, c => {
  if (c.modResults.language !== 'groovy') throw new Error('release-signing: app/build.gradle must be Groovy')
  c.modResults.contents = applyReleaseSigning(c.modResults.contents)
  return c
})
