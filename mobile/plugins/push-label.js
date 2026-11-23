// Android: who and where in a room push (docs/decisions/20261121-android-push-who-where.md). The app's own
// module (modules/push-label) declares LabelMessagingService, which extends expo-notifications' FCM service. This plugin
// removes expo-notifications' service from the app's manifest, so FCM has exactly one entry point, and stops the prebuild
// when expo-notifications no longer has what LabelMessagingService overrides (better a failed build than an app whose
// pushes silently stay generic or, worse, show nothing).
const fs = require('node:fs')
const path = require('node:path')

const EXPO_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService'
const OURS = 'expo.modules.pushlabel.LabelMessagingService'
// expo-notifications' receiver that posts notifications; LabelNotificationsService replaces it (the lock screen's public version)
const EXPO_RECEIVER = 'expo.modules.notifications.service.NotificationsService'
const OUR_RECEIVER = 'expo.modules.pushlabel.LabelNotificationsService'

/** expo-notifications' Kotlin that LabelMessagingService builds on. */
function checkExpoNotifications(projectRoot) {
  const dir = path.join(path.dirname(require.resolve('expo-notifications/package.json', { paths: [projectRoot] })), 'android', 'src', 'main', 'java', 'expo', 'modules', 'notifications')
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8')
  const service = read('service/ExpoFirebaseMessagingService.kt')
  const delegate = read('service/delegates/FirebaseMessagingDelegate.kt')
  const remote = read('notifications/model/RemoteNotificationContent.kt')
  const trigger = read('notifications/model/triggers/FirebaseNotificationTrigger.kt')
  const receiver = read('service/NotificationsService.kt')
  const presentation = read('service/delegates/ExpoPresentationDelegate.kt')
  const manifest = fs.readFileSync(path.join(dir, '..', '..', '..', '..', 'AndroidManifest.xml'), 'utf8')
  const ok = service.includes('open class ExpoFirebaseMessagingService') && service.includes('protected open val firebaseMessagingDelegate')
    && delegate.includes('open class FirebaseMessagingDelegate(protected val context: Context)')
    && /protected open fun createNotificationRequest\(\s*identifier: String,\s*content: INotificationContent,\s*notificationTrigger: FirebaseNotificationTrigger\s*\)/.test(delegate)
    && delegate.includes('NotificationsService.receive(context, notification)')
    && /\n  override fun onMessageReceived\(remoteMessage: RemoteMessage\)/.test(delegate)
    && remote.includes('val isDataOnly = remoteMessage.notification == null')
    && trigger.includes('class FirebaseNotificationTrigger(val remoteMessage: RemoteMessage)') && trigger.includes('remoteMessage.data["channelId"]')
    && receiver.includes('open class NotificationsService : BroadcastReceiver()') && /protected open fun getPresentationDelegate\(context: Context\): PresentationDelegate/.test(receiver)
    && receiver.includes('queryBroadcastReceivers(searchIntent, 0).firstOrNull()')
    && presentation.includes('open class ExpoPresentationDelegate(') && presentation.includes('protected val context: Context')
    && /protected open suspend fun createNotification\(notification: Notification, notificationBehavior: NotificationBehaviorRecord\?\): android\.app\.Notification/.test(presentation)
    // our receiver declares the actions expo-notifications' has; a new one there must be added to ours
    && sameActions(manifest)
  if (!ok) throw new Error('push-label: expo-notifications changed its Android FCM service, NotificationsService receiver or ExpoPresentationDelegate; update modules/push-label (LabelMessagingService, LabelNotificationsService)')
}

/** expo-notifications' receiver lists exactly the actions modules/push-label's receiver lists. */
function sameActions(expoManifest) {
  const actions = xml => {
    const m = /<receiver[^>]*NotificationsService"[\s\S]*?<\/receiver>/.exec(xml)
    return m ? [...m[0].matchAll(/<action android:name="([^"]+)"/g)].map(a => a[1]).sort().join(' ') : null
  }
  const ours = fs.readFileSync(path.join(__dirname, '..', 'modules', 'push-label', 'android', 'src', 'main', 'AndroidManifest.xml'), 'utf8')
  const theirs = actions(expoManifest)
  return theirs !== null && theirs === actions(ours)
}

/** The manifest change alone (tests call it): expo-notifications' service marked for removal at the merge. */
function removeExpoService(manifest) {
  manifest.manifest.$ = manifest.manifest.$ || {}
  manifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools'
  const app = manifest.manifest.application?.[0]
  if (!app) throw new Error('push-label: the manifest has no application')
  app.service = (app.service || []).filter(s => s.$?.['android:name'] !== EXPO_SERVICE && s.$?.['android:name'] !== OURS)
  app.service.push({ $: { 'android:name': EXPO_SERVICE, 'tools:node': 'remove' } })
  app.receiver = (app.receiver || []).filter(r => r.$?.['android:name'] !== EXPO_RECEIVER && r.$?.['android:name'] !== OUR_RECEIVER)
  app.receiver.push({ $: { 'android:name': EXPO_RECEIVER, 'tools:node': 'remove' } })
  return manifest
}

module.exports = config => {
  // loaded here, not at the top: the root unit tests require this file without the phone app's node_modules
  const { withAndroidManifest } = require('expo/config-plugins')
  return withAndroidManifest(config, c => {
    checkExpoNotifications(c.modRequest.projectRoot)
    c.modResults = removeExpoService(c.modResults)
    return c
  })
}
module.exports.removeExpoService = removeExpoService
module.exports.checkExpoNotifications = checkExpoNotifications
