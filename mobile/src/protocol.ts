// Versioned, platform-independent contract shared by the app and web adapter. No native imports here.
export const MOBILE_PROTOCOL = 1
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_CHUNK_BYTES = 3 * 1024 * 1024
export const TRANSFER_IDLE_MS = 60_000
/** Required by protocol 1: a bridge without them is not a mobile app. */
export const MOBILE_CAPABILITIES = ['file-share-v1', 'external-oauth-v1'] as const
/** Optional, versioned: the web page asks for this phone's native push token (APNs/FCM) after sign-in. An app without
 * it, or a web page that does not know it, keeps working; push simply stays off. */
export const PUSH_CAPABILITY = 'push-token-v1'
/** Optional, versioned: the app takes `push-registered` (the team's device id and removal key). An app without it (the
 * first App Store build) never answers that message, so the page sends it only when this is offered. */
export const PUSH_REGISTERED_CAPABILITY = 'push-registered-v1'
/** Optional, versioned: `push-permission` tells the page what the OS says about notifications for this app, without
 * ever showing the OS prompt (reply `permission`), and `open-settings` opens this app's page in the phone's Settings.
 * Store builds 1 and 2 lack it: the page then asks the OS only when the person taps its own "turn on" button. */
export const PUSH_PERMISSION_CAPABILITY = 'push-permission-v1'
/** Optional, versioned: `appearance` tells the app whether the page is dark and whether it follows the phone's look
 * (`system`), so the status bar text stays readable. The app draws the page edge to edge; the page pads itself
 * (env(safe-area-inset-*), and the --app-inset-* CSS variables the app sets before the page loads, for WebViews that
 * do not report the insets). */
export const APPEARANCE_CAPABILITY = 'appearance-v1'
/** Optional, versioned: the app shows who and where in a room push. The iPhone's notification service extension (1.0.1
 * on) and Android's messaging service (Android builds from 1.0.11 on, plugins/push-label.js) ask the team for the title with a label key the
 * app made and keeps on the phone. The `push-token` reply then also has `labelHash` (sha256 hex of that key), which the
 * page registers with the token. On Android that registration also makes room pushes data-only, so the app builds them. */
export const PUSH_LABEL_CAPABILITY = 'push-label-v1'
/** Optional, versioned: `share-text` opens the phone's own share sheet with a text the page made (the team invite
 * message: KakaoTalk, Slack, a text message). Android's WebView has no navigator.share; on the iPhone the app's sheet is
 * the same one. An app without it: the page uses navigator.share where there is one, else copies. */
export const SHARE_TEXT_CAPABILITY = 'share-text-v1'
/** The longest text `share-text` carries (the invite message is a few lines). */
export const MAX_SHARE_TEXT = 4000
/** Optional, versioned: the page says where Back goes (`nav`: an overlay is open or its screen has one under it, and
 * whether it is on the start tab) whenever its screen or top overlay changes; the app then turns the iOS edge swipe on
 * only while Back has somewhere to go, and Android's Back goes to the start tab (`mycel:start-tab`) before it leaves the
 * app. A tapped notification is opened with `mycel:open` (the page's router, no reload), or `location.assign` when no
 * page listener takes it. An app without it never hears `nav`; a page that sends none keeps today's raw history. */
export const NAV_CAPABILITY = 'nav-v1'
/** Optional, versioned: `photo-pick` opens the phone's own photo picker (PHPicker on iOS, the Photo Picker on Android),
 * so the page's 사진 보관함 skips the small menu iOS shows for any input that takes pictures (Photo Library / Take Photo
 * / Choose File). The reply names what the person picked (name, type, size; never a path or URL) and what was left out
 * for its size; the page then asks for the bytes with `photo-chunk`, one chunk at a time and in order, and ends with
 * `photo-done` (the app deletes its copies). Cancelled is an empty list. An app without it: the page keeps its file input. */
export const PHOTO_PICK_CAPABILITY = 'photo-pick-v1'
/** Optional, versioned: `badge` gives the app the page's count (the one count n of its tab title and the Mac Dock) for
 * the app icon: when it changes, whenever the app comes to the foreground, and 0 at sign-out. A number only. An app
 * without it: the icon shows what the last push set (an app before 1.0.5 asked for no badge, so iOS shows none). */
export const BADGE_CAPABILITY = 'badge-v1'
/** Optional, versioned: the app takes silent sync pushes (code phone.sync, docs/AGENTS/plan/20261123-0705-phone-badge-sync.md):
 * Android's messaging service takes the notices read on another device off the tray and shows nothing. The page then
 * registers the device with `sync: true`; the team sends an Android phone syncs only then (an app from before would
 * list an empty notification for one while it is open). An iPhone gets its number by APNs either way. */
export const PUSH_SYNC_CAPABILITY = 'push-sync-v1'
/** Optional, versioned: an iPhone app that takes the notices read on another device off Notification Center itself
 * (docs/AGENTS/plan/20261124-1853-iphone-clear-read-notifications.md): the remote-notification background mode and its
 * native handler (modules/push-sync) remove the delivered notifications a silent sync lists (`body.clear`), closed or
 * open. The page then registers the device with `clear: true` (next to `sync: true`) and the team's iPhone syncs carry
 * the ids. An app without it: the iPhone gets its icon number only, as before. iPhone only. */
export const PUSH_CLEAR_CAPABILITY = 'push-clear-v1'
/** Optional, versioned: `change-team` opens the app's own "다른 팀에 연결" screen over the team (the one the signed-out
 * page's footer opens): the team stays until another one answered and the person said yes. The 나 tab's "다른 팀으로
 * 전환…" row. An app without it: the page shows no such row. */
export const CHANGE_TEAM_CAPABILITY = 'change-team-v1'
/** Optional, versioned: voice input transcribed on the phone itself (docs/decisions/20261119-iphone-dictation.md), as
 * the Mac app does. The page records as always and asks `dictation-check` for its language (reply `dictation`: ready,
 * needs-model or unsupported); `dictation-install` fetches Apple's model for it (progress as events, reply `installed`);
 * `dictation-start` (the envelope id names the recording; reply `started`) is followed by `dictation-push` with the
 * 16 kHz mono signed 16-bit little-endian samples (base64, in order by `seq`, never answered), then `dictation-stop`
 * or `dictation-cancel`. The words come back as `mycel:mobile-dictation` events for that id (dictationEventScript):
 * text (final false is a guess the next text replaces), done after stop, error. Nothing leaves the phone. Only the
 * iPhone app with its Dictation module offers it; without it the team server transcribes, as before.
 * The Android app (1.0.10, docs/decisions/20261119-android-dictation.md) offers the same with two additions an older page
 * ignores. Only a page that says `appMic: true` in its `dictation-check` gets it (any other is told unsupported, so a
 * page that knows only the iPhone's way records as before); the reply then says `dictationMic: 'app'` (the phone's recognizer opens the microphone itself:
 * the page records nothing and sends no `dictation-push`) and `dictationOnDevice` (true: the phone's on-device
 * recognizer; the app no longer offers any other, and a page treats anything but true as unsupported: the team server);
 * its recordings also send `level` events (0-1) for the page's wave. */
export const DICTATION_CAPABILITY = 'dictation-v1'
/** Optional, versioned: Sign in with Google (docs/decisions/20261122-google-login-apps.md). Google refuses to sign in
 * inside the WebView, so `google-signin` opens Google's authorization address (googleOAuthUrl only) in the phone's auth
 * session (ASWebAuthenticationSession / Custom Tabs, expo-web-browser openAuthSessionAsync), which waits for
 * `<scheme>://google-signin` (googleSignInReturn). The team server sends the session there with `#code=<code>` or
 * `#error=<reason>`; the reply carries `googleCode` or `googleError`, or neither when the person closed it. The page
 * redeems the code itself with the secret it kept, so the session lands in the WebView's own cookies. One at a time.
 * An app without it: the page shows no Google button (store builds before it). */
export const GOOGLE_SIGNIN_CAPABILITY = 'google-signin-v1'
/** The auth session's return address (shared/src/api/auth.ts googlePhoneReturn on the server; a test keeps them equal).
 * Not `open`: the app's link handler (team-link.ts readAppLink) never takes it. */
export const googleSignInReturn = (scheme: string): string => `${scheme}://google-signin`
/** The reasons the team server may send back (server/src/auth/google-login-apps.ts) */
export const GOOGLE_SIGNIN_ERRORS = ['not_connected', 'account_off', 'password_first', 'cancelled', 'expired', 'failed'] as const
export type GoogleSignInError = typeof GOOGLE_SIGNIN_ERRORS[number]
export const googleSignInError = (v: unknown): v is GoogleSignInError => typeof v === 'string' && (GOOGLE_SIGNIN_ERRORS as readonly string[]).includes(v)
/** a one-time code: 32 random bytes in base64url */
export const googleSignInCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)
/** How the auth session ended: the code or the reason from exactly `<scheme>://google-signin#code=…` (or `#error=…`,
 * one key, nothing else); null for any other address (the person closed it, or something else came back). */
export function readGoogleSignInReturn(url: unknown, scheme: string): { code: string } | { error: GoogleSignInError } | null {
  if (typeof url !== 'string' || url.length > 300) return null
  const base = googleSignInReturn(scheme)
  if (!url.startsWith(`${base}#`)) return null
  const m = /^(code|error)=([A-Za-z0-9_-]{1,64})$/.exec(url.slice(base.length + 1))
  if (!m) return null
  if (m[1] === 'code') return googleSignInCode(m[2]) ? { code: m[2]! } : null
  return googleSignInError(m[2]) ? { error: m[2] } : null
}
/** One `dictation-push`: at most 1.5 s of sound (the page sends about 0.1 s at a time). */
export const MAX_DICTATION_BYTES = 48_000
/** The longest text one dictation event carries. */
export const MAX_DICTATION_TEXT = 20_000
/** ready: the phone transcribes the language now; needs-model: once Apple's model for it is here (dictation-install);
 * unsupported: the team server transcribes it. */
export type DictationState = 'ready' | 'needs-model' | 'unsupported'
export type DictationInstall = 'installed' | 'failed' | 'unsupported'
/** What one recording (or a model download, `progress`) on the phone says, by the envelope id that started it. */
export type DictationEventBody =
  | { event: 'text'; final: boolean; text: string }
  | { event: 'done' }
  | { event: 'error'; code: string }
  | { event: 'progress'; percent: number }
  | { event: 'level'; level: number }
export type DictationEvent = Envelope & { type: 'mobile-dictation' } & DictationEventBody
/** The app language as the phone's recognizer takes it: two or three lowercase letters. */
export const dictationLanguage = (v: unknown): v is string => typeof v === 'string' && /^[a-z]{2,3}$/.test(v)
export const dictationState = (v: unknown): v is DictationState => v === 'ready' || v === 'needs-model' || v === 'unsupported'
export const dictationInstall = (v: unknown): v is DictationInstall => v === 'installed' || v === 'failed' || v === 'unsupported'
/** A native event as the page may get it, or null (a bad shape, a text too long). */
export function dictationEventBody(v: unknown): DictationEventBody | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  if (e.event === 'text') return typeof e.final === 'boolean' && typeof e.text === 'string' && e.text.length <= MAX_DICTATION_TEXT ? { event: 'text', final: e.final, text: e.text } : null
  if (e.event === 'done') return { event: 'done' }
  if (e.event === 'error') return { event: 'error', code: typeof e.code === 'string' && /^[a-z_-]{1,40}$/.test(e.code) ? e.code : 'failed' }
  if (e.event === 'level') return typeof e.level === 'number' && Number.isFinite(e.level) ? { event: 'level', level: Math.max(0, Math.min(1, e.level)) } : null
  if (e.event === 'progress') return typeof e.percent === 'number' && Number.isFinite(e.percent) ? { event: 'progress', percent: Math.max(0, Math.min(100, Math.floor(e.percent))) } : null
  return null
}
/** The largest icon number (shared/src/cloud-protocol/push-gateway.ts PUSH_GATEWAY_MAX_BADGE; a test keeps them equal). */
export const MAX_BADGE = 9999
/** The most files one pick returns: a message's attachment limit. The page asks for what its box still takes. */
export const MAX_PICK_FILES = 20
/** The most bytes one pick returns: the page holds them in memory until it has uploaded them. One file stays within
 * MAX_FILE_BYTES (also the room upload limit). */
export const MAX_PICK_BYTES = 200 * 1024 * 1024
/** One `photo-chunk` reply: small enough for injectJavaScript (iOS evaluateJavaScript, Android evaluateJavascript). */
export const PICK_CHUNK_BYTES = 1024 * 1024
/** A picked picture or video as the page learns it: no path, no URL. */
export interface PickedFile { name: string; mime: string; size: number }
/** undetermined: the app may still show the OS prompt (Android 13+ before the question, iOS before an answer). */
export type PushPermission = 'granted' | 'undetermined' | 'denied'
export type PushPlatform = 'ios' | 'android'
/** APNs host the token belongs to: development builds get sandbox tokens; TestFlight and App Store builds production. */
export type PushEnvironment = 'sandbox' | 'production'
export interface PushToken { platform: PushPlatform; token: string; environment: PushEnvironment }
export interface MobileConfig {
  protocol: 1; appVersion: string; platform: 'ios' | 'android'; generation: number; nonce: string;
  capabilities: readonly string[]
  /** the store build number (iOS CFBundleVersion, Android versionCode), shown in Settings › About (QA TC-8071); older
   * apps send none */
  appBuild?: string
}
export interface Envelope { v: 1; generation: number; nonce: string; id: string }
export type FileMessage = Envelope & (
  | { type: 'file-begin'; name: string; mime: string; size: number; sha256: string }
  | { type: 'file-chunk'; seq: number; b64: string }
  | { type: 'file-end'; seq: number }
  | { type: 'file-abort' }
)
export type MobileMessage = FileMessage | (Envelope & (
  // signedOut: the session ended (sign-out, or it expired while the page was open), not a sign-in or a reload; the app
  // then takes the names off the lock screen (delivered notifications) and forgets the label key. Older apps ignore it.
  | { type: 'session-reset'; signedOut?: boolean }
  | { type: 'external-open'; url: string; purpose: 'google-oauth' }
  | { type: 'push-token' }
  // the page registered the token with its team: the app keeps the device id (taps from other teams are ignored) and
  // the removal key (to remove the device from this team when the person switches team)
  | { type: 'push-registered'; deviceId: string; removeKey: string }
  // push-permission-v1: the OS answer so far (never a prompt), and the app's page in the phone's Settings
  | { type: 'push-permission' }
  | { type: 'open-settings' }
  // appearance-v1: the page's look (dark or light) and whether it follows the phone's (its theme is "system")
  | { type: 'appearance'; dark: boolean; system?: boolean }
  // share-text-v1: the phone's share sheet with this text
  | { type: 'share-text'; text: string }
  // nav-v1: Back has somewhere to go in the page (canGoBack), and the page is on its start tab or in no tab (home)
  | { type: 'nav'; canGoBack: boolean; home?: boolean }
  // photo-pick-v1: the phone's photo picker for at most `limit` pictures and videos (the envelope id names the pick);
  // then the picked files' bytes, chunk `seq` (counted over the whole pick) of file `index` at byte `offset`, in order;
  // then done (also when the page gives up), and the app deletes its copies
  | { type: 'photo-pick'; limit: number }
  | { type: 'photo-chunk'; seq: number; index: number; offset: number }
  | { type: 'photo-done' }
  // badge-v1: the app icon's number, 0 clears it
  | { type: 'badge'; count: number }
  // change-team-v1: the app's "다른 팀에 연결" screen over this team
  | { type: 'change-team' }
  // dictation-v1: the language's state on this phone, Apple's model for it, and one recording (the envelope id): its
  // start, its sound in order (never answered), its end or cancel
  // appMic (Android 1.0.10): this page can let the app hold the microphone; a page without it is told unsupported on
  // Android (it would record too, and could not tell a recognizer that is not on the phone)
  | { type: 'dictation-check'; language: string; appMic?: boolean }
  | { type: 'dictation-install'; language: string }
  | { type: 'dictation-start'; language: string }
  | { type: 'dictation-push'; seq: number; b64: string }
  | { type: 'dictation-stop' }
  | { type: 'dictation-cancel' }
  // google-signin-v1: Google's authorization address in the phone's auth session
  | { type: 'google-signin'; url: string }
))
/** googleCode/googleError: a `google-signin` answer (neither: the person closed the auth session). */
/** files/tooBig: a `photo-pick` answer (the picked files, and the names of those left out for their size); b64: a
 * `photo-chunk` answer. */
/** dictation/installed/started: the dictation-check, dictation-install and dictation-start answers; dictationMic and
 * dictationOnDevice: the Android app's check answer (DICTATION_CAPABILITY). */
export interface MobileReply extends Envelope { type: 'mobile-result'; for: MobileMessage['type']; ok: boolean; seq?: number; error?: string; nextGeneration?: number; push?: PushToken; permission?: PushPermission; labelHash?: string; files?: PickedFile[]; tooBig?: string[]; b64?: string; dictation?: DictationState; dictationMic?: 'app'; dictationOnDevice?: boolean; installed?: DictationInstall; started?: boolean; googleCode?: string; googleError?: GoogleSignInError }
export const pushPermission = (v: unknown): v is PushPermission => v === 'granted' || v === 'undetermined' || v === 'denied'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const generation = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 0x7fffffff
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(v)
const nonce = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const deviceId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v)
const seq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_FILE_BYTES
export function sameTeam(origin: string, url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && u.origin === origin } catch { return false }
}
export function googleOAuthUrl(url: string): boolean {
  if (url.length > 8192) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'accounts.google.com' && u.port === '' && !u.username && !u.password
      && u.pathname === '/o/oauth2/v2/auth' && !u.hash
  } catch { return false }
}
export function safeFileName(name: string): string {
  const safe = name.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 120)
  return safe || 'file'
}
export function base64Size(value: unknown): number | null {
  if (typeof value !== 'string' || !value.length || value.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3)
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
}
export function parseMessage(raw: string): MobileMessage | null {
  if (raw.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3) + 2048) return null
  let m: unknown
  try { m = JSON.parse(raw) } catch { return null }
  if (!object(m) || m.v !== MOBILE_PROTOCOL || !generation(m.generation) || !nonce(m.nonce) || !id(m.id)) return null
  switch (m.type) {
    case 'file-begin':
      if (typeof m.name !== 'string' || !m.name || m.name !== safeFileName(m.name) || typeof m.mime !== 'string'
        || m.mime.length > 120 || !/^[\w.+-]+\/[\w.+-]+$/.test(m.mime)
        || typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_FILE_BYTES
        || typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)) return null
      break
    case 'file-chunk': if (!seq(m.seq) || base64Size(m.b64) === null) return null; break
    case 'file-end': if (!seq(m.seq)) return null; break
    case 'file-abort': case 'push-token': case 'push-permission': case 'open-settings': case 'change-team': break
    case 'session-reset': if (m.signedOut !== undefined && typeof m.signedOut !== 'boolean') return null; break
    case 'appearance': if (typeof m.dark !== 'boolean' || (m.system !== undefined && typeof m.system !== 'boolean')) return null; break
    case 'share-text': if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_SHARE_TEXT) return null; break
    case 'nav': if (typeof m.canGoBack !== 'boolean' || (m.home !== undefined && typeof m.home !== 'boolean')) return null; break
    case 'photo-pick': if (typeof m.limit !== 'number' || !Number.isSafeInteger(m.limit) || m.limit < 1 || m.limit > MAX_PICK_FILES) return null; break
    case 'photo-chunk':
      if (!seq(m.seq) || typeof m.index !== 'number' || !Number.isSafeInteger(m.index) || m.index < 0 || m.index >= MAX_PICK_FILES
        || typeof m.offset !== 'number' || !Number.isSafeInteger(m.offset) || m.offset < 0 || m.offset >= MAX_FILE_BYTES || m.offset % PICK_CHUNK_BYTES !== 0) return null
      break
    case 'photo-done': break
    case 'dictation-check': case 'dictation-install': case 'dictation-start':
      if (!dictationLanguage(m.language) || (m.type === 'dictation-check' && m.appMic !== undefined && typeof m.appMic !== 'boolean')) return null
      break
    case 'dictation-push': {
      const n = base64Size(m.b64)
      if (!seq(m.seq) || n === null || n > MAX_DICTATION_BYTES || n % 2 !== 0) return null
      break
    }
    case 'dictation-stop': case 'dictation-cancel': break
    case 'badge': if (typeof m.count !== 'number' || !Number.isInteger(m.count) || m.count < 0 || m.count > MAX_BADGE) return null; break
    case 'push-registered': if (!deviceId(m.deviceId) || typeof m.removeKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.removeKey)) return null; break
    case 'external-open': if (m.purpose !== 'google-oauth' || typeof m.url !== 'string' || !googleOAuthUrl(m.url)) return null; break
    case 'google-signin': if (typeof m.url !== 'string' || !googleOAuthUrl(m.url)) return null; break
    default: return null
  }
  return m as unknown as MobileMessage
}
/** A picked file's type: a picture or a video; never SVG (a script can ride in it; the photo pickers never give one). */
export const pickedMime = (v: unknown): v is string => typeof v === 'string' && v.length <= 120 && /^(?:image|video)\/[\w.+-]+$/.test(v) && !/svg/i.test(v)
/** A `photo-pick` answer: at most `limit` files, each a safe name, a picture or video type and 1 byte to MAX_FILE_BYTES,
 * together at most MAX_PICK_BYTES; and the names left out for their size. Checked on both sides. */
export function validPicks(files: unknown, tooBig: unknown, limit: number): files is PickedFile[] {
  if (!Array.isArray(files) || files.length > Math.min(limit, MAX_PICK_FILES) || !Array.isArray(tooBig) || tooBig.length > MAX_PICK_FILES) return false
  let total = 0
  for (const f of files) {
    if (!object(f) || typeof f.name !== 'string' || !f.name || f.name !== safeFileName(f.name) || !pickedMime(f.mime)
      || typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 1 || f.size > MAX_FILE_BYTES) return false
    total += f.size
  }
  return total <= MAX_PICK_BYTES && tooBig.every(n => typeof n === 'string' && !!n && n === safeFileName(n))
}
/** How many bytes the `photo-chunk` at `offset` of a file of `size` bytes carries. */
export const pickChunkLength = (size: number, offset: number): number => Math.max(0, Math.min(PICK_CHUNK_BYTES, size - offset))
/** APNs device tokens are hex (32 bytes today; Apple says the length may grow); FCM registration tokens are opaque. */
export function validPushToken(v: unknown): v is PushToken {
  if (!object(v) || (v.environment !== 'sandbox' && v.environment !== 'production') || typeof v.token !== 'string') return false
  if (v.platform === 'ios') return /^[0-9a-f]{64,200}$/.test(v.token)
  return v.platform === 'android' && v.environment === 'production' && /^[A-Za-z0-9_:.-]{32,3000}$/.test(v.token)
}
/** A notification may only name a path on the chosen team: ids only, no scheme, host, '//', '..', query or fragment.
 * The same rule is in shared/src/cloud-protocol/push-gateway.ts (validPushPath); a test keeps them equal. */
export function notificationPath(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 200 && /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(v) ? v : null
}
/** The path a tapped notification opens, or null. date: iOS reports seconds, Android milliseconds. A notification
 * delivered before the current team was chosen (teamSince, ms) opens nothing, and neither does one whose `device` (the
 * team's device id) is not the device this app registered with the current team: it belongs to another team. */
export function tappedNotificationPath(data: unknown, date: unknown, teamSince: number, device?: string | null): string | null {
  if (typeof date !== 'number' || !Number.isFinite(date) || (date < 1e11 ? date * 1000 : date) < teamSince || !object(data)) return null
  // `device`, not `tag`: expo-notifications on Android uses data.tag as the notification's identifier
  if (device && typeof data.device === 'string' && data.device !== device) return null
  return notificationPath(data.path)
}
export function validConfig(v: unknown): v is MobileConfig {
  return object(v) && v.protocol === MOBILE_PROTOCOL && (v.platform === 'ios' || v.platform === 'android')
    && typeof v.appVersion === 'string' && v.appVersion.length <= 40 && generation(v.generation) && nonce(v.nonce)
    && (v.appBuild === undefined || (typeof v.appBuild === 'string' && /^[0-9A-Za-z.]{1,20}$/.test(v.appBuild)))
    && Array.isArray(v.capabilities) && MOBILE_CAPABILITIES.every(c => (v.capabilities as unknown[]).includes(c))
}

/** All schemes reach this decision (WebView's originWhitelist must be ['*'], or its own fallback opens arbitrary schemes). */
export function navigationDecision(origin: string, url: string, isTopFrame?: boolean): 'internal' | 'external' | 'deny' {
  if (sameTeam(origin, url)) return 'internal'
  try {
    const u = new URL(url)
    // Blob previews are allowed only for a known child frame of this origin; they receive no bridge capability.
    if (isTopFrame === false && u.protocol === 'blob:' && u.origin === origin) return 'internal'
    if (isTopFrame !== false && u.protocol === 'https:' && !u.username && !u.password) return 'external'
  } catch {}
  return 'deny'
}
