// Native push: the OS permission prompt and the phone's APNs/FCM device token. Nothing here talks to a server; the
// signed-in web page receives the token through the bridge (push-token-v1) and registers it with its own team.
import Constants from 'expo-constants'
import * as Application from 'expo-application'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { PushRefused } from './bridge'
import { tappedNotificationPath, type PushEnvironment, type PushToken } from './protocol'

export const CHANNEL_ID = 'default'
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

/** Asks for permission (only when the person has not answered yet) and returns this phone's device token. One prompt
 * at a time: a second request while the dialog is open waits for the same answer. */
export function devicePushToken(channelName: string): Promise<PushToken> {
  if (!pushBuilt()) {
    console.log('push: this build has no push configuration; push stays off')
    return Promise.reject(new PushRefused('push_unavailable'))
  }
  asking ??= (async () => {
    // Android 13+ shows the permission dialog only once a channel exists.
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(CHANNEL_ID, { name: channelName, importance: Notifications.AndroidImportance.HIGH })
    let status = await Notifications.getPermissionsAsync()
    if (status.status === 'undetermined' && status.canAskAgain) status = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } })
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
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) })
}

function tappedPath(response: Notifications.NotificationResponse | null, teamSince: number): string | null {
  if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null
  return tappedNotificationPath(response.notification.request.content.data, response.notification.date, teamSince)
}

export function onNotificationTap(teamSince: () => number, open: (path: string) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    const path = tappedPath(response, teamSince())
    if (path) open(path)
    Notifications.clearLastNotificationResponse()
  })
  // Cold start: the tap that launched the app.
  const launched = tappedPath(Notifications.getLastNotificationResponse(), teamSince())
  if (launched) { Notifications.clearLastNotificationResponse(); open(launched) }
  return () => sub.remove()
}

/** Changing team: notifications of the previous team must not stay on screen. */
export function forgetDelivered() { void Notifications.dismissAllNotificationsAsync().catch(() => {}) }
