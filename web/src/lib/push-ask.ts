// The web ask (components/WebPushAsk.tsx): one quiet line in a web browser, "새 메시지 알림을 받으려면 [알림 켜기] ·
// [나중에]". Browsers show their notification question only after a click, so without it hardly anyone turned push on.
// Shown only when all of these hold (webPushAskShows): a web browser that can get Web Push (not the desktop app, not the
// phone app, an https address, not an iPhone browser tab), the browser has not been asked yet (permission 'default'),
// the team server offers Web Push with a valid key, the person is signed in and did not turn push off themselves, and
// this device did not put the line away in the last 7 days ([나중에]) or block notifications from it (for good: Settings
// › Notifications says how to undo that). Not in Microsoft Edge: the team server does not deliver through its push
// service (lib/push.ts isEdge) until that is decided. [알림 켜기] runs enablePush right in the click (the browser's
// question needs the click), so the server's settings and the service worker are made ready before the line shows.
// Ready, it waits for the next move to another page (noteWebPushAskPath): appearing on the page in front of the person
// would push it down (or up, on a phone) under their finger.
import { create } from 'zustand'
import type { z } from 'zod'
import type { PushSettings } from '@mycel/shared/api'
import { api, API } from './api'
import { enablePush, isEdge, logPushFailure, notificationPermission, pushFailure, pushRegistration, pushSupported, vapidBytes, type PushFailure } from './push'
import { pushNeedsInstall } from './pwa'

type Settings = z.infer<typeof PushSettings>
/** this device's answers: [나중에] (when, ms) and a "block" from the line (for good) */
export const ASK_LATER_KEY = 'mycel.webPush.later', ASK_BLOCKED_KEY = 'mycel.webPush.blocked'
export const ASK_LATER_MS = 7 * 24 * 60 * 60 * 1000
const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* storage blocked */ } }

export interface AskConditions {
  /** a web browser that can get Web Push here (lib/push.ts pushSupported, and not an iPhone browser tab) */
  supported: boolean
  /** Microsoft Edge (its push service is refused by the team server) */
  edge: boolean
  permission: NotificationPermission | null
  /** the server's push settings (null: not read) */
  settings: Pick<Settings, 'configured' | 'publicKey' | 'optedOut'> | null
  signedIn: boolean
  /** ASK_LATER_KEY as stored */
  later: string | null
  blocked: boolean
  now: number
}

/** What this device decides alone: signed in, Web Push here, not asked yet, not put away or blocked from the line. */
export function askAllowedHere(c: Omit<AskConditions, 'settings'>): boolean {
  if (!c.signedIn || !c.supported || c.edge || c.permission !== 'default' || c.blocked) return false
  const at = Number(c.later)
  return !(c.later && Number.isFinite(at) && c.now - at < ASK_LATER_MS)
}

/** Whether the line may show (see the top of this file). */
export function webPushAskShows(c: AskConditions): boolean {
  if (!askAllowedHere(c)) return false
  if (!c.settings?.configured || !c.settings.publicKey || c.settings.optedOut) return false
  try { vapidBytes(c.settings.publicKey) } catch { return false }
  return true
}

/** What this device knows without the server. */
const local = (now: number): Omit<AskConditions, 'settings'> => ({
  supported: pushSupported() && !pushNeedsInstall(), edge: isEdge(), permission: notificationPermission(), signedIn: true,
  later: read(ASK_LATER_KEY), blocked: read(ASK_BLOCKED_KEY) === '1', now,
})

interface AskState {
  /** the signed-in session the line was made ready for (user:session), or null */
  key: string | null
  /** ready to show (see revealed) */
  show: boolean
  /** shown: the person moved to another page since it was ready */
  revealed: boolean
  /** the page on screen when it became ready */
  readyPath: string | null
  busy: boolean
  /** why [알림 켜기] did not work, said in the line with a link to Settings › Notifications */
  failure: PushFailure | null
  settings: Settings | null
  registration: ServiceWorkerRegistration | null
}
export const useWebPushAsk = create<AskState>(() => ({ key: null, show: false, revealed: false, readyPath: null, busy: false, failure: null, settings: null, registration: null }))

/** Signed in as `key` (user:session; null: signed out): read the server's push settings once per session and get the
 * service worker ready, then show the line when it may. Quiet when anything is missing: no line. */
export async function prepareWebPushAsk(key: string | null, now = Date.now()): Promise<void> {
  if (key === useWebPushAsk.getState().key) return
  useWebPushAsk.setState({ key, show: false, revealed: false, readyPath: null, busy: false, failure: null, settings: null, registration: null })
  if (!key || !askAllowedHere(local(now))) return
  try {
    const settings = await api.call(API.getPushSettings)
    if (useWebPushAsk.getState().key !== key || !webPushAskShows({ ...local(now), settings })) return
    const registration = await pushRegistration()
    if (useWebPushAsk.getState().key !== key) return
    useWebPushAsk.setState({ show: true, settings, registration })
  } catch { /* no line */ }
}

/** The page on screen now (WebPushAsk, at every move): the line, once ready, shows from the next page on. */
export function noteWebPushAskPath(path: string): void {
  const s = useWebPushAsk.getState()
  if (!s.show || s.revealed) return
  if (s.readyPath === null) useWebPushAsk.setState({ readyPath: path })
  else if (s.readyPath !== path) useWebPushAsk.setState({ revealed: true })
}

/** [알림 켜기]: enablePush in the click (its permission question comes before any wait). 'on': push is on (the line goes
 * and the caller confirms); 'blocked': the browser's "block" (the line goes for good on this device); 'failed': the
 * reason shows in the line; null: nothing happened (busy, not ready, the account changed). */
export async function turnOnWebPush(): Promise<'on' | 'blocked' | 'failed' | null> {
  const s = useWebPushAsk.getState()
  if (!s.show || s.busy || !s.registration || !s.settings?.publicKey) return null
  const key = s.key
  const work = enablePush(s.registration, s.settings.publicKey, s.settings.subscriptionId)
  useWebPushAsk.setState({ busy: true, failure: null })
  try {
    await work
    if (useWebPushAsk.getState().key !== key) return null
    useWebPushAsk.setState({ show: false, busy: false })
    return 'on'
  } catch (error) {
    const f = pushFailure(error)
    logPushFailure(error, f)
    if (useWebPushAsk.getState().key !== key) return null
    if (f.kind === 'denied') {
      write(ASK_BLOCKED_KEY, '1')
      useWebPushAsk.setState({ show: false, busy: false })
      return 'blocked'
    }
    useWebPushAsk.setState({ busy: false, failure: f.kind === 'cancelled' ? null : f })
    return f.kind === 'cancelled' ? null : 'failed'
  }
}

/** [나중에]: away for 7 days on this device. */
export function webPushAskLater(now = Date.now()): void {
  write(ASK_LATER_KEY, String(now))
  useWebPushAsk.setState({ show: false, failure: null })
}
