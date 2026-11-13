// The app icon's number (badge-v1; docs/DECISIONS.md "휴대폰 앱 아이콘의 숫자"). No native imports: tests load it.
// While the app is closed a push sets it on the iPhone (the team server's count in APNs aps.badge; on Android the launcher counts the notifications in the tray). While the
// team's page is open, the page sends its own count (the one count n of its tab title and the Mac Dock) whenever it
// changes and every time the app comes to the foreground, and 0 at sign-out; the app sets 0 itself when it signs out
// or leaves a team. A number only. iPhone only: on Android the app never sets a number (setsIconNumber).

import { MAX_BADGE } from './protocol'

export const validBadge = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_BADGE

/** The permission request with the badge: iOS shows its question once, whatever is asked; after an answer it asks
 * nothing, so asking again with the badge never shows a second dialog. */
export const PERMISSION_REQUEST = { ios: { allowAlert: true, allowBadge: true, allowSound: true } } as const

/** An iPhone where notifications are on but the icon number is not allowed (the person answered before this app asked
 * for it, an app before 1.0.5): ask once more, without a dialog (iOS shows none after the first answer). Never on Android
 * (its notification permission covers the icon), never twice (`askedBadge`), never when it is allowed already. */
export function askBadgeAgain(o: { ios: boolean; status: string; allowsBadge: boolean | null | undefined; askedBadge: boolean }): boolean {
  return o.ios && o.status === 'granted' && o.allowsBadge !== true && !o.askedBadge
}

/** Whether this app sets the icon's number itself: on the iPhone only. On Android expo-notifications (58.1.6) sets a
 * number through ShortcutBadger (Samsung's badge provider), but its 0 only cancels the app's notifications (all of them,
 * the tray too) and never clears that number, and One UI shows it only while a notification is in the tray, so a count
 * once set came back stale with the next push and stayed after reading and sign-out (QA TC-408, Galaxy Note10, One UI 4).
 * Android keeps the launcher's own count of the notifications in the tray; a `badge` message from the page is taken and
 * does nothing there. */
export const setsIconNumber = (platform: string): boolean => platform === 'ios'

/** Sets the icon's number, one call at a time and the latest wins (a burst of page changes ends on the last count).
 * A failure (badges off, a launcher without numbers) changes nothing. */
export class AppBadge {
  private want: number | null = null
  private running: Promise<void> | null = null
  constructor(private set: (n: number) => Promise<unknown>) {}
  show(n: number): Promise<void> {
    if (!validBadge(n)) return Promise.resolve()
    this.want = n
    this.running ??= this.drain().finally(() => { this.running = null })
    return this.running
  }
  clear(): Promise<void> { return this.show(0) }
  private async drain() {
    while (this.want !== null) {
      const n = this.want
      this.want = null
      await this.set(n).catch(() => {})
    }
  }
}
