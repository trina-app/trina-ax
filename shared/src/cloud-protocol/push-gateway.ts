// Push gateway API (`push-gateway/`): team servers ask the gateway to deliver a native push to the phone app, so no
// team server ever holds the Apple (APNs) or Google (FCM) keys. MIT (see LICENSE in this folder).
//
// NO imports at all, erasable TypeScript only: the gateway (Bun), the team server and Node (type stripping) load this
// file as it is. The caller computes sha256 itself (node:crypto on the team server, WebCrypto in the gateway).
//
// Request:  POST /v1/send, body = JSON PushGatewaySend (at most PUSH_GATEWAY_MAX_BODY_BYTES bytes, strict: unknown keys
//           are refused), header
//           Authorization: MycelPush key=<base64 SPKI Ed25519 public key>, ts=<unix ms>, sig=<base64 Ed25519 signature>
//           sig = Ed25519 over pushGatewaySigningString(ts, sha256 hex of the exact body bytes), UTF-8.
// Identity: the team is its public key (key id = sha256 hex of the SPKI DER). Trust on first use: an unknown key is
//           accepted and recorded with its first-seen time (forgotten after 24 h if nothing was ever delivered for it);
//           an operator can block a key (403).
// Replay:   ts within ±PUSH_GATEWAY_MAX_SKEW_MS of the gateway clock; the same (key, token, notificationId) within
//           PUSH_GATEWAY_DEDUPE_MS is answered 200 without sending again, so a replayed request sends nothing.
// Content:  the notification never carries message content (App Review 4.5.4): the gateway picks a generic text from
//           `code` and `locale` itself. `path` is where the app opens, made only of ids.
// Data:     the app reads { notificationId, code, path?, tag? }: on iOS from the APNs payload's top-level `body` object
//           (expo-notifications reads remote data from userInfo["body"]), on Android from FCM `data` (flat strings,
//           never a key named "body").

export const PUSH_GATEWAY_SEND_PATH = '/v1/send'
export const PUSH_GATEWAY_HEALTH_PATH = '/health'
export const PUSH_GATEWAY_MAX_BODY_BYTES = 4096
export const PUSH_GATEWAY_MAX_SKEW_MS = 300_000
/** the same (key, token, notificationId) within this window is sent once */
export const PUSH_GATEWAY_DEDUPE_MS = 10 * 60_000
export const PUSH_GATEWAY_MAX_TTL_SECONDS = 86_400

export const PUSH_PLATFORMS = ['ios', 'android'] as const
export type PushPlatform = (typeof PUSH_PLATFORMS)[number]
/** APNs environment of the app build that made the token; android is always 'production' */
export const PUSH_ENVIRONMENTS = ['sandbox', 'production'] as const
export type PushEnvironment = (typeof PUSH_ENVIRONMENTS)[number]
export const PUSH_LOCALES = ['ko', 'en', 'id', 'ja', 'es'] as const
export type PushLocale = (typeof PUSH_LOCALES)[number]

export interface PushGatewaySend {
  v: 1
  platform: PushPlatform
  environment: PushEnvironment
  /** ios: APNs device token (hex); android: FCM registration token */
  token: string
  /** the team server's id for this notification: dedupe key, APNs collapse id, FCM collapse_key and Android notification tag */
  notificationId: string
  /** what happened, e.g. 'schedule.success', 'room.message': picks the generic text */
  code: string
  locale: PushLocale
  /** where the app opens, a same-origin path made only of ids, e.g. '/rooms/abc123' */
  path?: string
  /** how long the provider may keep the notification for an offline phone; absent = deliver now or never (0) */
  ttlSeconds?: number
  /** the team server's id of the device row: the app ignores a tap whose tag is not the id it registered (a previous
   * team's notification) */
  tag?: string
}

/** Error codes and their HTTP status. Every answer is JSON: { ok: true } (200) or { ok: false, error: <code> }. */
export const PUSH_GATEWAY_ERRORS = {
  /** not POST /v1/send or GET /health */
  not_found: 404,
  /** body is not valid UTF-8 JSON or does not match PushGatewaySend */
  invalid_body: 400,
  /** Authorization header missing or malformed, or the signature does not verify */
  unauthorized: 401,
  /** ts is more than PUSH_GATEWAY_MAX_SKEW_MS away from the gateway clock: check the team server's clock */
  clock_skew: 401,
  /** the operator blocked this team key */
  key_blocked: 403,
  /** the provider says the token is no longer valid: the team server deletes the device */
  token_invalid: 410,
  /** body larger than PUSH_GATEWAY_MAX_BODY_BYTES */
  body_too_large: 413,
  /** per client address, per key, or per (key, token) limit; the answer has Retry-After (seconds) */
  rate_limited: 429,
  /** the provider failed (5xx, 429, network, an answer the gateway does not expect): try again later */
  provider_error: 502,
  /** the gateway has no credentials for this platform */
  not_configured: 503,
  /** the gateway does not send to this APNs environment (sandbox, unless the operator turned it on) */
  unsupported_environment: 503,
  /** the gateway itself failed (its state store): try again later */
  internal: 500,
} as const
export type PushGatewayErrorCode = keyof typeof PUSH_GATEWAY_ERRORS
export type PushGatewayResponse = { ok: true } | { ok: false; error: PushGatewayErrorCode }

const IOS_TOKEN_RE = /^[0-9a-f]{64,200}$/
const ANDROID_TOKEN_RE = /^[A-Za-z0-9_:.-]{32,3000}$/
const NOTIFICATION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const CODE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/
const CODE_MAX = 64
const PATH_RE = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/
const PATH_MAX = 200
const SEND_KEYS = ['v', 'platform', 'environment', 'token', 'notificationId', 'code', 'locale', 'path', 'ttlSeconds', 'tag']

export function validPushToken(platform: PushPlatform, token: unknown): boolean {
  if (typeof token !== 'string') return false
  if (platform === 'ios') return IOS_TOKEN_RE.test(token)
  if (platform === 'android') return ANDROID_TOKEN_RE.test(token)
  return false
}

export function validPushPath(path: unknown): boolean {
  return typeof path === 'string' && path.length <= PATH_MAX && PATH_RE.test(path)
}

export function validPushCode(code: unknown): boolean {
  return typeof code === 'string' && code.length <= CODE_MAX && CODE_RE.test(code)
}

/** The request body, or null when it is not exactly a PushGatewaySend (an unknown key, a wrong type, a bad value). */
export function parsePushGatewaySend(raw: unknown): PushGatewaySend | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (!SEND_KEYS.includes(k)) return null
  if (o.v !== 1) return null
  if (!(PUSH_PLATFORMS as readonly unknown[]).includes(o.platform)) return null
  const platform = o.platform as PushPlatform
  if (!(PUSH_ENVIRONMENTS as readonly unknown[]).includes(o.environment)) return null
  const environment = o.environment as PushEnvironment
  if (platform === 'android' && environment !== 'production') return null
  if (!validPushToken(platform, o.token)) return null
  if (typeof o.notificationId !== 'string' || !NOTIFICATION_ID_RE.test(o.notificationId)) return null
  if (!validPushCode(o.code)) return null
  if (!(PUSH_LOCALES as readonly unknown[]).includes(o.locale)) return null
  const out: PushGatewaySend = {
    v: 1, platform, environment, token: o.token as string, notificationId: o.notificationId, code: o.code as string,
    locale: o.locale as PushLocale,
  }
  if ('path' in o) {
    if (!validPushPath(o.path)) return null
    out.path = o.path as string
  }
  if ('ttlSeconds' in o) {
    const t = o.ttlSeconds
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > PUSH_GATEWAY_MAX_TTL_SECONDS) return null
    out.ttlSeconds = t
  }
  if ('tag' in o) {
    if (typeof o.tag !== 'string' || !NOTIFICATION_ID_RE.test(o.tag)) return null
    out.tag = o.tag
  }
  return out
}

/** The UTF-8 string the team key signs. bodySha256Hex: lower-case hex sha256 of the exact request body bytes. */
export function pushGatewaySigningString(ts: number, bodySha256Hex: string): string {
  return `mycel-push-v1\nPOST\n${PUSH_GATEWAY_SEND_PATH}\n${ts}\n${bodySha256Hex}`
}

/** key: base64 SPKI DER of the Ed25519 public key (the relay's team key format); ts: unix ms; sig: base64. */
export function pushGatewayAuthorization(key: string, ts: number, sig: string): string {
  return `MycelPush key=${key}, ts=${ts}, sig=${sig}`
}

const AUTH_RE = /^MycelPush key=([A-Za-z0-9+/]{1,200}={0,2}), ts=(\d{1,16}), sig=([A-Za-z0-9+/]{1,200}={0,2})$/

export function parsePushGatewayAuthorization(header: string | null | undefined): { key: string; ts: number; sig: string } | null {
  if (typeof header !== 'string' || header.length > 512) return null
  const m = AUTH_RE.exec(header.trim())
  if (!m) return null
  const ts = Number(m[2])
  return Number.isSafeInteger(ts) ? { key: m[1]!, ts, sig: m[3]! } : null
}
