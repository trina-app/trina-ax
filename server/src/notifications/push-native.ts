// Native app push (iOS/Android) through the push gateway (push-gateway/, contract in
// shared/src/cloud-protocol/push-gateway.ts). The team server never holds Apple or Google keys: it signs a small
// request with its team key and the gateway talks to APNs/FCM. The request carries ids, an event code and a locale,
// never text; the gateway picks generic words.
import crypto, { type KeyObject } from 'node:crypto'
import dns from 'node:dns/promises'
import http from 'node:http'
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

/** The gateway address (AppConfig push.gatewayUrl: MYCEL_PUSH_GATEWAY or server.json push.gatewayUrl; unset = off). */
export interface NativePushConfig { url: string }
export interface NativeDevice { platform: PushPlatform; token: string; environment: PushEnvironment }
export interface NativePayload { notificationId: string; code: PushEventType; locale: PushLocale; tag?: string; path?: string }
export interface NativeSend { device: NativeDevice; payload: NativePayload; config: NativePushConfig; signal: AbortSignal; beforeSend: () => boolean; ttlSeconds: number }
export type NativeTransport = (input: NativeSend) => Promise<{ statusCode: number }>

/** https://host[:443], or plain http to a gateway on this machine (http://127.0.0.1:<port>, localhost, [::1]: a gateway
 * next to the server or a local test, as for the model upstreams). No credentials, path, query or fragment (the send
 * path is fixed by the contract). */
export function validGatewayUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null
  try {
    const u = new URL(raw)
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
    if (u.protocol === 'http:') return loopbackHost(u.hostname) && u.port ? u.origin : null
    if (u.protocol !== 'https:' || u.port || !u.hostname.includes('.')) return null
    return u.origin
  } catch { return null }
}
const loopbackHost = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
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

export function createNativeTransport(o: { dataDir: string; lookup?: PushLookup; request?: typeof https.request; loopbackRequest?: typeof http.request; now?: () => number }): NativeTransport {
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
    const headers = { 'content-type': 'application/json', authorization, 'content-length': String(Buffer.byteLength(body)) }
    if (new URL(url).protocol === 'http:') return postLoopback(new URL(PUSH_GATEWAY_SEND_PATH, url), headers, Buffer.from(body, 'utf8'), input.signal, input.beforeSend, o.loopbackRequest)
    return postPinned({
      url: new URL(PUSH_GATEWAY_SEND_PATH, url), body: Buffer.from(body, 'utf8'), signal: input.signal, beforeSend: input.beforeSend,
      headers: { 'content-type': 'application/json', authorization, 'content-length': String(Buffer.byteLength(body)) },
      lookup: o.lookup ?? (host => dns.lookup(host, { all: true, verbatim: true })), request: o.request,
    })
  }
}

/** The configured gateway on this machine: no DNS (the host is a loopback literal or localhost, pinned to 127.0.0.1 /
 * ::1), no redirects, status only; the same last-moment beforeSend check and 10 s bound as the public path. */
function postLoopback(u: URL, headers: Record<string, string>, body: Buffer, signal: AbortSignal, beforeSend: () => boolean, request: typeof http.request = http.request): Promise<{ statusCode: number }> {
  if (signal.aborted || !beforeSend()) return Promise.reject(new Error('push_cancelled'))
  const host = u.hostname === '[::1]' ? '::1' : '127.0.0.1'
  return new Promise((resolve, reject) => {
    let finished = false, req: ReturnType<typeof http.request> | undefined
    const finish = (error?: Error, statusCode?: number) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); req?.destroy(); error ? reject(error) : resolve({ statusCode: statusCode ?? 0 }) }
    const abort = () => finish(new Error('push_cancelled'))
    const timer = setTimeout(() => finish(new Error('push_timeout')), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    try {
      req = request({ protocol: 'http:', host, port: Number(u.port), path: u.pathname, method: 'POST', headers: { ...headers, host: u.host }, agent: false }, res => { const statusCode = res.statusCode ?? 0; res.destroy(); finish(undefined, statusCode) })
      req.once('error', () => finish(new Error('push_transport_failed')))
      req.end(body)
    } catch { finish(new Error('push_transport_failed')) }
  })
}
