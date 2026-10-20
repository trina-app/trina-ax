// Relay protocol v2: binary frames multiplexing many streams over one WebSocket control connection between the
// relay (Node 25) and a team server (Bun). Design tab 6 "중계 프로토콜" + spike report (spike-relay/REPORT.md).
//
// Frame: [type u8][streamId u32 BE][flags u8][len u32 BE][payload: len bytes], header 10 bytes, payload <= 64 KB.
// One or more frames per WebSocket binary message (senders put one; the decoder accepts several).
//
// This file is loaded by Node's type stripping as well as by Bun: erasable TypeScript only (no enums, no parameter
// properties, no namespaces) and relative imports with the .ts extension.

export const RELAY_PROTOCOL_VERSION = 2
/** Versions this build speaks (the relay offers them in the challenge, the team server picks the highest common). */
export const SUPPORTED_VERSIONS: readonly number[] = [2]

export const FrameType = {
  /** relay -> team: new stream. payload = JSON OpenMeta */
  OPEN: 1,
  /** stream bytes (HTTP body or WebSocket message pieces); counts against the stream window */
  DATA: 2,
  /** half-close: the sender sends no more DATA on this stream */
  END: 3,
  /** abort the stream. payload = [code u32][utf8 reason] */
  RST: 4,
  /** payload = [increment u32 > 0]; stream id 0 is reserved */
  WINDOW: 5,
  /** stream 0, payload = 8 opaque bytes (the sender's clock), answered by PONG with the same bytes */
  PING: 6,
  PONG: 7,
  /** stream 0, JSON Goaway: the sender closes soon; open nothing new on this connection */
  GOAWAY: 8,
  /** team -> relay: response head of a stream (HTTP status + headers; 101 accepts a WebSocket). JSON ResponseHead */
  RESPONSE: 9,
  /** stream 0, JSON RelayEvent: control-plane notifications (another instance took over, a key was rejected) */
  EVENT: 10,
} as const
export type FrameTypeCode = (typeof FrameType)[keyof typeof FrameType]
export const FRAME_NAMES: Record<number, string> = Object.fromEntries(Object.entries(FrameType).map(([k, v]) => [v, k]))

/** DATA flags. WebSocket streams only; HTTP DATA carries no flags. */
export const DataFlag = {
  /** the WebSocket message is binary (else UTF-8 text) */
  WS_BINARY: 0x1,
  /** more pieces of the same WebSocket message follow (messages > 64 KB are split) */
  WS_CONT: 0x2,
  /** WebSocket close: payload = [code u16][utf8 reason <= 123 bytes]. Exempt from flow control; END follows. */
  WS_CLOSE: 0x4,
} as const
const DATA_FLAGS_MASK = DataFlag.WS_BINARY | DataFlag.WS_CONT | DataFlag.WS_CLOSE

export const RstCode = {
  CANCEL: 1,
  CONN_LOST: 2,
  FLOW_CONTROL: 3,
  PROTOCOL: 4,
  TEAM_OFFLINE: 5,
  REFUSED: 6,
  TIMEOUT: 7,
  REPLACED: 8,
} as const
export type RstCodeValue = (typeof RstCode)[keyof typeof RstCode]
export const RST_NAMES: Record<number, string> = Object.fromEntries(Object.entries(RstCode).map(([k, v]) => [v, k]))

/** Close codes of the control connection (relay <-> team server). */
export const ControlClose = {
  /** signature, key or team unknown / revoked: back off and retry (the key may be re-registered) */
  AUTH_FAILED: 4003,
  /** malformed frame or handshake */
  PROTOCOL_ERROR: 4004,
  /** no common protocol version: the team server needs an update (it does not reconnect until restarted) */
  VERSION: 4005,
  /** nothing received for too long (half-open connection) or no PONG to a stall probe */
  NO_RESPONSE: 4008,
  /** a newer instance of the same team connected with the same key: do NOT reconnect */
  REPLACED: 4009,
  /** the operator suspended this team address */
  SUSPENDED: 4010,
} as const

/** Close codes the relay sends to browser WebSockets it proxies. */
export const ClientClose = {
  NORMAL: 1000,
  /** a single message or the queued backlog was too large */
  TOO_BIG: 1009,
  INTERNAL: 1011,
  /** relay restarting or the team server's connection was lost: reconnect (0-1 s jitter) and resume */
  RESTART: 1012,
  /** the team server is not connected */
  TEAM_OFFLINE: 1013,
  /** the team server could not keep up / the client read too slowly: reconnect and resume */
  TOO_SLOW: 4408,
} as const

export const HDR = 10
export const MAX_PAYLOAD = 64 * 1024
/** OPEN / RESPONSE / GOAWAY / EVENT JSON payloads */
export const MAX_JSON_PAYLOAD = 32 * 1024
export const MAX_RST_REASON = 256
export const MAX_CLOSE_REASON = 123

/** Flow control and liveness defaults (both sides; the relay's handshake `ok` may override the window). */
export const DEFAULTS = {
  /** per-stream window in each direction */
  initialWindow: 256 * 1024,
  /** a stream whose queued, unsent bytes exceed this is reset (FLOW_CONTROL) */
  maxStreamBuffer: 1024 * 1024,
  /** browser -> relay WebSocket backlog cap (a browser socket can't be paused): close 1009 */
  clientWsCap: 4 * 1024 * 1024,
  /** concurrent streams per control connection */
  maxStreams: 512,
  /** team server PINGs every control connection this often */
  pingMs: 20_000,
  /** no frame for this long: the connection is dead (both sides) */
  silenceMs: 45_000,
  /** control connections per team server */
  connections: 2,
  maxConnections: 4,
} as const

export class FrameError extends Error {
  name = 'FrameError'
}

export interface Frame {
  type: number
  id: number
  flags: number
  payload: Uint8Array
}

export function encodeFrame(type: number, id: number, flags = 0, payload?: Uint8Array): Uint8Array {
  const len = payload?.byteLength ?? 0
  if (len > MAX_PAYLOAD) throw new FrameError(`payload too large (${len})`)
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new FrameError('bad stream id')
  const b = new Uint8Array(HDR + len)
  const dv = new DataView(b.buffer)
  b[0] = type
  dv.setUint32(1, id)
  b[5] = flags
  dv.setUint32(6, len)
  if (payload) b.set(payload, HDR)
  return b
}

const STREAM0_TYPES = new Set<number>([FrameType.PING, FrameType.PONG, FrameType.GOAWAY, FrameType.EVENT])
const JSON_TYPES = new Set<number>([FrameType.OPEN, FrameType.RESPONSE, FrameType.GOAWAY, FrameType.EVENT])

/** Check one frame's header and payload shape. Throws FrameError. */
export function validateFrame(f: Frame): void {
  const { type, id, flags, payload } = f
  if (type < FrameType.OPEN || type > FrameType.EVENT) throw new FrameError(`unknown frame type ${type}`)
  if (STREAM0_TYPES.has(type)) {
    if (id !== 0) throw new FrameError(`${FRAME_NAMES[type]} must use stream 0`)
  } else if (id === 0) {
    throw new FrameError(`${FRAME_NAMES[type]} needs a stream id`)
  }
  if (type === FrameType.DATA) {
    if (flags & ~DATA_FLAGS_MASK) throw new FrameError('unknown DATA flags')
    if (flags & DataFlag.WS_CLOSE) {
      if (flags & DataFlag.WS_CONT) throw new FrameError('WS_CLOSE cannot continue')
      if (payload.byteLength < 2 || payload.byteLength > 2 + MAX_CLOSE_REASON) throw new FrameError('bad WS_CLOSE payload')
    }
  } else if (flags !== 0) {
    throw new FrameError(`${FRAME_NAMES[type]} takes no flags`)
  }
  const len = payload.byteLength
  switch (type) {
    case FrameType.END:
      if (len !== 0) throw new FrameError('END has no payload')
      break
    case FrameType.RST:
      if (len < 4 || len > 4 + MAX_RST_REASON) throw new FrameError('bad RST payload')
      break
    case FrameType.WINDOW: {
      if (len !== 4) throw new FrameError('bad WINDOW payload')
      const inc = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0)
      if (inc === 0) throw new FrameError('WINDOW increment 0')
      break
    }
    case FrameType.PING:
    case FrameType.PONG:
      if (len !== 8) throw new FrameError('PING/PONG payload is 8 bytes')
      break
  }
  if (JSON_TYPES.has(type) && (len === 0 || len > MAX_JSON_PAYLOAD)) throw new FrameError(`bad ${FRAME_NAMES[type]} payload size`)
}

/** Decode every frame in one WebSocket message. Throws FrameError on any malformed input (never anything else). */
export function decodeFrames(buf: Uint8Array): Frame[] {
  const out: Frame[] = []
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0
  while (o < buf.byteLength) {
    if (o + HDR > buf.byteLength) throw new FrameError('truncated header')
    const type = buf[o]
    const id = dv.getUint32(o + 1)
    const flags = buf[o + 5]
    const len = dv.getUint32(o + 6)
    if (len > MAX_PAYLOAD) throw new FrameError(`payload too large (${len})`)
    if (o + HDR + len > buf.byteLength) throw new FrameError('truncated payload')
    const f = { type, id, flags, payload: buf.subarray(o + HDR, o + HDR + len) }
    validateFrame(f)
    out.push(f)
    o += HDR + len
  }
  if (out.length === 0) throw new FrameError('empty message')
  return out
}

const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: true })

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}
export function readU32(b: Uint8Array, at = 0): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at)
}

export function rstPayload(code: number, reason = ''): Uint8Array {
  const r = te.encode(reason).subarray(0, MAX_RST_REASON)
  const p = new Uint8Array(4 + r.byteLength)
  new DataView(p.buffer).setUint32(0, code)
  p.set(r, 4)
  return p
}
export function parseRst(p: Uint8Array): { code: number; reason: string } {
  let reason = ''
  try { reason = td.decode(p.subarray(4)) } catch { reason = '' }
  return { code: readU32(p), reason }
}

export function closePayload(code: number, reason = ''): Uint8Array {
  let r = te.encode(reason)
  if (r.byteLength > MAX_CLOSE_REASON) r = te.encode(truncateUtf8(reason, MAX_CLOSE_REASON))
  const p = new Uint8Array(2 + r.byteLength)
  new DataView(p.buffer).setUint16(0, code)
  p.set(r, 2)
  return p
}
export function parseClose(p: Uint8Array): { code: number; reason: string } {
  const code = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(0)
  let reason = ''
  try { reason = td.decode(p.subarray(2)) } catch { reason = '' }
  return { code, reason }
}

/** Longest prefix of s whose UTF-8 encoding fits in max bytes (never splits a character). */
export function truncateUtf8(s: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of s) {
    const k = te.encode(ch).byteLength
    if (n + k > max) break
    out += ch
    n += k
  }
  return out
}

/** 8-byte PING payload: the sender's monotonic clock in ms (float64), echoed back in PONG. */
export function pingPayload(nowMs: number): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setFloat64(0, nowMs)
  return b
}
export function readPing(b: Uint8Array): number {
  return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0)
}

export function jsonPayload(o: unknown): Uint8Array {
  const b = te.encode(JSON.stringify(o))
  if (b.byteLength > MAX_JSON_PAYLOAD) throw new FrameError('JSON payload too large')
  return b
}
export function parseJsonPayload(b: Uint8Array): unknown {
  try {
    return JSON.parse(td.decode(b))
  } catch {
    throw new FrameError('bad JSON payload')
  }
}

export const utf8 = { encode: (s: string) => te.encode(s), decode: (b: Uint8Array) => new TextDecoder().decode(b) }
