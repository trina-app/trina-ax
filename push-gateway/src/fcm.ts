// FCM HTTP v1 (firebase.google.com/docs/cloud-messaging/send/v1-api) with a service account: an RS256 JWT assertion
// is exchanged for an OAuth access token at the account's token_uri, cached until 60 s before it expires.
//
// `data` is flat strings { notificationId, code, path?, device? } and never has a key named "body" (expo-notifications on
// Android would read a JSON "body" as its own format) or "tag" (expo-notifications 58 uses data["tag"] as the
// notification's identifier, so a per-device tag would make every push replace the previous one). The request's `tag`
// (the team's device id) therefore travels as `device`. `badge` is not sent: Android launchers count the notifications in
// the tray and add up their `notification_count`, so the total on every push would show 1+2+3 = 6 for three pushes.
// Each notification counts as one there; the open app sets its own number (badge-v1).
import type { PushGatewaySend } from '../../shared/src/cloud-protocol/push-gateway.ts'
import { importRs256, signJwt, type FetchLike } from './crypto.ts'

export type SendOutcome = 'sent' | 'token_invalid' | 'provider_error'

/** The provider refused the gateway's own credentials (a fixed reason code, never provider text). bun.ts sends it to
 *  Sentry when PUSH_GATEWAY_SENTRY_DSN is set; a dead device token never calls it. */
export type CredentialAlarm = (provider: 'apns' | 'fcm', reason: string) => void

/**
 * FCM error codes (firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode, google.rpc status) that mean our service
 * account or project was refused, for every device alike. UNREGISTERED, INVALID_ARGUMENT (a bad token) and
 * SENDER_ID_MISMATCH (a token from another app) are about one device and are not here.
 */
export const FCM_CREDENTIAL_CODES = new Set(['UNAUTHENTICATED', 'PERMISSION_DENIED', 'THIRD_PARTY_AUTH_ERROR'])

/** What the app reads from a notification (APNs: the payload's `body` object; FCM: `data`). Only these keys. */
export function appData(msg: PushGatewaySend): Record<string, string> {
  const data: Record<string, string> = { notificationId: msg.notificationId, code: msg.code }
  if (msg.path !== undefined) data.path = msg.path
  if (msg.tag !== undefined) data.device = msg.tag
  return data
}

export interface FcmConfig { projectId: string; clientEmail: string; privateKeyPem: string; tokenUri: string }

export const FCM_ORIGIN = 'https://fcm.googleapis.com'
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/**
 * One send (the OAuth token call when needed, then the send call) ends after this long, answer read included. A team
 * server tries a failed push again 30 s or more later (server/src/notifications/push-service.ts), so the first send has
 * ended, and its dedupe entry is released or kept, before any retry comes. Without a limit the first send could still
 * be in flight then: the retry got 200 (duplicate), and nothing was sent when the first send failed (QA TC-387). It is
 * also less than the team server's usual 10 s wait, so that server usually gets the gateway's 502.
 */
export const FCM_TIMEOUT_MS = 8_000

/** The service-account JSON (secret FCM_SERVICE_ACCOUNT), or null when a field is missing or odd. */
export function parseServiceAccount(json: string | undefined): FcmConfig | null {
  if (!json) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  const { project_id: projectId, client_email: clientEmail, private_key: privateKeyPem, token_uri: tokenUri } = o ?? {}
  if (typeof projectId !== 'string' || !/^[a-z0-9-]{1,100}$/.test(projectId)) return null
  if (typeof clientEmail !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(clientEmail)) return null
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY')) return null
  if (typeof tokenUri !== 'string' || !tokenUri.startsWith('https://')) return null
  return { projectId, clientEmail, privateKeyPem, tokenUri }
}

export interface FcmDeps {
  fetch: FetchLike
  now(): number
  origin?: string
  /** tests: default FCM_TIMEOUT_MS */
  timeoutMs?: number
  /** Google refused OUR service account (not a device token): the operators must act */
  alarm?: CredentialAlarm
}

interface FcmError { error?: { status?: unknown; message?: unknown; details?: { errorCode?: unknown }[] } }

export function createFcm(cfg: FcmConfig, deps: FcmDeps) {
  let key: Promise<CryptoKey | null> | null = null
  let cached: { token: string; until: number } | null = null

  async function accessToken(signal: AbortSignal): Promise<string | null> {
    const now = deps.now()
    if (cached && now < cached.until) return cached.token
    key ??= importRs256(cfg.privateKeyPem)
    const k = await key
    if (!k) {
      deps.alarm?.('fcm', 'key_unreadable')
      return null
    }
    const iat = Math.floor(now / 1000)
    const assertion = await signJwt(k, { alg: 'RS256', typ: 'JWT' }, { iss: cfg.clientEmail, scope: FCM_SCOPE, aud: cfg.tokenUri, iat, exp: iat + 3600 })
    const res = await deps.fetch(cfg.tokenUri, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    })
    if (res.status !== 200) {
      await res.body?.cancel()
      // 400 invalid_grant (a deleted or disabled key), 401 invalid_client: the service account is refused. A 5xx is
      // Google's trouble and passes.
      if (res.status >= 400 && res.status < 500) deps.alarm?.('fcm', `oauth_${res.status}`)
      return null
    }
    const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    if (!j || typeof j.access_token !== 'string' || typeof j.expires_in !== 'number') return null
    cached = { token: j.access_token, until: now + j.expires_in * 1000 - 60_000 }
    return j.access_token
  }

  return {
    async send(msg: PushGatewaySend, alert: { title: string; body: string }): Promise<SendOutcome> {
      const signal = AbortSignal.timeout(deps.timeoutMs ?? FCM_TIMEOUT_MS)
      try {
        const token = await accessToken(signal)
        if (!token) return 'provider_error'
        const res = await deps.fetch(`${deps.origin ?? FCM_ORIGIN}/v1/projects/${cfg.projectId}/messages:send`, {
          method: 'POST',
          signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: msg.token,
              notification: alert,
              data: appData(msg),
              android: {
                priority: 'HIGH',
                ttl: `${msg.ttlSeconds ?? 0}s`,
                collapse_key: msg.notificationId,
                notification: { channel_id: 'default', tag: msg.notificationId },
              },
            },
          }),
        })
        if (res.status === 200) {
          await res.body?.cancel()
          return 'sent'
        }
        if (res.status === 401) cached = null
        const e = ((await res.json().catch(() => null)) as FcmError | null)?.error
        const codes = (Array.isArray(e?.details) ? e.details : []).map((d) => d?.errorCode)
        if (codes.includes('UNREGISTERED')) return 'token_invalid'
        // SENDER_ID_MISMATCH comes with status PERMISSION_DENIED but is about the token (it belongs to another app)
        const refused = codes.includes('SENDER_ID_MISMATCH') ? undefined : [...codes, e?.status].find((c): c is string => typeof c === 'string' && FCM_CREDENTIAL_CODES.has(c))
        if (refused) deps.alarm?.('fcm', refused)
        else if (!codes.includes('SENDER_ID_MISMATCH') && (res.status === 401 || res.status === 403)) deps.alarm?.('fcm', `http_${res.status}`)
        const invalidArgument = e?.status === 'INVALID_ARGUMENT' || codes.includes('INVALID_ARGUMENT')
        if (invalidArgument && typeof e?.message === 'string' && /registration token/i.test(e.message)) return 'token_invalid'
        return 'provider_error'
      } catch {
        return 'provider_error'
      }
    },
  }
}
