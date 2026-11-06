// What the OS says about notifications, as the page needs it (push-permission-v1). No native imports: tests load it.
import type { PushPermission } from './protocol'

/** Android 13+ reports "denied, may ask again" both before the app's first question and after the person turned
 * notifications off in the phone's Settings (or said no once); only the first is undetermined. An app that asked
 * before, or had a phone registered (which needs a yes), reads it as denied. iOS says denied plainly. */
export function permissionFrom(o: { status: string; canAskAgain: boolean; android: boolean; askedBefore: boolean }): PushPermission {
  if (o.status === 'granted') return 'granted'
  if (!o.canAskAgain) return 'denied'
  return o.android && o.askedBefore ? 'denied' : 'undetermined'
}
