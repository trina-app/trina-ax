// Native app push (iOS/Android) through the push gateway (push-gateway/, contract in
// shared/src/cloud-protocol/push-gateway.ts). The team server never holds Apple or Google keys: it signs a small
// request with its team key and the gateway talks to APNs/FCM. The request carries ids, an event code and a locale,
// never text; the gateway picks generic words.
import crypto, { type KeyObject } from 'node:crypto'
import dns from 'node:dns/promises'
import https from 'node:https'
import {
  PUSH_GATEWAY_SEND_PATH, PUSH_GATEWAY_MAX_TTL_SECONDS, pushGatewayAuthorization, pushGatewaySigningString, validPushPath,
  validPushToken, type PushEnvironment, type PushGatewaySend, type PushLocale, type PushPlatform,
} from '@mycel/shared/cloud-protocol'
import type { PushEventType } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { HttpError } from '../http/errors'
import { loadOrCreateKey } from '../relay-client/registration'
import { postPinned, type PushLookup } from './push-transport'

/** The gateway address (AppConfig push.gatewayUrl: the edition's default, MYCEL_PUSH_GATEWAY, server.json; unset = off). */
export interface NativePushConfig { url: string }
export interface NativeDevice { platform: PushPlatform; token: string; environment: PushEnvironment }
export interface NativePayload { notificationId: string; code: PushEventType; locale: PushLocale; tag?: string; path?: string }
export interface NativeSend { device: NativeDevice; payload: NativePayload; config: NativePushConfig; signal: AbortSignal; beforeSend: () => boolean; ttlSeconds: number }
export type NativeTransport = (input: NativeSend) => Promise<{ statusCode: number }>

/** https://host[:443] only: no credentials, path, query or fragment (the send path is fixed by the contract). */
export function validGatewayUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '') || !u.hostname.includes('.')) return null
    return u.origin
  } catch { return null }
}
export function readNativePushConfig(ctx: AppContext): NativePushConfig | null {
  const url = validGatewayUrl(ctx.config.push?.gatewayUrl)
  return url ? { url } : null
}
/** Device rows are bound to the gateway address: a changed address leaves old rows unused, like a new VAPID key. */
export const nativeConfigKey = (c: NativePushConfig) => 'native:' + crypto.createHash('sha256').update('push-gateway|' + c.url).digest('hex')

export function validNativeDevice(v: { platform: string; token: string; environment: string }): NativeDevice {
  const platform = v.platform === 'ios' || v.platform === 'android' ? v.platform : null
  const environment = v.environment === 'sandbox' || v.environment === 'production' ? v.environment : null
  if (!platform || !environment || !validPushToken(platform, v.token) || (platform === 'android' && environment !== 'production')) throw new HttpError('validation')
  return { platform, token: v.token, environment }
}

/** The signed request exactly as sent (exported for tests and the gateway's own tests). */
export function signedGatewayRequest(send: PushGatewaySend, key: KeyObject, publicKey: string, now = Date.now()): { body: string; authorization: string } {
  const body = JSON.stringify(send)
  const sig = crypto.sign(null, Buffer.from(pushGatewaySigningString(now, crypto.createHash('sha256').update(body).digest('hex')), 'utf8'), key).toString('base64')
  return { body, authorization: pushGatewayAuthorization(publicKey, now, sig) }
}

/** The team key (Ed25519): the relay's <data>/relay/team-key.pem, created on first use exactly like the relay does. */
function teamKey(dataDir: string) { const { key, publicKey } = loadOrCreateKey(dataDir); return { key, publicKey } }

export function createNativeTransport(o: { dataDir: string; lookup?: PushLookup; request?: typeof https.request; now?: () => number }): NativeTransport {
  return async input => {
    const url = validGatewayUrl(input.config.url)
    if (!url) throw new Error('push_gateway_invalid')
    const device = validNativeDevice(input.device)
    const send: PushGatewaySend = {
      v: 1, platform: device.platform, environment: device.environment, token: device.token,
      notificationId: input.payload.notificationId, code: input.payload.code, locale: input.payload.locale,
      ...(input.payload.path && validPushPath(input.payload.path) ? { path: input.payload.path } : {}),
      ...(input.payload.tag && /^[A-Za-z0-9_-]{1,100}$/.test(input.payload.tag) ? { tag: input.payload.tag } : {}),
      ttlSeconds: Math.max(0, Math.min(PUSH_GATEWAY_MAX_TTL_SECONDS, Math.floor(input.ttlSeconds))),
    }
    if (input.signal.aborted || !input.beforeSend()) throw new Error('push_cancelled')
    const { key, publicKey } = teamKey(o.dataDir)
    const { body, authorization } = signedGatewayRequest(send, key, publicKey, (o.now ?? Date.now)())
    return postPinned({
      url: new URL(PUSH_GATEWAY_SEND_PATH, url), body: Buffer.from(body, 'utf8'), signal: input.signal, beforeSend: input.beforeSend,
      headers: { 'content-type': 'application/json', authorization, 'content-length': String(Buffer.byteLength(body)) },
      lookup: o.lookup ?? (host => dns.lookup(host, { all: true, verbatim: true })), request: o.request,
    })
  }
}
