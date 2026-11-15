// Android: who and where in a room push (docs/DECISIONS.md "Android notifications name who and where"). The app's own
// module (mobile/modules/push-label) replaces expo-notifications' FCM service; plugins/push-label.js removes that service
// from the app's manifest and stops the prebuild when expo-notifications changes what the module builds on. The Kotlin
// cannot run here, so its rules are checked in the source: the title only, never the team's body (the message's text
// with the person's preview on), only the stored team address, no redirects, a short time box.
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
  expect(() => plugin.removeExpoService({ manifest: {} })).toThrow('no application')
  const own = fs.readFileSync(path.join(moduleDir, 'AndroidManifest.xml'), 'utf8')
  expect(own).toContain('android:name="expo.modules.pushlabel.LabelMessagingService"')
  expect(own).toContain('android:exported="false"')
  expect(own).toContain('com.google.firebase.MESSAGING_EVENT')
})

test('the prebuild stops when expo-notifications no longer has what the service overrides', () => {
  expect(() => plugin.checkExpoNotifications(mobileRoot)).not.toThrow()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-label-'))
  try {
    const real = path.join(mobileRoot, 'node_modules/expo-notifications')
    const copy = path.join(root, 'node_modules/expo-notifications')
    const src = 'android/src/main/java/expo/modules/notifications'
    for (const f of ['service/ExpoFirebaseMessagingService.kt', 'service/delegates/FirebaseMessagingDelegate.kt', 'notifications/model/RemoteNotificationContent.kt', 'notifications/model/triggers/FirebaseNotificationTrigger.kt']) {
      fs.mkdirSync(path.dirname(path.join(copy, src, f)), { recursive: true })
      fs.copyFileSync(path.join(real, src, f), path.join(copy, src, f))
    }
    fs.copyFileSync(path.join(real, 'package.json'), path.join(copy, 'package.json'))
    expect(() => plugin.checkExpoNotifications(root)).not.toThrow()
    const delegate = path.join(copy, src, 'service/delegates/FirebaseMessagingDelegate.kt')
    fs.writeFileSync(delegate, fs.readFileSync(delegate, 'utf8').replace('protected open fun createNotificationRequest', 'protected fun createNotificationRequest'))
    expect(() => plugin.checkExpoNotifications(root)).toThrow('expo-notifications changed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the Kotlin keeps the iPhone extension\'s rules: title only, the stored team only, https, no redirects, a time box', () => {
  const label = kotlin('Label.kt'), service = kotlin('LabelMessagingService.kt'), store = kotlin('LabelStore.kt')
  // the team's answer gives the title and nothing else: the text stays the gateway's generic line
  expect(label).toContain('opt("title")')
  expect(label).not.toContain('"body"')
  expect(service).toContain('data["message"]')
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
