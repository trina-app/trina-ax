// FCM HTTP v1 (firebase.google.com/docs/cloud-messaging/send/v1-api) with a service account: an RS256 JWT assertion
// is exchanged for an OAuth access token at the account's token_uri, cached until 60 s before it expires.
//
// `data` is flat strings { notificationId, code, path?, tag? } and never has a key named "body" (expo-notifications on
// Android would read a JSON "body" as its own format).
import type { PushGatewaySend } from '../../shared/src/cloud-protocol/push-gateway.ts'
import { importRs256, signJwt, type FetchLike } from './crypto.ts'

export type SendOutcome = 'sent' | 'token_invalid' | 'provider_error'

/** What the app reads from a notification (APNs: the payload's `body` object; FCM: `data`). Only these keys. */
export function appData(msg: PushGatewaySend): Record<string, string> {
  const data: Record<string, string> = { notificationId: msg.notificationId, code: msg.code }
  if (msg.path !== undefined) data.path = msg.path
  if (msg.tag !== undefined) data.tag = msg.tag
  return data
}

export interface FcmConfig { projectId: string; clientEmail: string; privateKeyPem: string; tokenUri: string }

export const FCM_ORIGIN = 'https://fcm.googleapis.com'
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

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

export interface FcmDeps { fetch: FetchLike; now(): number; origin?: string }

interface FcmError { error?: { status?: unknown; message?: unknown; details?: { errorCode?: unknown }[] } }

export function createFcm(cfg: FcmConfig, deps: FcmDeps) {
  let key: Promise<CryptoKey | null> | null = null
  let cached: { token: string; until: number } | null = null

  async function accessToken(): Promise<string | null> {
    const now = deps.now()
    if (cached && now < cached.until) return cached.token
    key ??= importRs256(cfg.privateKeyPem)
    const k = await key
    if (!k) return null
    const iat = Math.floor(now / 1000)
    const assertion = await signJwt(k, { alg: 'RS256', typ: 'JWT' }, { iss: cfg.clientEmail, scope: FCM_SCOPE, aud: cfg.tokenUri, iat, exp: iat + 3600 })
    const res = await deps.fetch(cfg.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    })
    if (res.status !== 200) {
      await res.body?.cancel()
      return null
    }
    const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    if (!j || typeof j.access_token !== 'string' || typeof j.expires_in !== 'number') return null
    cached = { token: j.access_token, until: now + j.expires_in * 1000 - 60_000 }
    return j.access_token
  }

  return {
    async send(msg: PushGatewaySend, alert: { title: string; body: string }): Promise<SendOutcome> {
      try {
        const token = await accessToken()
        if (!token) return 'provider_error'
        const res = await deps.fetch(`${deps.origin ?? FCM_ORIGIN}/v1/projects/${cfg.projectId}/messages:send`, {
          method: 'POST',
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
        const invalidArgument = e?.status === 'INVALID_ARGUMENT' || codes.includes('INVALID_ARGUMENT')
        if (invalidArgument && typeof e?.message === 'string' && /registration token/i.test(e.message)) return 'token_invalid'
        return 'provider_error'
      } catch {
        return 'provider_error'
      }
    },
  }
}
