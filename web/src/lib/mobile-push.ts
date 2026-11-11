import { create } from 'zustand'
import { api, API } from './api'
import { confirmPushDevice, mobileApp, requestPushPermission, requestPushToken } from './mobile'
import { PUSH_CAPABILITY, type PushPermission } from '../../../mobile/src/protocol'

let session: string | null = null, epoch = 0, tried: string | null = null, registered: string | null = null, listening = false
// a check running for this session, and the retries after one that got no definite answer
let trying: string | null = null, retries = 0, retryTimer: ReturnType<typeof setTimeout> | null = null
// one registration at a time (the OS prompt sends the app to the background and back, and coming back checks again)
let inFlight: { turn: number; promise: Promise<string> } | null = null

/** Inside the phone app: true when it can hand over a push token (push-token-v1). */
export function mobilePushApp(): boolean { return !!mobileApp()?.capabilities.includes(PUSH_CAPABILITY) }

/** The phone's notification state for the signed-in page. permission: what the OS said (push-permission-v1), or what
 * this phone's page learned itself on an app that cannot tell (null: unknown). ask: show the in-app question. */
export const usePhonePush = create<{ permission: PushPermission | null; ask: boolean; registered: number }>(() => ({ permission: null, ask: false, registered: 0 }))

// This phone's answers, in the team page's own storage (per phone and team; a reinstalled app starts empty, like the
// OS permission): granted (the OS gave a token before), denied (the OS said no), later ({n, at}: [나중에]), offHere
// (Settings' switch turned this phone off: it is not registered again by itself, at a sign-in or an app start, until the
// switch or the question turns it on).
const GRANTED = 'mycel.phonePush.granted', DENIED = 'mycel.phonePush.denied', LATER = 'mycel.phonePush.later', OFF_HERE = 'mycel.phonePush.offHere'
const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string | null) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* storage blocked */ } }

/** [나중에]: the question stays away for a week; after the second [나중에] it does not come back by itself (Settings ›
 * Notifications keeps the button). */
export const LATER_MS = 7 * 24 * 60 * 60 * 1000
export function laterHides(raw: string | null, now: number): boolean {
  if (!raw) return false
  try {
    const v = JSON.parse(raw) as { n?: unknown; at?: unknown }
    const n = typeof v.n === 'number' ? v.n : 0, at = typeof v.at === 'number' ? v.at : 0
    return n >= 2 || (n >= 1 && now - at < LATER_MS)
  } catch { return false }
}
export function askLater(now = Date.now()): void {
  let n = 0
  try { const v = JSON.parse(read(LATER) ?? '{}') as { n?: unknown }; n = typeof v.n === 'number' ? v.n : 0 } catch { /* a broken value counts as none */ }
  write(LATER, JSON.stringify({ n: n + 1, at: now }))
  usePhonePush.setState({ ask: false })
}

/** The OS answer, corrected by what this page learned: an Android 13+ phone may ask once more after a "no" (the OS
 * says it may), but that "no" stands until the person turns it on in Settings; an app that cannot tell (null) is
 * granted once it gave a token here. */
function effective(os: PushPermission | null): PushPermission | null {
  if (os === 'granted') { write(DENIED, null); return 'granted' }
  if (os === 'denied' || read(DENIED)) return 'denied'
  return os ?? (read(GRANTED) ? 'granted' : null)
}

/** Signed in inside the phone app: register this phone with the team for this session, but show the OS prompt only
 * from the in-app question's [알림 켜기] (or Settings). So: when the OS already said yes, register without a word; when
 * it has not been asked (or an older app cannot tell), the page shows its own question; when it said no, Settings says
 * so. Skipped when this server has no push gateway or the person turned push off. Logout needs no call: the server
 * drops the device with the session. The session is often known before the app has installed its bridge (it does that
 * when the page has loaded), so the bridge's ready event tries again for a session that has not been tried; coming
 * back from the phone's Settings checks the permission again. */
export function setMobilePushSession(next: string | null): void {
  if (typeof window !== 'undefined' && !listening) {
    listening = true
    window.addEventListener('mycel:mobile-ready', () => tryRegister())
    // back from the phone's Settings (or anywhere): check again, or try again a check that got no answer
    window.addEventListener('mycel:mobile-foreground', () => { if (session && tried === session) void refreshPhonePush().catch(() => {}); else tryRegister() })
  }
  if (next === session) return
  session = next; tried = null; trying = null; registered = null; retries = 0; epoch++
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  usePhonePush.setState({ permission: null, ask: false })
  tryRegister()
}
/** The session's first check. It counts as done only with a definite answer: a call that timed out or failed (a busy
 * phone or server) is tried again on the next bridge-ready or foreground event, and a few times by itself. */
export const RETRY_MS = 5000
function tryRegister() {
  const key = session
  if (!key || tried === key || trying === key || !mobilePushApp()) return
  trying = key
  void refreshPhonePush().then(definite => { if (definite && session === key) tried = key }, () => { /* tried again below */ }).finally(() => {
    if (trying === key) trying = null
    if (session !== key || tried === key || retries >= 3) return
    retries++
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => { retryTimer = null; tryRegister() }, RETRY_MS * retries)
  })
}

/** Reads the server's push settings and the OS answer, then registers, asks or stays quiet (see setMobilePushSession).
 * True when it got a definite answer; false or an error when it should be tried again. */
export async function refreshPhonePush(): Promise<boolean> {
  const turn = epoch, key = session
  if (!key || !mobilePushApp()) return false
  const settings = await api.call(API.getPushSettings)
  if (turn !== epoch) return false
  if (!settings.native?.available) { usePhonePush.setState({ permission: null, ask: false }); return true }
  let os: PushPermission | null
  try { os = await requestPushPermission() } catch (error) {
    // push_unavailable: this build or phone has no push at all; nothing to ask (a definite answer)
    if ((error as Error)?.message === 'push_unavailable') { if (turn === epoch) usePhonePush.setState({ permission: null, ask: false }); return turn === epoch }
    throw error
  }
  if (turn !== epoch) return false
  // An app that cannot tell (store builds 1 and 2) whose session already has a phone registered: the OS said yes, as
  // the page registered it before this change at every sign-in. Remembered, so later sign-ins register quietly too.
  // A "no" this phone gave since then still stands: registering would show the OS prompt again where Android allows it.
  const hasDevice = !!(settings.enabled && settings.native.deviceId) && !read(DENIED)
  if (os === null && hasDevice) write(GRANTED, '1')
  const permission = effective(os ?? (hasDevice ? 'granted' : null))
  const offHere = !!read(OFF_HERE)
  usePhonePush.setState({ permission, ask: !settings.optedOut && !offHere && permission !== 'granted' && permission !== 'denied' && !laterHides(read(LATER), Date.now()) })
  if (permission === 'granted' && !settings.optedOut && !offHere && registered !== key) await registerMobilePush(turn)
  return turn === epoch
}

/** Settings' switch for this phone, off: the team server forgets this phone (the person's other devices keep push), and
 * this phone is not registered again by itself until it is turned on here (registerMobilePush). */
export async function turnOffPhonePush(deviceId: string): Promise<void> {
  await api.call(API.unregisterPushDevice, { params: { id: deviceId } })
  write(OFF_HERE, '1')
  registered = null
}

/** Settings › Notifications in the phone app: one status line and one action. After a "no" from the OS: the way to the
 * phone's Settings where the app can open it (push-permission-v1); an older app keeps [알림 켜기], which asks the OS
 * again without a prompt (it answers push_denied at once while notifications stay off there, and registers once they
 * are on), so turning it on in the phone's Settings is never a dead end. */
export type PhonePushView = { status: 'push.on' | 'push.off' | 'push.deniedPhone' | 'push.deniedApp'; action: 'disable' | 'enable' | 'open-settings' }
export function phonePushView(o: { permission: PushPermission | null; on: boolean; canOpenSettings: boolean }): PhonePushView {
  if (o.permission === 'denied') return o.canOpenSettings ? { status: 'push.deniedPhone', action: 'open-settings' } : { status: 'push.deniedApp', action: 'enable' }
  // a device the server still has does not make it on while the OS has not allowed notifications
  return o.on && o.permission !== 'undetermined' ? { status: 'push.on', action: 'disable' } : { status: 'push.off', action: 'enable' }
}

/** The question's [알림 켜기] and Settings' "turn on" (an explicit choice, so an earlier opt-out does not stop it). The
 * app shows the OS prompt here if the person has not answered yet. One at a time: a second call while one runs gets
 * the same result (two would leave the team two removal keys for one phone). */
export function registerMobilePush(turn = epoch): Promise<string> {
  if (inFlight?.turn === turn) return inFlight.promise
  const promise: Promise<string> = register(turn).finally(() => { if (inFlight?.promise === promise) inFlight = null })
  inFlight = { turn, promise }
  return promise
}
async function register(turn: number): Promise<string> {
  const key = session
  let token
  try { token = await requestPushToken() } catch (error) {
    const code = (error as Error)?.message
    if (code === 'push_denied' && turn === epoch) { write(DENIED, '1'); write(GRANTED, null); usePhonePush.setState({ permission: 'denied', ask: false }) }
    // this build or phone has no push (an Android build without Firebase): the question has nothing to offer
    if (code === 'push_unavailable' && turn === epoch) usePhonePush.setState({ ask: false })
    throw error
  }
  if (turn !== epoch) throw new DOMException('Mobile operation cancelled', 'AbortError')
  write(GRANTED, '1'); write(DENIED, null); write(OFF_HERE, null)
  usePhonePush.setState({ permission: 'granted', ask: false })
  // with the hash of the label key of an iPhone app that shows who and where in a room push (push-label-v1)
  const { id, removeKey } = await api.call(API.registerPushDevice, { body: { consent: true, ...token } })
  if (turn === epoch) { registered = key; usePhonePush.setState(s => ({ registered: s.registered + 1 })) }
  // the session changed meanwhile (sign-out, another person): this device id and key are not the app's to keep now
  if (turn !== epoch) throw new DOMException('Mobile operation cancelled', 'AbortError')
  // An app without push-registered-v1 (the first store build) still gets push; it only cannot remove itself on a team
  // switch or tell this team's taps from another's. confirmPushDevice does not even ask such an app.
  await confirmPushDevice(id, removeKey).catch(() => false)
  return id
}
