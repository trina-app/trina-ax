import { APPEARANCE_CAPABILITY, BADGE_CAPABILITY, base64Size, MAX_BADGE, MAX_CHUNK_BYTES, MAX_FILE_BYTES, MAX_PICK_BYTES, MAX_PICK_FILES, MAX_SHARE_TEXT, NAV_CAPABILITY, PHOTO_PICK_CAPABILITY, PICK_CHUNK_BYTES, pickChunkLength, PUSH_CAPABILITY, PUSH_LABEL_CAPABILITY, PUSH_PERMISSION_CAPABILITY, PUSH_REGISTERED_CAPABILITY, pushPermission, safeFileName, sameTeam, SHARE_TEXT_CAPABILITY, googleOAuthUrl, validConfig, validPicks, validPushToken, type MobileConfig, type MobileMessage, type MobileReply, type PushPermission, type PushToken } from '../../../mobile/src/protocol'
import { currentTheme } from './theme'

type PhoneWindow = Window & { mycelMobile?: unknown; ReactNativeWebView?: { postMessage(raw: string): void } }
export function mobileApp(): MobileConfig | null {
  if (typeof window === 'undefined' || window.top !== window.self) return null
  const w = window as PhoneWindow
  return validConfig(w.mycelMobile) && typeof w.ReactNativeWebView?.postMessage === 'function' ? w.mycelMobile : null
}
interface Pending { config: MobileConfig; type: MobileMessage['type']; seq?: number; resolve: (reply: MobileReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>()
const downloads = new Set<AbortController>()
let epoch = 0, busy = false, picking = false, initialized = false
let sessionKey: string | null = null
// No one is signed in on this page (status signed-out: the sign-in page at a cold start, a sign-out, an expired
// session), and whether the app has heard it since: it is told once per bridge, also when the bridge comes later.
let pageSignedOut = false, signedOutTold = false
let barrier: Promise<void> = Promise.resolve()
let onError: (error: unknown) => void = () => {}
const cancelled = () => new DOMException('Mobile operation cancelled', 'AbortError')
const keyOf = (id: string, type: string, seq?: number) => `${id}:${type}:${seq ?? ''}`
const current = (c: MobileConfig) => { const a = mobileApp(); return !!a && a.nonce === c.nonce && a.generation === c.generation }
export const reportMobileError = (error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) onError(error) }
export class MobileFileTooLarge extends Error { constructor() { super('mobile_file_too_large') } }

function receive(event: Event) {
  const r = (event as CustomEvent<unknown>).detail
  if (!r || typeof r !== 'object') return
  const reply = r as MobileReply
  const p = pending.get(keyOf(reply.id, reply.for, reply.seq))
  if (!p || reply.v !== 1 || reply.type !== 'mobile-result' || reply.nonce !== p.config.nonce || reply.generation !== p.config.generation || typeof reply.ok !== 'boolean') return
  pending.delete(keyOf(reply.id, reply.for, reply.seq)); clearTimeout(p.timer)
  if (reply.ok) p.resolve(reply); else p.reject(new Error(reply.error === 'push_denied' || reply.error === 'push_unavailable' || reply.error === 'photo_denied' ? reply.error : 'mobile_operation_failed'))
}
function request(message: MobileMessage, config: MobileConfig, timeoutMs = 60_000): Promise<MobileReply> {
  if (!current(config)) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const seq = 'seq' in message ? message.seq : undefined, key = keyOf(message.id, message.type, seq)
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('mobile_timeout')) }, timeoutMs)
    pending.set(key, { config, type: message.type, seq, resolve, reject, timer })
    try { (window as PhoneWindow).ReactNativeWebView!.postMessage(JSON.stringify(message)) }
    catch { clearTimeout(timer); pending.delete(key); reject(new Error('mobile_unavailable')) }
  })
}
const envelope = (config: MobileConfig, id = crypto.randomUUID()) => ({ v: 1 as const, nonce: config.nonce, generation: config.generation, id })
function abortPending(preserveReset = false) {
  epoch++
  for (const [key, p] of pending) {
    if (preserveReset && p.type === 'session-reset') continue
    clearTimeout(p.timer); p.reject(cancelled()); pending.delete(key)
  }
  for (const controller of downloads) controller.abort()
  downloads.clear()
}
/** Session identity stays in JS memory. Only an opaque generation reset crosses the native bridge, and whether the
 * person is out: signedOut (the status says signed-out, or one person's session gave way to another's) makes the app
 * clear the notifications on screen, which may name people, and the key its notification extension reads them with.
 * Loading, an error screen, a sign-in or a reload of a signed-in page are no sign-out. */
export function setMobileSession(key: string | null, signedOut = false): void {
  const switched = sessionKey !== null && key !== null && key !== sessionKey
  const out = key === null && signedOut
  if (key === sessionKey && !(out && !signedOutTold)) return
  // a new state of the page: the app has not heard it yet
  if (key !== sessionKey) signedOutTold = false
  sessionKey = key; pageSignedOut = out
  // the app clears the icon itself at a sign-out: the last person's number is not sent again after the reset (another
  // person signing in: their page's count replaces it as soon as it is worked out)
  if (out) badge = 0
  resetMobileSession(switched || out)
}
export function resetMobileSession(signedOut = false): void {
  abortPending(true)
  barrier = barrier.catch(() => {}).then(async () => {
    const config = mobileApp(); if (!config) return
    const reply = await request({ ...envelope(config), type: 'session-reset', ...(signedOut ? { signedOut: true } : {}) }, config)
    if (reply.nextGeneration !== config.generation + 1) throw new Error('mobile_protocol_mismatch')
    // heard only once the app answered (a reset that was dropped is told again at the next bridge-ready)
    if (signedOut && pageSignedOut && sessionKey === null) signedOutTold = true
    // Native also installs this config before delivering its acknowledgement.
    if (!mobileApp() || mobileApp()!.generation !== reply.nextGeneration) throw new Error('mobile_protocol_mismatch')
    void sendAppearance().catch(() => {})
    void sendNav().catch(() => {})
    void sendBadge().catch(() => {})
  })
  void barrier.catch(reportMobileError)
}
function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}
export async function sendFileToApp(blob: Blob, name: string): Promise<void> {
  if (blob.size > MAX_FILE_BYTES) throw new MobileFileTooLarge()
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const config = mobileApp()
  if (!config) throw new Error('mobile_unavailable')
  if (busy) throw new Error('mobile_transfer_busy')
  busy = true
  const env = envelope(config)
  const check = () => { if (turn !== epoch || !current(config)) throw cancelled() }
  try {
    const bytes = await blob.arrayBuffer(); check()
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join(''); check()
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(blob.type) ? blob.type : 'application/octet-stream'
    await request({ ...env, type: 'file-begin', name: safeFileName(name), mime, size: blob.size, sha256 }, config)
    let seq = 0
    for (let off = 0; off < bytes.byteLength; off += MAX_CHUNK_BYTES) {
      check()
      await request({ ...env, type: 'file-chunk', seq: seq++, b64: base64(new Uint8Array(bytes, off, Math.min(MAX_CHUNK_BYTES, bytes.byteLength - off))) }, config)
    }
    check(); await request({ ...env, type: 'file-end', seq }, config)
  } catch (error) {
    if (current(config)) (window as PhoneWindow).ReactNativeWebView?.postMessage(JSON.stringify({ ...env, type: 'file-abort' }))
    throw error
  } finally { busy = false }
}
export async function downloadToApp(url: string, name?: string): Promise<void> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const resolved = new URL(url, location.href)
  if (!sameTeam(location.origin, resolved.href)) throw new Error('mobile_external_download')
  const controller = new AbortController()
  downloads.add(controller)
  try {
    const r = await fetch(resolved.href, { credentials: 'same-origin', redirect: 'error', signal: controller.signal })
    if (!r.ok || (r.url && !sameTeam(location.origin, r.url))) throw new Error('mobile_download_failed')
    const blob = await readMobileDownload(r)
    if (turn !== epoch) throw cancelled()
    let fromHeader = /filename\*=UTF-8''([^;]+)/i.exec(r.headers.get('content-disposition') ?? '')?.[1]
    try { fromHeader = fromHeader ? decodeURIComponent(fromHeader) : undefined } catch { fromHeader = undefined }
    await sendFileToApp(blob, name || fromHeader || resolved.pathname.split('/').at(-1) || 'file')
  } finally { downloads.delete(controller) }
}
/** Bound streaming bodies even when the server omits or understates Content-Length. */
export async function readMobileDownload(r: Response): Promise<Blob> {
  if (Number(r.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) { await r.body?.cancel(); throw new MobileFileTooLarge() }
  const chunks: Uint8Array[] = []; let size = 0
  const reader = r.body?.getReader()
  if (reader) for (;;) {
    const { done, value } = await reader.read(); if (done) break
    size += value.byteLength
    if (size > MAX_FILE_BYTES) { await reader.cancel(); throw new MobileFileTooLarge() }
    chunks.push(value)
  }
  return new Blob(chunks as BlobPart[], { type: r.headers.get('content-type') ?? '' })
}
/** Google code/state remain in the external browser and server callback. The original app session polls its flow. */
export async function openExternal(url: string, options: { purpose: 'google-oauth' }): Promise<void> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  if (options.purpose !== 'google-oauth' || !googleOAuthUrl(url)) throw new Error('mobile_external_refused')
  const config = mobileApp(); if (!config) throw new Error('mobile_unavailable')
  await request({ ...envelope(config), type: 'external-open', url, purpose: options.purpose }, config)
}
/** The phone's APNs/FCM device token (push-token-v1). The app shows the OS permission prompt here if the person has not
 * answered yet, so this is only called for a signed-in session. Rejects with push_denied / push_unavailable. labelHash:
 * an iPhone app that shows who and where in a room push (push-label-v1) made a label key for its notification extension
 * and gives only its hash, which the page registers with the token. */
export async function requestPushToken(): Promise<PushToken & { labelHash?: string }> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const config = mobileApp()
  if (!config?.capabilities.includes(PUSH_CAPABILITY)) throw new Error('push_unavailable')
  // The OS dialog waits for the person: allow it five minutes.
  const reply = await request({ ...envelope(config), type: 'push-token' }, config, 300_000)
  if (turn !== epoch) throw cancelled()
  if (!validPushToken(reply.push)) throw new Error('push_unavailable')
  const { platform, token, environment } = reply.push
  const labelHash = config.capabilities.includes(PUSH_LABEL_CAPABILITY) && platform === 'ios' && typeof reply.labelHash === 'string' && /^[0-9a-f]{64}$/.test(reply.labelHash) ? reply.labelHash : undefined
  return { platform, token, environment, ...(labelHash ? { labelHash } : {}) }
}
/** Tells the app which device id this team gave it (taps from other teams are ignored) and the removal key the app
 * uses to remove the device when the person switches team. Only an app offering push-registered-v1 gets it: an older
 * build would never answer. Returns whether the app took it. */
export async function confirmPushDevice(deviceId: string, removeKey: string): Promise<boolean> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const config = mobileApp()
  if (!config?.capabilities.includes(PUSH_REGISTERED_CAPABILITY)) return false
  await request({ ...envelope(config), type: 'push-registered', deviceId, removeKey }, config)
  return true
}
/** What the OS says about notifications for this app (push-permission-v1); the app never shows its prompt for this.
 * null: this app cannot tell (store builds 1 and 2). Rejects with push_unavailable when the build has no push. */
export async function requestPushPermission(): Promise<PushPermission | null> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const config = mobileApp()
  if (!config?.capabilities.includes(PUSH_PERMISSION_CAPABILITY)) return null
  const reply = await request({ ...envelope(config), type: 'push-permission' }, config, 10_000)
  if (turn !== epoch) throw cancelled()
  if (!pushPermission(reply.permission)) throw new Error('push_unavailable')
  return reply.permission
}
/** The app can open its page in the phone's Settings (push-permission-v1). */
export const canOpenAppSettings = () => !!mobileApp()?.capabilities.includes(PUSH_PERMISSION_CAPABILITY)
export async function openAppSettings(): Promise<void> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const config = mobileApp()
  if (!config?.capabilities.includes(PUSH_PERMISSION_CAPABILITY)) throw new Error('mobile_unavailable')
  // Not awaited: the app answers when it is back, which may be long after the person left for the phone's Settings,
  // and that is no failure. Coming back checks the permission again (lib/mobile-push.ts).
  void request({ ...envelope(config), type: 'open-settings' }, config, 600_000).catch(() => {})
}
/** The app opens the phone's own share sheet with a text (share-text-v1; lib/share.ts): Android's WebView has no
 * navigator.share. */
export const appSharesText = () => !!mobileApp()?.capabilities.includes(SHARE_TEXT_CAPABILITY)
/** The phone's share sheet with `text` (share-text-v1), answered once the sheet is up or closed. Rejects when the app
 * cannot (an older build), the text is too long, or the page moved on. */
export async function shareTextToApp(text: string): Promise<void> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const config = mobileApp()
  if (!config?.capabilities.includes(SHARE_TEXT_CAPABILITY)) throw new Error('mobile_unavailable')
  if (!text.trim() || text.length > MAX_SHARE_TEXT) throw new Error('mobile_share_text')
  // the sheet waits for the person (iOS answers when it closes)
  await request({ ...envelope(config), type: 'share-text', text }, config, 300_000)
}
/** The app opens the phone's own photo picker (photo-pick-v1): the 사진 보관함 row skips the small menu iOS shows for
 * any input that takes pictures. An older app: the page keeps its file input. */
export const appPicksPhotos = () => !!mobileApp()?.capabilities.includes(PHOTO_PICK_CAPABILITY)
/** What one pick takes: bytes a file, bytes together, files. */
export const PHOTO_PICK_LIMITS = { file: MAX_FILE_BYTES, pick: MAX_PICK_BYTES, files: MAX_PICK_FILES } as const
function fromBase64(b64: string): Uint8Array {
  const text = atob(b64), out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}
/** What the person picked in the phone's own photo picker (photo-pick-v1), as files for the box's usual upload: at most
 * `limit`, [] when they cancelled; `tooBig`, the names the app left out for their size (50 MiB a file, 200 MiB a pick).
 * Only bytes cross: never a path or a URL, and nothing is fetched. Each chunk is asked for in order and must be exactly
 * as long as the file says. Rejects with photo_denied when the phone refused access, and with an AbortError when the
 * page moved on (a navigation, a team change, a sign-out); the app then drops the pick itself. */
export async function pickPhotosFromApp(limit: number): Promise<{ files: File[]; tooBig: string[] }> {
  const turn = epoch
  await barrier
  if (turn !== epoch) throw cancelled()
  const config = mobileApp()
  if (!config?.capabilities.includes(PHOTO_PICK_CAPABILITY)) throw new Error('mobile_unavailable')
  if (picking) throw new Error('mobile_transfer_busy')
  picking = true
  const env = envelope(config), want = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_PICK_FILES)
  const check = () => { if (turn !== epoch || !current(config)) throw cancelled() }
  let asked = false
  try {
    // the picker waits for the person
    const reply = await request({ ...env, type: 'photo-pick', limit: want }, config, 600_000)
    check()
    // the app holds copies unless it answered "nothing picked" (cancelled, or all left out)
    asked = !Array.isArray(reply.files) || reply.files.length > 0
    const tooBig = reply.tooBig ?? []
    if (!validPicks(reply.files, tooBig, want)) throw new Error('mobile_protocol_mismatch')
    const files: File[] = []
    let seq = 0
    for (const [index, f] of reply.files.entries()) {
      const parts: Uint8Array[] = []
      for (let offset = 0; offset < f.size; offset += PICK_CHUNK_BYTES) {
        check()
        const r = await request({ ...env, type: 'photo-chunk', seq, index, offset }, config)
        check()
        if (typeof r.b64 !== 'string' || base64Size(r.b64) !== pickChunkLength(f.size, offset)) throw new Error('mobile_protocol_mismatch')
        parts.push(fromBase64(r.b64)); seq++
      }
      files.push(new File(parts as BlobPart[], f.name, { type: f.mime }))
    }
    return { files, tooBig }
  } finally {
    picking = false
    // the app deletes its copies (also when the page gave up)
    if (asked && current(config)) void request({ ...env, type: 'photo-done' }, config, 10_000).catch(() => {})
  }
}
/** The page's look for the app's status bar (appearance-v1): when the bridge comes, when the theme changes, and again
 * after every session reset (a send that the reset fenced off is not lost). Not tied to a session: the latest look
 * always wins, so neither a pending reset nor a failed one stops it. */
async function sendAppearance(): Promise<void> {
  await barrier.catch(() => {})
  const config = mobileApp()
  if (!config?.capabilities.includes(APPEARANCE_CAPABILITY)) return
  await request({ ...envelope(config), type: 'appearance', dark: document.documentElement.classList.contains('dark'), system: currentTheme() === 'system' }, config, 10_000)
}
/** Where Back goes in this page (nav-v1, lib/appNav.ts): the latest the page worked out. */
export interface AppNav { canGoBack: boolean; home: boolean }
let nav: AppNav | null = null
/** what the app last heard, for this bridge (nonce and generation): a send of the same is skipped */
let navSent = ''
/** Tells the app where Back goes (nav-v1: the iOS edge swipe, Android's Back): when it changes, when the bridge comes
 * and again after every session reset (a send the reset fenced off is not lost). Like the look, not tied to a session:
 * the latest always wins. Only an app offering nav-v1 hears it (an older one would never answer). */
export function setAppNav(next: AppNav): void {
  nav = { canGoBack: next.canGoBack, home: next.home }
  void sendNav().catch(() => {})
}
async function sendNav(): Promise<void> {
  await barrier.catch(() => {})
  const config = mobileApp()
  if (!nav || !config?.capabilities.includes(NAV_CAPABILITY)) return
  const { canGoBack, home } = nav
  const sent = `${config.nonce}:${config.generation}:${canGoBack}:${home}`
  if (sent === navSent) return
  navSent = sent
  try {
    await request({ ...envelope(config), type: 'nav', canGoBack, home }, config, 10_000)
  } catch (error) {
    // not heard: the next change, bridge or reset sends it again
    if (navSent === sent) navSent = ''
    throw error
  }
}
/** The app icon's number (badge-v1): the latest count the page worked out (store/sessionMarkers.ts), null before any. */
let badge: number | null = null
/** what the app last heard, for this bridge (nonce and generation): a send of the same is skipped */
let badgeSent = ''
/** Tells the phone app the number for its icon (badge-v1): the page's one count n, as the tab title and the Mac Dock
 * show it. Sent when it changes, when the bridge comes, after a session reset and every time the app comes to the
 * foreground (a push may have set another number meanwhile). A number only. An app without badge-v1 hears nothing. */
export function setAppBadge(n: number): void {
  badge = Number.isFinite(n) && n > 0 ? Math.min(MAX_BADGE, Math.floor(n)) : 0
  void sendBadge().catch(() => {})
}
async function sendBadge(again = false): Promise<void> {
  await barrier.catch(() => {})
  const config = mobileApp()
  if (badge === null || !config?.capabilities.includes(BADGE_CAPABILITY)) return
  const count = badge, sent = `${config.nonce}:${config.generation}:${count}`
  if (sent === badgeSent && !again) return
  badgeSent = sent
  try {
    await request({ ...envelope(config), type: 'badge', count }, config, 10_000)
  } catch (error) {
    // not heard: the next change, bridge, reset or foreground sends it again
    if (badgeSent === sent) badgeSent = ''
    throw error
  }
}
export function initMobile(errorHandler?: (error: unknown) => void): void {
  if (typeof window === 'undefined' || initialized) return
  initialized = true; onError = errorHandler ?? onError
  window.addEventListener('mycel:mobile', receive)
  window.addEventListener('mycel:mobile-ready', () => {
    abortPending(); barrier = Promise.resolve()
    // a page that knew it was signed out before the bridge came (a cold start on the sign-in page) tells the app now;
    // the reset sends the look after it
    if (pageSignedOut && !signedOutTold) resetMobileSession(true)
    else {
      void sendAppearance().catch(() => {})
      void sendNav().catch(() => {})
      void sendBadge().catch(() => {})
    }
  })
  // back on screen: the icon gets the page's number again (a push may have set the server's meanwhile)
  window.addEventListener('mycel:mobile-foreground', () => void sendBadge(true).catch(() => {}))
  window.addEventListener('mycel:theme', () => void sendAppearance().catch(() => {}))
  window.addEventListener('pagehide', () => abortPending())
  window.addEventListener('mycel:download', (event) => {
    const url = (event as CustomEvent<{ url?: unknown }>).detail?.url
    if (mobileApp() && typeof url === 'string') void downloadToApp(url).catch(reportMobileError)
  })
  document.addEventListener('click', (event) => {
    if (!mobileApp()) return
    const anchor = (event.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null
    if (!anchor || !sameTeam(location.origin, anchor.href)) return
    event.preventDefault()
    void downloadToApp(anchor.href, anchor.getAttribute('download') || undefined).catch(reportMobileError)
  }, true)
}
