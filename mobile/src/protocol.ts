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
export type PushPlatform = 'ios' | 'android'
/** APNs host the token belongs to: development builds get sandbox tokens; TestFlight and App Store builds production. */
export type PushEnvironment = 'sandbox' | 'production'
export interface PushToken { platform: PushPlatform; token: string; environment: PushEnvironment }
export interface MobileConfig {
  protocol: 1; appVersion: string; platform: 'ios' | 'android'; generation: number; nonce: string;
  capabilities: readonly string[]
}
export interface Envelope { v: 1; generation: number; nonce: string; id: string }
export type FileMessage = Envelope & (
  | { type: 'file-begin'; name: string; mime: string; size: number; sha256: string }
  | { type: 'file-chunk'; seq: number; b64: string }
  | { type: 'file-end'; seq: number }
  | { type: 'file-abort' }
)
export type MobileMessage = FileMessage | (Envelope & (
  | { type: 'session-reset' }
  | { type: 'external-open'; url: string; purpose: 'google-oauth' }
  | { type: 'push-token' }
  // the page registered the token with its team: the app keeps the device id (taps from other teams are ignored) and
  // the removal key (to remove the device from this team when the person switches team)
  | { type: 'push-registered'; deviceId: string; removeKey: string }
))
export interface MobileReply extends Envelope { type: 'mobile-result'; for: MobileMessage['type']; ok: boolean; seq?: number; error?: string; nextGeneration?: number; push?: PushToken }
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
    case 'file-abort': case 'session-reset': case 'push-token': break
    case 'push-registered': if (!deviceId(m.deviceId) || typeof m.removeKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.removeKey)) return null; break
    case 'external-open': if (m.purpose !== 'google-oauth' || typeof m.url !== 'string' || !googleOAuthUrl(m.url)) return null; break
    default: return null
  }
  return m as unknown as MobileMessage
}
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
