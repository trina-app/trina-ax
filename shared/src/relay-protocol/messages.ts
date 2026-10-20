// JSON payloads of the relay protocol: stream OPEN / RESPONSE heads, GOAWAY, EVENT, and the text handshake that
// runs before any binary frame. Validated by hand (no zod) so the relay can load this file directly in Node.
import { FrameError, SUPPORTED_VERSIONS } from './frames.ts'

export type HeaderList = [string, string][]

/** OPEN payload (relay -> team server). */
export interface OpenMeta {
  kind: 'http' | 'ws'
  method: string
  /** path + query, starts with "/" */
  path: string
  /** public host the client used, e.g. acme.treesoop.com (dev: acme.localhost:19161) */
  host: string
  /** public scheme the client used (Cloudflare terminates TLS in production) */
  proto: 'http' | 'https'
  /** request headers without hop-by-hop, Host, CF-*, X-Forwarded-* and similar (the relay strips them) */
  headers: HeaderList
  /** real client IP (Cloudflare's CF-Connecting-IP or the socket peer). Never logged or stored by the relay. */
  clientIp: string | null
}

/** RESPONSE payload (team -> relay): the HTTP response head. For ws streams 101 accepts the WebSocket. */
export interface ResponseHead {
  status: number
  headers: HeaderList
}

export interface Goaway {
  /** restart: the relay is being replaced (reconnect now, reset backoff); replaced: a newer instance of this team
   * took over (do not reconnect); suspended: the operator blocked the team; shutdown: the team server is leaving */
  reason: 'restart' | 'replaced' | 'suspended' | 'shutdown'
  /** replaced: the instance id that took over */
  by?: string
}

export type RelayEvent =
  /** sent to both the new and the old instance when the newer one takes over */
  | { type: 'instance_replaced'; by: string; previous: string; at: number }
  /** a connection with a key that is not this team's current key was rejected (rate-limited, 1 per minute) */
  | { type: 'key_rejected'; at: number; count: number }
  /** free-form notice from the relay operator (e.g. fair-use warning) */
  | { type: 'notice'; level: 'info' | 'warn'; code: string; message: string; at: number }

// ---------------------------------------------------------------- handshake (WebSocket text messages)

export interface Challenge { t: 'challenge'; vs: number[]; nonce: string; ts: number }
export interface AuthMsg {
  t: 'auth'
  v: number
  /** team id from registration (stable across renames) */
  team: string
  /** random id of this team-server process start (newer instance wins) */
  instance: string
  /** 0-based index of this control connection */
  conn: number
  ts: number
  /** base64 Ed25519 signature of authSigningString(...) */
  sig: string
}
export interface AuthOk {
  t: 'ok'
  v: number
  initialWindow: number
  maxStreams: number
  pingMs: number
  silenceMs: number
  /** public address of the team, e.g. https://acme.treesoop.com */
  address: string
  name: string
  /** live control connections of this instance including this one */
  conns: number
}
export interface AuthFail { t: 'error'; code: 'auth_failed' | 'version' | 'suspended' | 'protocol'; message: string }

/** Clock skew allowed between the team server and the relay. */
export const AUTH_MAX_SKEW_MS = 60_000
export const AUTH_TIMEOUT_MS = 10_000

export function authSigningString(team: string, instance: string, nonce: string, ts: number): string {
  return `mycel-relay-v2\n${team}\n${instance}\n${nonce}\n${ts}`
}

/** Pick the highest version both sides speak; null when there is none. */
export function pickVersion(offered: readonly number[], mine: readonly number[] = SUPPORTED_VERSIONS): number | null {
  let best: number | null = null
  for (const v of offered) if (mine.includes(v) && (best === null || v > best)) best = v
  return best
}

// ---------------------------------------------------------------- validation

const isObj = (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null && !Array.isArray(o)
const isStr = (s: unknown, max = 8192): s is string => typeof s === 'string' && s.length <= max
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)
// RFC 7230 token
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function isHeaderList(h: unknown, maxPairs = 256): h is HeaderList {
  if (!Array.isArray(h) || h.length > maxPairs) return false
  for (const p of h) {
    if (!Array.isArray(p) || p.length !== 2 || !isStr(p[0], 256) || !isStr(p[1], 16384)) return false
    if (!TOKEN.test(p[0]) || /[\r\n\0]/.test(p[1])) return false
  }
  return true
}

export function parseOpenMeta(o: unknown): OpenMeta {
  if (!isObj(o)) throw new FrameError('OPEN: not an object')
  if (o.kind !== 'http' && o.kind !== 'ws') throw new FrameError('OPEN: bad kind')
  if (!isStr(o.method, 32) || !TOKEN.test(o.method)) throw new FrameError('OPEN: bad method')
  if (!isStr(o.path, 16384) || !o.path.startsWith('/') || /[\s\0]/.test(o.path)) throw new FrameError('OPEN: bad path')
  if (!isStr(o.host, 300) || !/^[a-z0-9.:[\]-]+$/i.test(o.host)) throw new FrameError('OPEN: bad host')
  if (o.proto !== 'http' && o.proto !== 'https') throw new FrameError('OPEN: bad proto')
  if (!isHeaderList(o.headers)) throw new FrameError('OPEN: bad headers')
  if (o.clientIp !== null && !(isStr(o.clientIp, 64) && /^[0-9a-f.:]+$/i.test(o.clientIp))) throw new FrameError('OPEN: bad clientIp')
  return { kind: o.kind, method: o.method, path: o.path, host: o.host, proto: o.proto, headers: o.headers, clientIp: o.clientIp }
}

export function parseResponseHead(o: unknown): ResponseHead {
  if (!isObj(o)) throw new FrameError('RESPONSE: not an object')
  if (!isInt(o.status) || o.status < 101 || o.status > 599) throw new FrameError('RESPONSE: bad status')
  if (!isHeaderList(o.headers)) throw new FrameError('RESPONSE: bad headers')
  return { status: o.status, headers: o.headers }
}

export function parseGoaway(o: unknown): Goaway {
  if (!isObj(o) || !['restart', 'replaced', 'suspended', 'shutdown'].includes(o.reason as string)) throw new FrameError('GOAWAY: bad reason')
  return { reason: o.reason as Goaway['reason'], ...(isStr(o.by, 64) ? { by: o.by } : {}) }
}

export function parseRelayEvent(o: unknown): RelayEvent {
  if (!isObj(o)) throw new FrameError('EVENT: not an object')
  const at = isInt(o.at) ? o.at : Date.now()
  switch (o.type) {
    case 'instance_replaced':
      if (!isStr(o.by, 64) || !isStr(o.previous, 64)) throw new FrameError('EVENT: bad instance_replaced')
      return { type: 'instance_replaced', by: o.by, previous: o.previous, at }
    case 'key_rejected':
      return { type: 'key_rejected', at, count: isInt(o.count) ? o.count : 1 }
    case 'notice':
      if (!isStr(o.code, 64) || !isStr(o.message, 1000)) throw new FrameError('EVENT: bad notice')
      return { type: 'notice', level: o.level === 'warn' ? 'warn' : 'info', code: o.code, message: o.message, at }
    default:
      throw new FrameError('EVENT: unknown type')
  }
}

export function parseChallenge(o: unknown): Challenge {
  if (!isObj(o) || o.t !== 'challenge') throw new FrameError('handshake: expected challenge')
  if (!Array.isArray(o.vs) || o.vs.length > 16 || !o.vs.every(isInt)) throw new FrameError('handshake: bad versions')
  if (!isStr(o.nonce, 128) || !isInt(o.ts)) throw new FrameError('handshake: bad challenge')
  return { t: 'challenge', vs: o.vs, nonce: o.nonce, ts: o.ts }
}

export function parseAuth(o: unknown): AuthMsg {
  if (!isObj(o) || o.t !== 'auth') throw new FrameError('handshake: expected auth')
  if (!isInt(o.v) || !isStr(o.team, 64) || !isStr(o.instance, 64) || !/^[A-Za-z0-9_-]{4,64}$/.test(o.instance)) throw new FrameError('handshake: bad auth')
  if (!isInt(o.conn) || o.conn < 0 || o.conn > 15 || !isInt(o.ts) || !isStr(o.sig, 200)) throw new FrameError('handshake: bad auth')
  return { t: 'auth', v: o.v, team: o.team, instance: o.instance, conn: o.conn, ts: o.ts, sig: o.sig }
}

export function parseAuthReply(o: unknown): AuthOk | AuthFail {
  if (!isObj(o)) throw new FrameError('handshake: bad reply')
  if (o.t === 'error') {
    const code = ['auth_failed', 'version', 'suspended', 'protocol'].includes(o.code as string) ? (o.code as AuthFail['code']) : 'protocol'
    return { t: 'error', code, message: isStr(o.message, 1000) ? o.message : '' }
  }
  if (o.t !== 'ok') throw new FrameError('handshake: bad reply')
  if (!isInt(o.v) || !isInt(o.initialWindow) || o.initialWindow < 16384 || o.initialWindow > 16 * 1024 * 1024) throw new FrameError('handshake: bad ok')
  if (!isInt(o.maxStreams) || !isInt(o.pingMs) || !isInt(o.silenceMs) || !isStr(o.address, 300) || !isStr(o.name, 64) || !isInt(o.conns)) throw new FrameError('handshake: bad ok')
  return { t: 'ok', v: o.v, initialWindow: o.initialWindow, maxStreams: o.maxStreams, pingMs: o.pingMs, silenceMs: o.silenceMs, address: o.address, name: o.name, conns: o.conns }
}

// ---------------------------------------------------------------- headers

/** Hop-by-hop and proxy headers never forwarded in either direction. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'http2-settings'])
/** Client-supplied headers that could spoof the real IP or the original scheme: dropped by the relay and never trusted by the team server. */
const SPOOFABLE = /^(x-forwarded-.*|forwarded|x-real-ip|true-client-ip|cf-.*|cdn-loop|x-client-ip|x-cluster-client-ip)$/

/** Request headers to forward to the team server. WebSocket upgrades keep sec-websocket-protocol only. */
export function forwardRequestHeaders(raw: readonly string[], kind: 'http' | 'ws'): HeaderList {
  const out: HeaderList = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i].toLowerCase()
    if (HOP.has(k) || SPOOFABLE.test(k)) continue
    if (k.startsWith('sec-websocket-') && !(kind === 'ws' && k === 'sec-websocket-protocol')) continue
    out.push([k, raw[i + 1]])
  }
  return out
}

/** Response headers to send back to the client (team server -> relay -> client). */
export function forwardResponseHeaders(h: HeaderList): HeaderList {
  return h.filter(([k]) => {
    const l = k.toLowerCase()
    return !HOP.has(l) && !l.startsWith('sec-websocket-')
  })
}
