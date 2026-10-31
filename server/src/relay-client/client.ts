// Team-server side of the relay (tab 6 "중계 프로토콜"): keeps N outbound control WebSockets to the relay, answers the
// Ed25519 challenge, and serves every stream the relay opens by calling the app in-process (no local HTTP hop).
//
// - Reconnect: full jitter over 0.5 s * 2^n, capped at 30 s; n resets after 60 s connected. GOAWAY(restart): open a
//   new connection at once (0-1 s jitter, backoff reset) and let the old one finish its streams.
// - Close 4009 / GOAWAY(replaced): a newer instance of this team took over: stop for good (no flapping).
// - Liveness: PING every pingMs; nothing received for deadMs -> drop and reconnect (the relay does the same).
// - Bodies stream both ways bounded by the per-stream window: the request body is a pull ReadableStream that returns
//   window as the app reads; the response body is read only as fast as the window allows.
import type { KeyObject } from 'node:crypto'
import { WS_PROTOCOL } from '@mycel/shared/api'
import {
  AUTH_TIMEOUT_MS, ControlClose, DEFAULTS, FrameError, Mux, RECONNECT_STABLE_MS, RstCode, SUPPORTED_VERSIONS,
  authSigningString, parseAuthReply, parseChallenge, pickVersion, reconnectDelay, signB64, streamBody,
  type AuthOk, type Goaway, type HeaderList, type OpenMeta, type RelayEvent, type Stream,
} from '@mycel/shared/relay-protocol'
import type { VirtualWebSocket } from '../services'
import { RelayWebSocket } from './virtual-ws'
import { TimeJumpWatch } from './time-jump'

export interface RelayClientLog {
  debug(msg: string, f?: Record<string, unknown>): void
  info(msg: string, f?: Record<string, unknown>): void
  warn(msg: string, f?: Record<string, unknown>): void
  error(msg: string, f?: Record<string, unknown>): void
}

export type RelayClientStateName = 'connecting' | 'connected' | 'offline' | 'replaced' | 'stopped'
export interface RelayClientState {
  state: RelayClientStateName
  /** why offline / replaced: auth_failed, suspended, update_required, unreachable, ... */
  detail: string | null
  connectedSince: number | null
  address: string | null
  name: string | null
  conns: number
  lastError: string | null
}

export interface RelayClientOptions {
  /** ws(s)://<relay>/connect */
  url: string
  teamId: string
  key: KeyObject
  /** random per process start unless given (tests) */
  instance?: string
  connections?: number
  /** serve one relayed HTTP request (in-process app.fetch) */
  fetch(req: Request, info: { ip: string | null }): Promise<Response>
  /** hand a relayed WebSocket to the realtime hub; false when nothing can take it */
  attachWs?(ws: VirtualWebSocket, req: Request, info: { ip: string | null }): boolean
  log: RelayClientLog
  onEvent?(e: RelayEvent, self: string): void
  onState?(s: RelayClientState): void
  /** the relay told us the address this connection came from (the office's public exit address) */
  onSeenIp?(ip: string): void
  /** overrides for tests */
  pingMs?: number
  deadMs?: number
  backoffBaseMs?: number
  backoffCapMs?: number
}

interface Conn {
  idx: number
  gen: number
  ws: WebSocket
  mux: Mux | null
  upAt: number
  pinger: ReturnType<typeof setInterval> | null
  current: boolean
}

export class RelayClient {
  readonly instance: string
  private o: RelayClientOptions
  private n: number
  private slots: { attempt: number; conn: Conn | null; timer: ReturnType<typeof setTimeout> | null; gen: number }[]
  private draining = new Set<Conn>()
  private stopped = false
  private st: RelayClientState = { state: 'connecting', detail: null, connectedSince: null, address: null, name: null, conns: 0, lastError: null }
  private ok: AuthOk | null = null
  readonly stats = { connects: 0, drops: 0, streams: 0, httpErrors: 0, timeJumps: 0 }
  /** F2: after a VM resume the control connections are half-open: reconnect them at once */
  private jumps = new TimeJumpWatch({ onJump: (gap) => this.reconnectAll(gap) })

  constructor(o: RelayClientOptions) {
    this.o = o
    this.instance = o.instance ?? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    this.n = Math.max(1, Math.min(DEFAULTS.maxConnections, o.connections ?? DEFAULTS.connections))
    this.slots = Array.from({ length: this.n }, () => ({ attempt: 0, conn: null, timer: null, gen: 0 }))
  }

  get state(): RelayClientState { return { ...this.st } }

  /** streams open right now on every control connection (diagnostics; tests check nothing lingers) */
  openStreams(): number {
    let n = 0
    for (const s of this.slots) n += s.conn?.mux?.streams.size ?? 0
    for (const c of this.draining) n += c.mux?.streams.size ?? 0
    return n
  }

  start(): void {
    for (let i = 0; i < this.n; i++) this.connect(i)
    this.jumps.start()
  }

  /** The process was frozen for gapMs (time-jump.ts): drop every connection and connect again now, no backoff. */
  reconnectAll(gapMs: number): void {
    if (this.stopped || this.st.state === 'replaced') return
    this.stats.timeJumps++
    this.o.log.info('relay: the clock jumped (resume after sleep?); reconnecting now', { gapMs })
    for (let i = 0; i < this.n; i++) {
      const slot = this.slots[i]
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null }
      slot.attempt = 0
      const c = slot.conn
      if (c) {
        slot.conn = null
        c.current = false
        this.closeConn(c, ControlClose.NO_RESPONSE, 'resumed after a pause', true)
      }
      this.connect(i)
    }
    this.updateConnState()
  }

  /** Stop for good (server shutdown): GOAWAY(shutdown) and close every connection. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.jumps.stop()
    for (const s of this.slots) {
      if (s.timer) clearTimeout(s.timer)
      if (s.conn) this.closeConn(s.conn, 1001, 'server shutting down', true)
    }
    for (const c of this.draining) this.closeConn(c, 1001, 'server shutting down', true)
    this.setState({ state: 'stopped', detail: null, connectedSince: null, conns: 0 })
  }

  private setState(p: Partial<RelayClientState>): void {
    const prev = this.st
    this.st = { ...this.st, ...p }
    if (prev.state !== this.st.state || prev.detail !== this.st.detail || prev.conns !== this.st.conns || prev.lastError !== this.st.lastError) this.o.onState?.(this.state)
  }

  private liveConns(): number {
    return this.slots.filter((s) => s.conn?.mux && !s.conn.mux.closed).length
  }
  private updateConnState(): void {
    if (this.stopped || this.st.state === 'replaced') return
    const live = this.liveConns()
    if (live > 0) this.setState({ state: 'connected', detail: null, conns: live, connectedSince: this.st.connectedSince ?? Date.now() })
    else this.setState({ state: this.st.state === 'connected' ? 'connecting' : this.st.state, conns: 0, connectedSince: null })
  }

  // ------------------------------------------------------------------ connections

  private connect(idx: number): void {
    const slot = this.slots[idx]
    slot.timer = null
    if (this.stopped || this.st.state === 'replaced') return
    const gen = ++slot.gen
    let ws: WebSocket
    try {
      ws = new WebSocket(this.o.url)
    } catch (e) {
      this.o.log.error('relay url invalid', { url: this.o.url, err: e })
      this.setState({ state: 'offline', detail: 'bad_url', lastError: String(e) })
      return
    }
    ws.binaryType = 'arraybuffer'
    const c: Conn = { idx, gen, ws, mux: null, upAt: 0, pinger: null, current: true }
    slot.conn = c
    let authed = false
    const authTimer = setTimeout(() => { if (!authed) this.closeConn(c, ControlClose.AUTH_FAILED, 'handshake timeout') }, AUTH_TIMEOUT_MS)
    ws.onmessage = (e: MessageEvent) => {
      if (!c.current && !this.draining.has(c)) return
      if (!authed) {
        if (typeof e.data !== 'string') { this.closeConn(c, ControlClose.PROTOCOL_ERROR, 'expected handshake'); return }
        try {
          const m = JSON.parse(e.data) as { t?: string }
          if (m.t === 'challenge') {
            const ch = parseChallenge(m)
            const v = pickVersion(ch.vs)
            if (v === null) {
              this.setState({ state: 'offline', detail: 'update_required', lastError: `relay speaks protocol ${ch.vs.join(',')}, this server ${SUPPORTED_VERSIONS.join(',')}` })
              this.closeConn(c, ControlClose.VERSION, 'no common version')
              this.stopped = true
              return
            }
            const ts = Date.now()
            ws.send(JSON.stringify({ t: 'auth', v, team: this.o.teamId, instance: this.instance, conn: idx, ts, sig: signB64(this.o.key, authSigningString(this.o.teamId, this.instance, ch.nonce, ts)) }))
            return
          }
          const r = parseAuthReply(m)
          if (r.t === 'error') {
            this.setState({ detail: r.code === 'auth_failed' ? 'auth_failed' : r.code === 'suspended' ? 'suspended' : r.code === 'version' ? 'update_required' : 'protocol', lastError: r.message })
            return // the close follows
          }
          authed = true
          clearTimeout(authTimer)
          this.ok = r
          c.upAt = Date.now()
          c.mux = new Mux(
            { send: (b) => ws.send(b), buffered: () => ws.bufferedAmount },
            {
              role: 'team', initialWindow: r.initialWindow, highWater: 1024 * 1024, maxStreams: r.maxStreams,
              onOpen: (s) => this.onStream(s),
              onGoaway: (g) => this.onGoaway(c, g),
              onEvent: (ev) => this.onEvent(ev),
            },
          )
          const pingMs = this.o.pingMs ?? r.pingMs
          const deadMs = this.o.deadMs ?? r.silenceMs
          c.pinger = setInterval(() => {
            if (!c.mux) return
            if (Date.now() - c.mux.lastRecv > deadMs) { this.o.log.warn('relay connection silent, reconnecting', { idx }); this.closeConn(c, ControlClose.NO_RESPONSE, 'no traffic from relay'); return }
            c.mux.ping()
          }, pingMs)
          this.stats.connects++
          if (r.seenIp) { try { this.o.onSeenIp?.(r.seenIp) } catch (err) { this.o.log.error('relay seenIp handler failed', { err }) } }
          this.setState({ address: r.address, name: r.name, lastError: null })
          this.updateConnState()
          this.o.log.info('relay connected', { idx, address: r.address, conns: this.liveConns() })
        } catch (err) {
          this.o.log.warn('relay handshake failed', { idx, err })
          this.closeConn(c, ControlClose.PROTOCOL_ERROR, 'bad handshake')
        }
        return
      }
      if (!c.mux || typeof e.data === 'string') { this.closeConn(c, ControlClose.PROTOCOL_ERROR, 'binary frames only'); return }
      try {
        c.mux.onMessage(new Uint8Array(e.data as ArrayBuffer))
      } catch (err) {
        this.o.log.warn('relay protocol error', { idx, err: err instanceof FrameError ? err.message : err })
        this.closeConn(c, ControlClose.PROTOCOL_ERROR, 'protocol error')
      }
    }
    ws.onerror = () => {}
    ws.onclose = (e: CloseEvent) => {
      clearTimeout(authTimer)
      this.lost(c, e.code, e.reason)
    }
  }

  private closeConn(c: Conn, code: number, reason: string, final = false): void {
    try { c.ws.close(code, reason) } catch {}
    if (final) {
      c.current = false
      this.cleanup(c, reason)
    } else {
      this.lost(c, code, reason)
    }
  }

  private cleanup(c: Conn, why: string): void {
    if (c.pinger) { clearInterval(c.pinger); c.pinger = null }
    c.mux?.close(why)
    this.draining.delete(c)
  }

  private lost(c: Conn, code: number, reason: string): void {
    const slot = this.slots[c.idx]
    const wasCurrent = c.current && slot.conn === c && slot.gen === c.gen
    const hadMux = !!c.mux && !c.mux.closed
    this.cleanup(c, `relay connection lost (${code})`)
    if (!wasCurrent) return
    c.current = false
    slot.conn = null
    if (hadMux) this.stats.drops++
    if (code === ControlClose.REPLACED) {
      this.replaced('another server with this team key connected (4009)')
      return
    }
    this.updateConnState()
    if (this.stopped) return
    if (code === ControlClose.VERSION) { this.stopped = true; this.setState({ state: 'offline', detail: 'update_required' }); return }
    if (c.upAt && Date.now() - c.upAt >= RECONNECT_STABLE_MS) slot.attempt = 0
    if (code === ControlClose.SUSPENDED) slot.attempt = Math.max(slot.attempt, 10)
    const delay = reconnectDelay(slot.attempt++, Math.random, this.o.backoffBaseMs ?? 500, this.o.backoffCapMs ?? 30_000)
    if (this.liveConns() === 0) {
      const detail = code === ControlClose.AUTH_FAILED ? 'auth_failed' : code === ControlClose.SUSPENDED ? 'suspended' : hadMux ? 'connection_lost' : (this.st.detail ?? 'unreachable')
      this.setState({ state: 'offline', detail, lastError: reason || this.st.lastError })
    }
    this.o.log[slot.attempt > 3 ? 'debug' : 'info']('relay disconnected', { idx: c.idx, code, reason, retryInMs: delay })
    slot.timer = setTimeout(() => this.connect(c.idx), delay)
  }

  private replaced(detail: string): void {
    if (this.st.state === 'replaced') return
    this.o.log.warn('relay: a newer instance of this team took over; not reconnecting', {})
    this.setState({ state: 'replaced', detail, connectedSince: null, conns: 0 })
    for (const s of this.slots) {
      if (s.timer) { clearTimeout(s.timer); s.timer = null }
      if (s.conn) { const c = s.conn; s.conn = null; this.closeConn(c, 1000, 'replaced', true) }
    }
  }

  private onGoaway(c: Conn, g: Goaway): void {
    this.o.log.info('relay goaway', { idx: c.idx, reason: g.reason })
    if (g.reason === 'replaced') { this.replaced(`replaced by instance ${g.by ?? 'unknown'}`); return }
    if (g.reason === 'suspended') return // the 4010 close follows
    // restart: a fresh connection right away; the old one finishes its streams (at most 60 s)
    const slot = this.slots[c.idx]
    if (slot.conn !== c) return
    c.current = false
    slot.conn = null
    slot.attempt = 0
    this.draining.add(c)
    const t0 = Date.now()
    const drain = setInterval(() => {
      if (!c.mux || c.mux.closed || c.mux.streams.size === 0 || Date.now() - t0 > 60_000) {
        clearInterval(drain)
        try { c.ws.close(1000, 'drained') } catch {}
        this.cleanup(c, 'drained')
      }
    }, 200)
    this.updateConnState()
    slot.timer = setTimeout(() => this.connect(c.idx), Math.round(Math.random() * 1000))
  }

  private onEvent(ev: RelayEvent): void {
    if (ev.type === 'instance_replaced' && ev.by !== this.instance) this.replaced(`replaced by instance ${ev.by}`)
    try { this.o.onEvent?.(ev, this.instance) } catch (e) { this.o.log.error('relay event handler failed', { err: e }) }
  }

  // ------------------------------------------------------------------ streams

  private onStream(s: Stream): void {
    this.stats.streams++
    if (s.meta.kind === 'ws') this.serveWs(s)
    else void this.serveHttp(s)
  }

  private buildRequest(meta: OpenMeta, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Request {
    const headers = new Headers()
    for (const [k, v] of meta.headers) headers.append(k, v)
    headers.set('host', meta.host)
    if (meta.kind === 'ws') { headers.set('upgrade', 'websocket'); headers.set('connection', 'Upgrade') }
    const init: RequestInit & { duplex?: 'half' } = { method: meta.method, headers, signal }
    if (body) { init.body = body; init.duplex = 'half' }
    return new Request(`${meta.proto}://${meta.host}${meta.path}`, init)
  }

  private async serveHttp(s: Stream): Promise<void> {
    const meta = s.meta
    const ac = new AbortController()
    const hasBody = meta.method !== 'GET' && meta.method !== 'HEAD'
    const body = hasBody ? streamBody(s) : null
    if (!hasBody) {
      s.onData = (b) => s.consumed(b.byteLength) // a GET with a body: drop it
      s.onEnd = () => {}
    }
    const bodyRst = s.onRst
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    s.onRst = (code, reason) => {
      bodyRst?.(code, reason)
      ac.abort(new Error(`relay stream reset (${code})`))
      reader?.cancel(`relay stream reset (${code})`).catch(() => {})
    }
    let req: Request
    try {
      req = this.buildRequest(meta, body, ac.signal)
    } catch {
      // headers this runtime won't take (e.g. non-ASCII values): the client's request is at fault, not the server
      s.respond({ status: 400, headers: [['content-type', 'application/json; charset=utf-8']] })
      void s.write(new TextEncoder().encode(JSON.stringify({ error: { code: 'bad_request', message: 'bad request headers' } })))
      s.end({ cancelUnread: true })
      return
    }
    let res: Response
    try {
      res = await this.o.fetch(req, { ip: meta.clientIp })
    } catch (e) {
      if (s.reset) return
      this.stats.httpErrors++
      this.o.log.error('relayed request failed', { err: e })
      res = Response.json({ error: { code: 'internal', message: 'internal error' } }, { status: 500 })
    }
    if (s.reset) { await res.body?.cancel().catch(() => {}); return }
    s.respond({ status: res.status, headers: responseHeaders(res.headers) })
    if (!res.body || meta.method === 'HEAD') { await res.body?.cancel().catch(() => {}); s.end({ cancelUnread: true }); return }
    reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (s.reset) return
        if (value.byteLength === 0) continue
        const p = s.write(value)
        if (p) await p
        if (s.reset) return
      }
      s.end({ cancelUnread: true })
    } catch (e) {
      if (!s.reset) {
        this.o.log.warn('relayed response body failed', { err: e })
        s.rst(RstCode.CANCEL, 'response body error')
      }
    }
  }

  private serveWs(s: Stream): void {
    const meta = s.meta
    const offered = (meta.headers.find(([k]) => k === 'sec-websocket-protocol')?.[1] ?? '').split(',').map((p) => p.trim()).filter(Boolean)
    if (!this.o.attachWs) {
      s.respond({ status: 503, headers: [['content-type', 'text/plain']] })
      s.end()
      return
    }
    const protocol = offered.includes(WS_PROTOCOL) ? WS_PROTOCOL : (offered[0] ?? '')
    let req: Request
    try {
      req = this.buildRequest(meta, null)
    } catch {
      s.respond({ status: 400, headers: [] })
      s.end()
      return
    }
    s.respond({ status: 101, headers: protocol ? [['sec-websocket-protocol', protocol]] : [] })
    const vws = new RelayWebSocket(s, protocol)
    let ok = false
    try {
      ok = this.o.attachWs(vws, req, { ip: meta.clientIp })
    } catch (e) {
      this.o.log.error('attaching a relayed WebSocket failed', { err: e })
    }
    if (!ok) vws.close(1013, 'realtime not available')
  }
}

/** Response headers as pairs, keeping every Set-Cookie separate. */
export function responseHeaders(h: Headers): HeaderList {
  const out: HeaderList = []
  h.forEach((v, k) => { if (k !== 'set-cookie') out.push([k, v]) })
  for (const c of h.getSetCookie()) out.push(['set-cookie', c])
  return out
}

/** a relay URL is ws(s)://host[:port]/connect; its registry API is http(s)://host[:port] */
export function relayApiBase(url: string): string {
  const u = new URL(url)
  const proto = u.protocol === 'wss:' ? 'https:' : 'http:'
  return `${proto}//${u.host}`
}
