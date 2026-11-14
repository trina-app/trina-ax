// Native app push (iOS/Android) through the push gateway (push-gateway/, contract in
// shared/src/cloud-protocol/push-gateway.ts). The team server never holds Apple or Google keys: it signs a small
// request with its team key and the gateway talks to APNs/FCM. The request carries ids, an event code and a locale,
// never text; the gateway picks generic words.
import crypto, { type KeyObject } from 'node:crypto'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import {
  PUSH_GATEWAY_SEND_PATH, PUSH_GATEWAY_MAX_TTL_SECONDS, pushGatewayAuthorization, pushGatewaySigningString, validPushBadge, validPushPath,
  validPushToken, type PushEnvironment, type PushGatewaySend, type PushLocale, type PushPlatform,
} from '@mycel/shared/cloud-protocol'
import type { PushEventType } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { HttpError } from '../http/errors'
import { loadOrCreateKey } from '../relay-client/registration'
import { answerError, errorCode, postPinned, PushSendError, type PushLookup } from './push-transport'

/** The gateway address (AppConfig push.gatewayUrl: MYCEL_PUSH_GATEWAY, server.json push.gatewayUrl or the edition default; app-config.ts resolvePushGateway). */
export interface NativePushConfig { url: string }
export interface NativeDevice { platform: PushPlatform; token: string; environment: PushEnvironment }
/** badge: the recipient's count for the app icon (push-badge.ts), a number only */
export interface NativePayload { notificationId: string; code: PushEventType; locale: PushLocale; tag?: string; path?: string; badge?: number }
export interface NativeSend { device: NativeDevice; payload: NativePayload; config: NativePushConfig; signal: AbortSignal; beforeSend: () => boolean; ttlSeconds: number }
/** error: the gateway's error code of a 400 answer (its answers carry nothing else) */
export type NativeTransport = (input: NativeSend) => Promise<{ statusCode: number; error?: string }>

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

/** A gateway from before `badge` refuses the key (400 invalid_body: its body schema is strict). The push then goes again
 * without it, and that gateway gets none for this long before the next try with it (a gateway updated meanwhile). Any
 * other answer, another 400 included, is the answer of this push as before. */
export const NO_BADGE_RETRY_MS = 60 * 60_000

export function createNativeTransport(o: { dataDir: string; lookup?: PushLookup; request?: typeof https.request; loopbackRequest?: typeof http.request; now?: () => number }): NativeTransport {
  // gateway address -> until when it gets no badge
  const noBadge = new Map<string, number>()
  const now = () => (o.now ?? Date.now)()
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
    const badge = validPushBadge(input.payload.badge) && (noBadge.get(url) ?? 0) <= now() ? input.payload.badge : undefined
    if (badge === undefined) return post(url, send, input)
    const first = await post(url, { ...send, badge }, input)
    if (first.statusCode !== 400 || first.error !== 'invalid_body') return first
    // an older gateway: the same push without the number (the app sets it itself when it opens)
    noBadge.set(url, now() + NO_BADGE_RETRY_MS)
    return post(url, send, input)
  }
  async function post(url: string, send: PushGatewaySend, input: NativeSend): Promise<{ statusCode: number; error?: string }> {
    if (input.signal.aborted || !input.beforeSend()) throw new PushSendError('push_cancelled')
    const { key, publicKey } = teamKey(o.dataDir)
    const { body, authorization } = signedGatewayRequest(send, key, publicKey, now())
    const headers = { 'content-type': 'application/json', authorization, 'content-length': String(Buffer.byteLength(body)) }
    if (new URL(url).protocol === 'http:') return postLoopback(new URL(PUSH_GATEWAY_SEND_PATH, url), headers, Buffer.from(body, 'utf8'), input.signal, input.beforeSend, o.loopbackRequest)
    return postPinned({
      url: new URL(PUSH_GATEWAY_SEND_PATH, url), body: Buffer.from(body, 'utf8'), signal: input.signal, beforeSend: input.beforeSend,
      headers: { 'content-type': 'application/json', authorization, 'content-length': String(Buffer.byteLength(body)) },
      lookup: o.lookup ?? (host => dns.lookup(host, { all: true, verbatim: true })), request: o.request, readError: true,
    })
  }
}

/** The configured gateway on this machine: no DNS (the host is a loopback literal or localhost, pinned to 127.0.0.1 /
 * ::1), no redirects, status only; the same last-moment beforeSend check and 10 s bound as the public path. */
function postLoopback(u: URL, headers: Record<string, string>, body: Buffer, signal: AbortSignal, beforeSend: () => boolean, request: typeof http.request = http.request): Promise<{ statusCode: number; error?: string }> {
  if (signal.aborted || !beforeSend()) return Promise.reject(new PushSendError('push_cancelled'))
  const host = u.hostname === '[::1]' ? '::1' : '127.0.0.1'
  return new Promise((resolve, reject) => {
    let finished = false, req: ReturnType<typeof http.request> | undefined
    const finish = (error?: Error, statusCode?: number, code?: string) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); req?.destroy(); error ? reject(error) : resolve({ statusCode: statusCode ?? 0, ...(code ? { error: code } : {}) }) }
    const abort = () => finish(new PushSendError('push_cancelled'))
    const timer = setTimeout(() => finish(new PushSendError('push_timeout')), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    try {
      req = request({ protocol: 'http:', host, port: Number(u.port), path: u.pathname, method: 'POST', headers: { ...headers, host: u.host }, agent: false }, res => {
        const statusCode = res.statusCode ?? 0
        if (statusCode !== 400) { res.destroy(); finish(undefined, statusCode); return }
        // a 400's error code (at most 512 bytes read): invalid_body may be a gateway from before `badge`
        let text = ''
        const done = () => { res.destroy(); finish(undefined, statusCode, answerError(text)) }
        res.setEncoding('utf8')
        res.on('data', (c: string) => { text += c; if (text.length > 512) done() })
        res.on('end', done); res.on('error', done)
      })
      req.once('error', e => finish(new PushSendError('push_transport_failed', { code: errorCode(e) })))
      req.end(body)
    } catch (e) { finish(new PushSendError('push_transport_failed', { code: errorCode(e) })) }
  })
}
