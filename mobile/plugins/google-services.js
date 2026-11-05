// Android push (FCM): the Firebase project file from MYCEL_MOBILE_GOOGLE_SERVICES, applied at prebuild only. Expo's
// android.googleServicesFile would put the file's path (a build machine path) into the config the app embeds, so the
// path is given only to Expo's Google Services helpers here. Expo copies the file to android/app/google-services.json
// (generated, ignored by git), as every Firebase Android build needs; its contents are never printed.
const fs = require('node:fs')
const path = require('node:path')
const { AndroidConfig, withAppBuildGradle, withDangerousMod, withProjectBuildGradle } = require('expo/config-plugins')

module.exports = config => {
  const file = process.env.MYCEL_MOBILE_GOOGLE_SERVICES
  if (!file) return config
  if (path.basename(file) !== 'google-services.json' || !fs.existsSync(file)) throw new Error('MYCEL_MOBILE_GOOGLE_SERVICES must name an existing google-services.json')
  const firebase = c => ({ android: { ...c.android, googleServicesFile: path.resolve(file) } })
  config = withProjectBuildGradle(config, c => { c.modResults.contents = AndroidConfig.GoogleServices.setClassPath(firebase(c), c.modResults.contents); return c })
  config = withAppBuildGradle(config, c => { c.modResults.contents = AndroidConfig.GoogleServices.applyPlugin(firebase(c), c.modResults.contents); return c })
  return withDangerousMod(config, ['android', async c => {
    if (!(await AndroidConfig.GoogleServices.setGoogleServicesFile(firebase(c), c.modRequest.projectRoot))) throw new Error('google-services.json was not copied')
    return c
  }])
}
