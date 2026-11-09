// APNs with token auth (developer.apple.com "Sending notification requests to APNs"). APNs speaks only HTTP/2: the
// `fetch` given here must do HTTP/2 to api.push.apple.com (bun.ts: node:http2).
//
// Payload: { aps: { alert, sound, mutable-content? }, body: { notificationId, code, path?, device? } } and nothing else
// (device = the request's tag, see fcm.ts appData). expo-notifications reads a remote notification's data on iOS from
// userInfo["body"]. A room notice (code room.*) is mutable: the phone app's notification service extension may replace
// the title with who and where, which it asks the team server for itself (docs/DECISIONS.md "아이폰 알림의 이름"). The
// generic alert stays as it is: an app without the extension (1.0.0), or an extension that gets no answer, shows it.
import type { PushGatewaySend } from '../../shared/src/cloud-protocol/push-gateway.ts'
import { importEs256, sha256Hex, signJwt, type FetchLike } from './crypto.ts'
import { appData, type SendOutcome } from './fcm.ts'

export interface ApnsConfig {
  keyId: string
  teamId: string
  topic: string
  privateKeyPem: string
  /** the operator turned sandbox (development builds) on: APNS_SANDBOX=on */
  sandbox: boolean
}

export const APNS_PRODUCTION = 'https://api.push.apple.com'
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com'
/** Apple: refresh the provider token at most every 20 and at least every 60 minutes */
export const APNS_JWT_MAX_AGE_S = 50 * 60

export interface ApnsDeps {
  fetch: FetchLike
  now(): number
  production?: string
  sandbox?: string
}

/** Room notices (room.dm, room.mention, …): the app's extension may put who and where in the title. Nothing else. */
export const mutableCode = (code: string) => code.startsWith('room.')

/** APNs apns-collapse-id is at most 64 bytes; a longer notification id collapses by its hash. */
async function collapseId(notificationId: string): Promise<string> {
  return notificationId.length <= 64 ? notificationId : await sha256Hex(notificationId)
}

export function createApns(cfg: ApnsConfig, deps: ApnsDeps) {
  let key: Promise<CryptoKey | null> | null = null
  let cached: { jwt: string; iat: number } | null = null

  /** The provider token, reused for at most 50 minutes; `fresh` (after ExpiredProviderToken) signs a new one. */
  async function providerToken(fresh: boolean): Promise<string | null> {
    const nowS = Math.floor(deps.now() / 1000)
    if (!fresh && cached && nowS - cached.iat < APNS_JWT_MAX_AGE_S) return cached.jwt
    key ??= importEs256(cfg.privateKeyPem)
    const k = await key
    if (!k) return null
    const jwt = await signJwt(k, { alg: 'ES256', kid: cfg.keyId }, { iss: cfg.teamId, iat: nowS })
    cached = { jwt, iat: nowS }
    return jwt
  }

  async function post(msg: PushGatewaySend, alert: { title: string; body: string }, jwt: string): Promise<{ status: number; reason: string | null }> {
    const origin = msg.environment === 'sandbox' ? deps.sandbox ?? APNS_SANDBOX : deps.production ?? APNS_PRODUCTION
    const body = { aps: { alert, sound: 'default', ...(mutableCode(msg.code) ? { 'mutable-content': 1 } : {}) }, body: appData(msg) }
    const nowS = Math.floor(deps.now() / 1000)
    const res = await deps.fetch(`${origin}/3/device/${msg.token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': cfg.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(msg.ttlSeconds ? nowS + msg.ttlSeconds : 0),
        'apns-collapse-id': await collapseId(msg.notificationId),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    let reason: string | null = null
    if (res.status !== 200) {
      try {
        const j = (await res.json()) as { reason?: unknown }
        reason = typeof j.reason === 'string' ? j.reason : null
      } catch { /* no JSON: the status decides */ }
    } else {
      await res.body?.cancel()
    }
    return { status: res.status, reason }
  }

  return {
    async send(msg: PushGatewaySend, alert: { title: string; body: string }): Promise<SendOutcome> {
      try {
        let jwt = await providerToken(false)
        if (!jwt) return 'provider_error'
        let r = await post(msg, alert, jwt)
        if (r.status === 403 && r.reason === 'ExpiredProviderToken') {
          jwt = await providerToken(true)
          if (!jwt) return 'provider_error'
          r = await post(msg, alert, jwt)
        }
        if (r.status === 200) return 'sent'
        if (r.status === 410 || r.reason === 'Unregistered' || r.reason === 'BadDeviceToken') return 'token_invalid'
        if (r.status === 403 && (r.reason === 'ExpiredProviderToken' || r.reason === 'InvalidProviderToken')) cached = null
        return 'provider_error'
      } catch {
        return 'provider_error'
      }
    },
  }
}
