// Versioned, platform-independent contract shared by the app and web adapter. No native imports here.
export const MOBILE_PROTOCOL = 1
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_CHUNK_BYTES = 3 * 1024 * 1024
export const TRANSFER_IDLE_MS = 60_000
export const MOBILE_CAPABILITIES = ['file-share-v1', 'external-oauth-v1'] as const
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
))
export interface MobileReply extends Envelope { type: 'mobile-result'; for: MobileMessage['type']; ok: boolean; seq?: number; error?: string; nextGeneration?: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const generation = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 0x7fffffff
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(v)
const nonce = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
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
    case 'file-abort': case 'session-reset': break
    case 'external-open': if (m.purpose !== 'google-oauth' || typeof m.url !== 'string' || !googleOAuthUrl(m.url)) return null; break
    default: return null
  }
  return m as unknown as MobileMessage
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
