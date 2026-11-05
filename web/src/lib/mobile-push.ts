import { api, API } from './api'
import { confirmPushDevice, mobileApp, requestPushToken } from './mobile'
import { PUSH_CAPABILITY } from '../../../mobile/src/protocol'

let session: string | null = null, epoch = 0, tried: string | null = null, listening = false

/** Inside the phone app: true when it can hand over a push token (push-token-v1). */
export function mobilePushApp(): boolean { return !!mobileApp()?.capabilities.includes(PUSH_CAPABILITY) }

/** Signed in inside the phone app: ask the app for its device token (the OS prompt appears then, once, never at first
 * launch) and register it with this team for this session. Skipped when this server has no push gateway or the person
 * turned push off. Logout needs no call: the server drops the device with the session. The session is often known
 * before the app has installed its bridge (it does that when the page has loaded), so the bridge's ready event tries
 * again for a session that has not been tried. */
export function setMobilePushSession(next: string | null): void {
  if (typeof window !== 'undefined' && !listening) { listening = true; window.addEventListener('mycel:mobile-ready', () => tryRegister()) }
  if (next === session) return
  session = next; tried = null; epoch++
  tryRegister()
}
function tryRegister() {
  const key = session, turn = epoch
  if (!key || tried === key || !mobilePushApp()) return
  tried = key
  void (async () => {
    const settings = await api.call(API.getPushSettings)
    if (turn !== epoch || !settings.native?.available || settings.optedOut) return
    await registerMobilePush(turn)
  })().catch(() => { /* push stays off; the settings page shows why */ })
}

/** Also the settings page's "turn on" in the app (an explicit choice, so an earlier opt-out does not stop it). */
export async function registerMobilePush(turn = epoch): Promise<string> {
  const token = await requestPushToken()
  if (turn !== epoch) throw new DOMException('Mobile operation cancelled', 'AbortError')
  const { id, removeKey } = await api.call(API.registerPushDevice, { body: { consent: true, ...token } })
  // An app without push-registered-v1 (the first store build) still gets push; it only cannot remove itself on a team
  // switch or tell this team's taps from another's. confirmPushDevice does not even ask such an app.
  await confirmPushDevice(id, removeKey).catch(() => false)
  return id
}
