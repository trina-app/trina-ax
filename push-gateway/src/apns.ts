// APNs with token auth (developer.apple.com "Sending notification requests to APNs"). APNs speaks only HTTP/2: the
// `fetch` given here must do HTTP/2 to api.push.apple.com (Bun entry: node:http2; see README.md for the Worker).
import type { PushGatewaySend } from '../../shared/src/cloud-protocol/push-gateway.ts'
import { importEs256, sha256Hex, signJwt, type FetchLike } from './crypto.ts'
import type { SendOutcome } from './fcm.ts'

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
export const APNS_JWT_SLOT_S = 20 * 60
export const APNS_JWT_MAX_AGE_S = 50 * 60

export interface ApnsDeps {
  fetch: FetchLike
  now(): number
  production?: string
  sandbox?: string
}

/** APNs apns-collapse-id is at most 64 bytes; a longer notification id collapses by its hash. */
async function collapseId(notificationId: string): Promise<string> {
  return notificationId.length <= 64 ? notificationId : await sha256Hex(notificationId)
}

export function createApns(cfg: ApnsConfig, deps: ApnsDeps) {
  let key: Promise<CryptoKey | null> | null = null
  let cached: { jwt: string; iat: number } | null = null

  /**
   * The provider token, reused for at most 50 minutes. Normally iat is the start of the current 20-minute slot, so
   * every Worker isolate holds a token with the same iat and APNs does not see many token updates
   * (TooManyProviderTokenUpdates); `fresh` (after ExpiredProviderToken) signs one with iat = now.
   */
  async function providerToken(fresh: boolean): Promise<string | null> {
    const nowS = Math.floor(deps.now() / 1000)
    if (!fresh && cached && nowS - cached.iat < APNS_JWT_MAX_AGE_S) return cached.jwt
    key ??= importEs256(cfg.privateKeyPem)
    const k = await key
    if (!k) return null
    const iat = fresh ? nowS : nowS - (nowS % APNS_JWT_SLOT_S)
    const jwt = await signJwt(k, { alg: 'ES256', kid: cfg.keyId }, { iss: cfg.teamId, iat })
    cached = { jwt, iat }
    return jwt
  }

  async function post(msg: PushGatewaySend, alert: { title: string; body: string }, jwt: string): Promise<{ status: number; reason: string | null }> {
    const origin = msg.environment === 'sandbox' ? deps.sandbox ?? APNS_SANDBOX : deps.production ?? APNS_PRODUCTION
    const body: Record<string, unknown> = { aps: { alert, sound: 'default' }, notificationId: msg.notificationId, code: msg.code }
    if (msg.path !== undefined) body.path = msg.path
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
