// Android: who and where in a room push (docs/decisions/20261121-android-push-who-where.md). The app's own
// module (mobile/modules/push-label) replaces expo-notifications' FCM service; plugins/push-label.js removes that service
// from the app's manifest and stops the prebuild when expo-notifications changes what the module builds on. The Kotlin
// cannot run here, so its rules are checked in the source: the iPhone extension's words (the title, the team's body as
// the text, the room as the group), only the stored team address, no redirects, a short time box.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import appConfig from '../../mobile/app.config'

const mobileRoot = path.resolve(import.meta.dir, '../../mobile')
const moduleDir = path.join(mobileRoot, 'modules/push-label/android/src/main')
const kotlin = (f: string) => fs.readFileSync(path.join(moduleDir, 'java/expo/modules/pushlabel', f), 'utf8')
const plugin = require('../../mobile/plugins/push-label.js') as { removeExpoService(m: any): any; checkExpoNotifications(root: string): void }
const EXPO_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService'
const EXPO_RECEIVER = 'expo.modules.notifications.service.NotificationsService'

afterEach(() => { delete process.env.MYCEL_MOBILE_EDITION; delete process.env.MYCEL_MOBILE_BUILD_NUMBER })

test('every build (neutral and Trina) has the plugin, and the module is linked for Android only', () => {
  expect(JSON.stringify(appConfig({ config: {}, projectRoot: mobileRoot } as never).plugins)).toContain('./plugins/push-label.js')
  process.env.MYCEL_MOBILE_EDITION = 'trina'; process.env.MYCEL_MOBILE_BUILD_NUMBER = '12'
  expect(JSON.stringify(appConfig({ config: {}, projectRoot: mobileRoot } as never).plugins)).toContain('./plugins/push-label.js')
  const linked = JSON.parse(fs.readFileSync(path.join(mobileRoot, 'modules/push-label/expo-module.config.json'), 'utf8'))
  expect(linked).toEqual({ platforms: ['android'], android: { modules: ['expo.modules.pushlabel.PushLabelModule'] } })
  // the module's native sources are kept (mobile/.gitignore ignores the generated android/ folder)
  expect(fs.readFileSync(path.join(mobileRoot, '.gitignore'), 'utf8')).toContain('!/modules/*/android/')
})

test('the manifest: expo-notifications\' service removed at the merge, once; the module\'s own service is FCM\'s only entry', () => {
  const m = { manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' }, application: [{ $: {}, service: [{ $: { 'android:name': 'other.Service' } }] }] } }
  const once = plugin.removeExpoService(m)
  const twice = plugin.removeExpoService(once)
  expect(twice.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools')
  expect(twice.manifest.application[0].service).toEqual([{ $: { 'android:name': 'other.Service' } }, { $: { 'android:name': EXPO_SERVICE, 'tools:node': 'remove' } }])
  // expo-notifications' receiver goes too: ours (LabelNotificationsService) posts every notification
  expect(twice.manifest.application[0].receiver).toEqual([{ $: { 'android:name': EXPO_RECEIVER, 'tools:node': 'remove' } }])
  expect(() => plugin.removeExpoService({ manifest: {} })).toThrow('no application')
  const own = fs.readFileSync(path.join(moduleDir, 'AndroidManifest.xml'), 'utf8')
  expect(own).toContain('android:name="expo.modules.pushlabel.LabelMessagingService"')
  expect(own).toContain('android:exported="false"')
  expect(own).toContain('com.google.firebase.MESSAGING_EVENT')
  expect(own).toContain('android:name="expo.modules.pushlabel.LabelNotificationsService"')
  expect(own).toContain('expo.modules.notifications.NOTIFICATION_EVENT')
  // Expo links expo-notifications as a prebuilt AAR (no ':expo-notifications' project): the module takes the AAR then
  // (a plain project(':expo-notifications') failed the first real Gradle build, 2026-11-21)
  const gradle = fs.readFileSync(path.join(mobileRoot, 'modules/push-label/android/build.gradle'), 'utf8')
  expect(gradle).toContain("rootProject.findProject(':expo-notifications')")
  expect(gradle).toContain('host.exp.exponent:expo.modules.notifications:')
})

// needs the phone app's own install (npm ci --prefix mobile): the root unit shards in CI do not have it
const expoNotifications = fs.existsSync(path.join(mobileRoot, 'node_modules/expo-notifications/package.json'))
if (!expoNotifications) console.warn('mobile-push-label-android: skipping the expo-notifications check (no mobile/node_modules; run npm ci --prefix mobile)')
test.skipIf(!expoNotifications)('the prebuild stops when expo-notifications no longer has what the service overrides', () => {
  expect(() => plugin.checkExpoNotifications(mobileRoot)).not.toThrow()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-label-'))
  try {
    const real = path.join(mobileRoot, 'node_modules/expo-notifications')
    const copy = path.join(root, 'node_modules/expo-notifications')
    const src = 'android/src/main/java/expo/modules/notifications'
    for (const f of ['service/ExpoFirebaseMessagingService.kt', 'service/delegates/FirebaseMessagingDelegate.kt', 'notifications/model/RemoteNotificationContent.kt', 'notifications/model/triggers/FirebaseNotificationTrigger.kt', 'service/NotificationsService.kt', 'service/delegates/ExpoPresentationDelegate.kt']) {
      fs.mkdirSync(path.dirname(path.join(copy, src, f)), { recursive: true })
      fs.copyFileSync(path.join(real, src, f), path.join(copy, src, f))
    }
    fs.copyFileSync(path.join(real, 'android/src/main/AndroidManifest.xml'), path.join(copy, 'android/src/main/AndroidManifest.xml'))
    fs.copyFileSync(path.join(real, 'package.json'), path.join(copy, 'package.json'))
    expect(() => plugin.checkExpoNotifications(root)).not.toThrow()
    const delegate = path.join(copy, src, 'service/delegates/FirebaseMessagingDelegate.kt')
    fs.writeFileSync(delegate, fs.readFileSync(delegate, 'utf8').replace('protected open fun createNotificationRequest', 'protected fun createNotificationRequest'))
    expect(() => plugin.checkExpoNotifications(root)).toThrow('expo-notifications changed')
    fs.writeFileSync(delegate, fs.readFileSync(delegate, 'utf8').replace('protected fun createNotificationRequest', 'protected open fun createNotificationRequest'))
    expect(() => plugin.checkExpoNotifications(root)).not.toThrow()
    // a new action on expo-notifications' receiver that ours does not list stops the prebuild too
    const manifest = path.join(copy, 'android/src/main/AndroidManifest.xml')
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('<action android:name="android.intent.action.REBOOT" />', '<action android:name="android.intent.action.REBOOT" /><action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />'))
    expect(() => plugin.checkExpoNotifications(root)).toThrow('expo-notifications changed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the Kotlin keeps the iPhone extension\'s rules: its words, the stored team only, https, no redirects, a time box', () => {
  const label = kotlin('Label.kt'), service = kotlin('LabelMessagingService.kt'), store = kotlin('LabelStore.kt')
  // the lock screen as the iPhone's default (When Unlocked): private, with the gateway's generic words as the public version
  const lock = kotlin('LabelNotificationsService.kt')
  expect(lock).toContain('built.visibility = NotificationCompat.VISIBILITY_PRIVATE')
  expect(lock).toContain('built.publicVersion = builder')
  expect(lock).toContain('data["title"]')
  expect(lock).toContain('data["message"]')
  expect(lock).not.toContain('Label.ask')
  const swift = fs.readFileSync(path.join(mobileRoot, 'plugins/notification-service/NotificationService.swift'), 'utf8')
  // the team's words as the iPhone takes them: the title (at most 120), the body (at most 200) as the text when there
  // is one, else the gateway's generic line; the room as the stack
  expect(swift).toContain('plain($0, max: 200)')
  expect(swift).toContain('if let body = words.body { content.body = body }')
  expect(label).toContain('opt("title")')
  expect(label).toContain('(o.opt("body") as? String)?.let { plain(it, 200) }?.takeIf { it.isNotEmpty() }')
  expect(label).toContain('(o.opt("roomId") as? String)?.takeIf { isId(it) }')
  expect(service).toContain('data["message"]')
  expect(service).toContain('.setText(team?.body ?: text)')
  expect(service).toContain('.setGroup(team?.roomId)')
  // a team that does not answer is not waited for again for a minute (FCM hands over one message at a time)
  expect(label).toContain('PAUSE_AFTER_FAILURE_MS = 60_000L')
  // spaces as Swift's isWhitespace: Unicode separators too
  expect(label).toContain('Regex("[\\\\s\\\\p{Z}]+")')
  // the address is the stored origin; a push for another device is not asked about
  expect(label).toContain('"${access.origin}/api/push/devices/${access.deviceId}/label"')
  expect(label).toContain('if (data["device"] != access.deviceId) return null')
  expect(label).toContain('u.scheme != "https"')
  expect(label).toContain('instanceFollowRedirects = false')
  expect(label).toContain('useCaches = false')
  expect(label).toContain('conn.setRequestProperty("x-mycel-csrf", "1")')
  expect(Number(/TIMEOUT_MS = ([\d_]+)L/.exec(label)![1]!.replace(/_/g, ''))).toBeLessThanOrEqual(5000)
  expect(label).toContain('MAX_ANSWER = 4096')
  // room codes and chat.shared only, data-only only; any failure is expo-notifications' own notification
  expect(label).toContain('code.startsWith("room.") || code == "chat.shared"')
  expect(service).toContain('!content.isDataOnly')
  expect(service).toContain('catch (_: Throwable) { null }')
  // the same notice again replaces it (the gateway's tag was the notice id)
  expect(service).toContain('return notificationId to words')
  // the key: Android Keystore, never readable from a backup
  expect(store).toContain('"AndroidKeyStore"')
  expect(store).toContain('AES/GCM/NoPadding')
})

// A silent sync (code phone.sync, docs/AGENTS/plan/20261123-0705-phone-badge-sync.md): handled before expo-notifications
// (which would list an empty notification while the app is open), shows nothing, takes the listed notices off the tray
test('a sync is stopped before expo-notifications and takes only the listed, well-formed notice ids off the tray', () => {
  const service = kotlin('LabelMessagingService.kt'), sync = kotlin('Sync.kt')
  expect(service).toContain('override fun onMessageReceived(remoteMessage: RemoteMessage)')
  expect(service).toContain('if (Sync.isSync(data)) { Sync.apply(context, data); return }')
  // the sync check comes before anything goes to expo-notifications
  expect(service.indexOf('Sync.isSync(data)')).toBeLessThan(service.indexOf('super.onMessageReceived(remoteMessage)'))
  expect(sync).toContain('const val CODE = "phone.sync"')
  expect(sync).toContain(".split(',').filter { Label.isId(it) }.take(MAX_CLEAR)")
  // only by tag (the notice id), never everything; empty group summaries go too; never throws
  expect(sync).toContain('it.tag != null && it.tag in ids')
  expect(sync).toContain('nm.cancel(n.tag, n.id)')
  expect(sync).toContain('FLAG_GROUP_SUMMARY')
  expect(sync).toContain('catch (_: Throwable) {}')
  expect(sync).not.toContain('cancelAll')
  expect(sync).not.toMatch(/notify\(/)
})
