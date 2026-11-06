// Native push: the OS permission prompt and the phone's APNs/FCM device token. Nothing here talks to a server; the
// signed-in web page receives the token through the bridge (push-token-v1) and registers it with its own team.
import Constants from 'expo-constants'
import { fetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import * as Application from 'expo-application'
import * as Notifications from 'expo-notifications'
import { AppState, Linking, Platform } from 'react-native'
import { onceEvery, PushRefused } from './bridge'
import { parseTeamAddress } from './address'
import type { DeviceDeps, Slot } from './device'
import { tappedNotificationPath, type PushEnvironment, type PushPermission, type PushToken } from './protocol'
import { permissionFrom } from './permission'

export const CHANNEL_ID = 'default'
// set once this app has asked the OS (src/permission.ts: Android tells "not asked yet" from "turned off" by it)
const ASKED = 'team-ax.push-asked'
let asking: Promise<PushToken> | null = null

/** Built with push: iOS always (aps-environment entitlement); Android only when the build has an FCM config file. */
export function pushBuilt(): boolean {
  const built = Constants.expoConfig?.extra?.pushEnabled as Record<string, unknown> | undefined
  return (Platform.OS === 'ios' || Platform.OS === 'android') && built?.[Platform.OS] === true
}

async function environment(): Promise<PushEnvironment> {
  if (Platform.OS !== 'ios') return 'production'
  // embedded.mobileprovision: 'development' for dev builds. App Store and TestFlight installs carry no profile (null)
  // and use the production APNs host, like release builds generally.
  const env = await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null)
  return env === 'development' ? 'sandbox' : env === 'production' ? 'production' : __DEV__ ? 'sandbox' : 'production'
}

/** What the OS says about notifications for this app, without asking (push-permission-v1); iOS 'undetermined' covers
 * provisional. Android after the person turned notifications off in Settings reads as denied (src/permission.ts). */
export async function notificationPermission(): Promise<PushPermission> {
  if (!pushBuilt()) throw new PushRefused('push_unavailable')
  const status = await Notifications.getPermissionsAsync()
  const askedBefore = Platform.OS === 'android' && status.status !== 'granted' && status.canAskAgain
    && (await SecureStore.getItemAsync(ASKED).catch(() => null) === '1' || !!(await devices.current.get().catch(() => null)))
  return permissionFrom({ status: status.status, canAskAgain: status.canAskAgain, android: Platform.OS === 'android', askedBefore })
}

const settingsOnce = onceEvery(3000)
/** This app's page in the phone's Settings (notifications are switched on there once the person said no): only while
 * the app is on screen, and at most once every few seconds, whatever the page asks. */
export async function openAppSettings(): Promise<void> {
  if (AppState.currentState !== 'active' || !settingsOnce()) return
  await Linking.openSettings()
}

/** Asks for permission (only when the person has not answered yet) and returns this phone's device token. One prompt
 * at a time: a second request while the dialog is open waits for the same answer. The page sends this only when the
 * person tapped its "turn on" button, or when the OS has already said yes (push-permission-v1). */
export function devicePushToken(channelName: string): Promise<PushToken> {
  if (!pushBuilt()) {
    console.log('push: this build has no push configuration; push stays off')
    return Promise.reject(new PushRefused('push_unavailable'))
  }
  asking ??= (async () => {
    // Android 13+ shows the permission dialog only once a channel exists.
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(CHANNEL_ID, { name: channelName, importance: Notifications.AndroidImportance.HIGH })
    let status = await Notifications.getPermissionsAsync()
    await SecureStore.setItemAsync(ASKED, '1').catch(() => {})
    // Not 'undetermined' only: Android 13+ reports 'denied' (canAskAgain) before the first question, because
    // notifications are off until the person allows them. iOS says canAskAgain=false once the person has answered.
    if (status.status !== 'granted' && status.canAskAgain) status = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } })
    if (status.status !== 'granted') throw new PushRefused('push_denied')
    let token: Notifications.DevicePushToken
    try { token = await Notifications.getDevicePushTokenAsync() } catch {
      console.log('push: the OS gave no device token; push stays off')
      throw new PushRefused('push_unavailable')
    }
    if (typeof token.data !== 'string') throw new PushRefused('push_unavailable')
    return { platform: Platform.OS === 'ios' ? 'ios' : 'android', token: Platform.OS === 'ios' ? token.data.toLowerCase() : token.data, environment: await environment() } satisfies PushToken
  })().finally(() => { asking = null })
  return asking
}

/** In the foreground the web app already shows new things live: keep the notification in the list, no banner/sound. */
export function quietForeground() {
  // Never let notifications break the app (an Android build without FCM has no push at all).
  try { Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) }) }
  catch { console.log('push: notification handler unavailable') }
}

function tappedPath(response: Notifications.NotificationResponse | null, teamSince: number, device: string | null): string | null {
  if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null
  return tappedNotificationPath(response.notification.request.content.data, response.notification.date, teamSince, device)
}

export function onNotificationTap(teamSince: () => number, device: () => string | null, open: (path: string) => void): () => void {
  try { return listenForTaps(teamSince, device, open) } catch { console.log('push: notification taps unavailable'); return () => {} }
}
function listenForTaps(teamSince: () => number, device: () => string | null, open: (path: string) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    const path = tappedPath(response, teamSince(), device())
    if (path) open(path)
    Notifications.clearLastNotificationResponse()
  })
  // Cold start: the tap that launched the app.
  const launched = tappedPath(Notifications.getLastNotificationResponse(), teamSince(), device())
  if (launched) { Notifications.clearLastNotificationResponse(); open(launched) }
  return () => sub.remove()
}

/** Changing team: notifications of the previous team must not stay on screen. */
export function forgetDelivered() { void Notifications.dismissAllNotificationsAsync().catch(() => {}) }

const slot = (key: string): Slot => ({
  get: () => SecureStore.getItemAsync(key),
  set: value => value === null ? SecureStore.deleteItemAsync(key) : SecureStore.setItemAsync(key, value),
})
/** The device registered with the current team and the removals owed to teams left (src/device.ts). */
export const devices: DeviceDeps = {
  current: slot('team-ax.push-device'), pending: slot('team-ax.push-pending'), now: Date.now,
  // POST /api/push/devices/<id>/remove with the removal key: no session (the team was left), done unless the server
  // could not be reached or failed (5xx / 429), which leaves it owed for the next app start.
  async remove(d) {
    if (parseTeamAddress(d.origin)?.origin !== d.origin) return true
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000)
    try {
      const r = await fetch(`${d.origin}/api/push/devices/${encodeURIComponent(d.deviceId)}/remove`, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify({ key: d.removeKey }),
      })
      return r.status < 500 && r.status !== 429
    } catch { return false } finally { clearTimeout(timer) }
  },
}
