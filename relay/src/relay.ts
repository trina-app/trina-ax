// The relay server (design tab 6 "연결: 팀 주소와 원격 접속", spike-relay/REPORT.md).
//
//   team server ──(2-4 authenticated control WebSockets, wss://relay.<domain>/connect)──► relay
//   browser ──https://<team>.<domain>/...──► relay ──(stream on a control connection)──► team server (app.fetch)
//
// Runs on Node 25 with node:http + ws: Bun.serve has no backpressure on streaming bodies (REPORT, "Bun problems").
// The same code runs in Bun for unit tests. The relay stores nothing it forwards and logs only team ids, byte
// counts and timestamps; the real client IP goes to the team server in the OPEN frame and nowhere else.
import http from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import {
  AUTH_MAX_SKEW_MS, AUTH_TIMEOUT_MS, ClientClose, ControlClose, DataFlag, FrameError, HDR, MAX_PAYLOAD, Mux, RstCode,
  SUPPORTED_VERSIONS, authSigningString, forwardRequestHeaders, forwardResponseHeaders, jsonPayload, parseAuth,
  parseOpenMeta, readWsClose, teamFromHost, verifyB64,
  type AuthOk, type HeaderList, type OpenMeta, type RelayEvent, type Stream,
} from '@mycel/shared/relay-protocol'
import { teamAddress, type RelayConfig } from './config.ts'
import { handleRegistryApi } from './api.ts'
import type { RelayLog } from './log.ts'
import { PAGE_STATUS, htmlPage, pageMessage, pickLang, type PageKind } from './pages.ts'
import { ipInRanges, unmapIp } from './proxies.ts'
import type { KeyRow, Registry, TeamRow } from './registry.ts'

export const RELAY_VERSION = '0.1.0'
/** biggest WebSocket message (one control-connection message carries one frame; a little room for batching) */
const MAX_CTL_MESSAGE = 4 * (HDR + MAX_PAYLOAD)
/** Node's `ws` sends message fragments (send with fin: false); Bun's built-in `ws` module does not */
const WS_FRAGMENTS = !process.versions.bun
const BUN_MAX_WS_MESSAGE = 16 * 1024 * 1024
/** registration rate-limit table: IPs remembered at most (memory only) */
const MAX_REGISTER_IPS = 50_000
/** relay -> browser socket: stop returning window while more than this is buffered */
const CLIENT_HIGH_WATER = 256 * 1024
/** relay -> team control socket */
const CTL_HIGH_WATER = 1024 * 1024
const NOTIFY_EVERY_MS = 60_000
const NAME_CACHE_MS = 2000
/** a previous instance counts as "live" (owner notified on takeover) if it sent anything this recently */
const LIVE_INSTANCE_MS = 25_000

interface Ctl {
  ws: WebSocket
  nonce: string
  authed: boolean
  team: TeamState | null
  keyId: string
  instance: string
  idx: number
  mux: Mux | null
  since: number
  /** draining (replaced / suspended / shutting down): no new streams */
  draining: boolean
  /** stall probe sent at (0 = none) */
  probeAt: number
  /** where the team server connected from (told to it in the handshake only, never logged) */
  ip: string | null
}

interface TeamState {
  id: string
  name: string
  instance: string | null
  conns: Set<Ctl>
  offlineAt: number | null
  waiters: Set<() => void>
  bytesIn: number
  bytesOut: number
  streams: number
  lastNotify: Map<string, number>
  rejected: number
  /** a live previous instance was replaced: tell the new one once it is connected */
  replacedPrevious: string | null
}

interface StreamTrack { s: Stream; ctl: Ctl; waitingHeadSince: number | null }

export interface RelayStats {
  uptimeS: number
  teams: Record<string, { instance: string | null; conns: { idx: number; streams: number; buffered: number; framesIn: number; framesOut: number }[]; bytesIn: number; bytesOut: number; streams: number }>
  clientSockets: number
  counters: Record<string, number>
}

export class RelayServer {
  readonly cfg: RelayConfig
  readonly registry: Registry
  readonly log: RelayLog
  readonly server: http.Server
  /** browser WebSockets (messages up to the client cap) */
  private wss: WebSocketServer
  /** team-server control connections: frames are at most 64 KB, so an unauthenticated peer can't make us buffer more */
  private ctlWss: WebSocketServer
  private teams = new Map<string, TeamState>()
  private clientSockets = new Set<WebSocket>()
  private tracks = new Set<StreamTrack>()
  private nameCache = new Map<string, { row: TeamRow | undefined; at: number }>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private startedAt = Date.now()
  private stopping = false
  private sweeps = 0
  private registerHits = new Map<string, number[]>()
  readonly counters = {
    ctlConnects: 0, ctlDrops: 0, silentDrops: 0, stallDrops: 0, authFail: 0, replaced: 0,
    http: 0, httpOffline: 0, ws: 0, wsOffline: 0, notifications: 0,
  }

  constructor(cfg: RelayConfig, registry: Registry, log: RelayLog) {
    this.cfg = cfg
    this.registry = registry
    this.log = log
    this.wss = new WebSocketServer({
      noServer: true, perMessageDeflate: false, maxPayload: Math.max(cfg.clientWsCap, 1024 * 1024),
      handleProtocols: (protocols, req) => this.handleProtocols(protocols, req),
    })
    this.ctlWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_CTL_MESSAGE })
    this.server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((e) => {
        // never an unhandled rejection (Node would exit and take every team offline)
        this.log.error('request_failed', { error: errorName(e) })
        try { if (!res.headersSent) this.sendPage(req, res, 'bad_gateway'); else res.destroy() } catch { res.destroy() }
      })
    })
    this.server.requestTimeout = 0
    this.server.headersTimeout = 30_000
    this.server.keepAliveTimeout = 65_000
    this.server.timeout = 0
    this.server.on('upgrade', (req, socket, head) => {
      this.onUpgrade(req, socket as Duplex, head).catch((e) => {
        this.log.error('upgrade_failed', { error: errorName(e) })
        try { (socket as Duplex).destroy() } catch {}
      })
    })
    this.server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n') } catch {} })
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen({ port: this.cfg.port, host: this.cfg.host, ...(process.platform === 'linux' ? { reusePort: true } : {}) }, () => resolve())
    })
    this.startedAt = Date.now()
    this.sweepTimer = setInterval(() => this.sweep(), 1000)
    const addr = this.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : this.cfg.port
    this.log.info('relay_started', { port, runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`, version: RELAY_VERSION })
    return port
  }

  /**
   * Graceful stop (SIGTERM / deploy): stop accepting, GOAWAY(restart) to every team server (they open new
   * connections at once), 1012 to browser WebSockets (they resume), let running HTTP streams finish up to graceMs.
   */
  async stop(graceMs = 10_000): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.server.close()
    for (const t of this.teams.values()) for (const c of t.conns) { c.draining = true; c.mux?.goaway({ reason: 'restart' }) }
    for (const ws of this.clientSockets) ws.close(ClientClose.RESTART, 'relay restarting')
    const until = Date.now() + graceMs
    while (Date.now() < until && [...this.tracks].some((t) => t.s.meta.kind === 'http' && !t.s.done)) await new Promise((r) => setTimeout(r, 50))
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    for (const t of this.teams.values()) for (const c of t.conns) c.ws.close(ClientClose.RESTART, 'relay restarting')
    for (const ws of this.clientSockets) ws.terminate()
    this.server.closeAllConnections()
    this.log.info('relay_stopped', {})
  }

  stats(): RelayStats {
    const teams: RelayStats['teams'] = {}
    for (const [id, t] of this.teams) {
      teams[id] = {
        instance: t.instance,
        conns: [...t.conns].map((c) => ({ idx: c.idx, streams: c.mux?.streams.size ?? 0, buffered: c.ws.bufferedAmount, framesIn: c.mux?.stats.framesIn ?? 0, framesOut: c.mux?.stats.framesOut ?? 0 })),
        bytesIn: t.bytesIn, bytesOut: t.bytesOut, streams: t.streams,
      }
    }
    return { uptimeS: Math.round((Date.now() - this.startedAt) / 1000), teams, clientSockets: this.clientSockets.size, counters: { ...this.counters } }
  }

  /** Is the team (by id) connected right now? */
  isOnline(teamId: string): boolean {
    const t = this.teams.get(teamId)
    return !!t && [...t.conns].some((c) => c.mux && !c.mux.closed && !c.draining)
  }

  // ------------------------------------------------------------------ routing

  private lookupName(name: string): TeamRow | undefined {
    const hit = this.nameCache.get(name)
    if (hit && Date.now() - hit.at < NAME_CACHE_MS) return hit.row
    const row = this.registry.teamByName(name)
    this.nameCache.set(name, { row, at: Date.now() })
    if (this.nameCache.size > 10_000) this.nameCache.clear()
    return row
  }

  /** null: the relay's own address (API, /connect); else the team name in the Host header. */
  private teamName(req: http.IncomingMessage): string | null {
    const name = teamFromHost(req.headers.host ?? '', this.cfg.domain)
    return name === 'relay' ? null : name
  }

  /**
   * The visitor's address: the client IP header (CF-Connecting-IP) only when the socket peer is a trusted proxy
   * (Cloudflare by default), else the socket peer. Someone who reaches the origin directly can send the header too;
   * believing it let them pick the address the team server uses for audit and its per-IP sign-in limits, and dodge
   * the relay's own per-IP registration limit.
   */
  private clientIp(req: http.IncomingMessage): string | null {
    const peer = req.socket.remoteAddress ?? undefined
    let ip: string | undefined
    if (this.cfg.clientIpHeader && ipInRanges(peer, this.cfg.trustedProxies)) {
      const v = req.headers[this.cfg.clientIpHeader]
      ip = (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim()
    }
    ip ??= peer
    if (!ip) return null
    ip = unmapIp(ip)
    return /^[0-9a-f.:]{2,64}$/i.test(ip) && isIP(ip) ? ip : null
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const name = this.teamName(req)
    if (name === null) {
      if (req.url === '/_stats' && this.cfg.stats && isLoopback(req.socket.remoteAddress)) return sendJson(res, 200, this.stats())
      return handleRegistryApi(this, req, res)
    }
    const row = this.lookupName(name)
    if (!row) return this.sendPage(req, res, 'team_unknown')
    if (row.status === 'suspended') return this.sendPage(req, res, 'team_suspended')
    const ctl = await this.connFor(row.id, req)
    if (res.destroyed || req.destroyed) return
    if (!ctl) {
      this.counters.httpOffline++
      const t = this.teams.get(row.id)
      const lastSeen = t?.offlineAt ?? (row.last_connected_at ? Date.parse(row.last_connected_at) : null)
      return this.sendPage(req, res, this.teams.get(row.id)?.conns.size ? 'team_busy' : 'team_offline', lastSeen ? Date.now() - lastSeen : null)
    }
    const meta = this.meta(req, 'http')
    if (!meta) { res.shouldKeepAlive = false; return this.sendPage(req, res, 'bad_request') }
    this.proxyHttp(req, res, ctl, meta)
  }

  /** A live control connection for the team; waits up to the restart hold for one to appear. */
  private async connFor(teamId: string, req: http.IncomingMessage): Promise<Ctl | null> {
    const now = Date.now()
    const t = this.teams.get(teamId)
    let c = t ? this.pick(t) : null
    if (c) return c
    const holdUntil = Math.max(this.startedAt + this.cfg.holdMs, (t?.offlineAt ?? 0) + this.cfg.holdMs, t && t.conns.size ? now + this.cfg.holdMs : 0)
    if (holdUntil <= now) return null
    const ts = this.teamState(teamId, '')
    return new Promise<Ctl | null>((resolve) => {
      const done = () => {
        c = this.pick(ts)
        if (!c && Date.now() < holdUntil && !req.destroyed) return
        clearTimeout(timer)
        ts.waiters.delete(done)
        req.off('close', done)
        resolve(c)
      }
      const timer = setTimeout(() => { ts.waiters.delete(done); req.off('close', done); resolve(this.pick(ts)) }, holdUntil - now)
      ts.waiters.add(done)
      req.once('close', done)
    })
  }

  private pick(t: TeamState): Ctl | null {
    let best: Ctl | null = null
    for (const c of t.conns) {
      if (!c.mux || c.mux.closed || c.draining || c.probeAt) continue
      if (c.mux.streams.size >= this.cfg.maxStreamsPerConn) continue
      if (!best || c.mux.streams.size < best.mux!.streams.size) best = c
    }
    return best
  }

  private teamState(id: string, name: string): TeamState {
    let t = this.teams.get(id)
    if (!t) {
      t = { id, name, instance: null, conns: new Set(), offlineAt: null, waiters: new Set(), bytesIn: 0, bytesOut: 0, streams: 0, lastNotify: new Map(), rejected: 0, replacedPrevious: null }
      this.teams.set(id, t)
    }
    if (name) t.name = name
    return t
  }

  sendPage(req: http.IncomingMessage, res: http.ServerResponse, kind: PageKind, offlineForMs: number | null = null): void {
    if (res.headersSent) { res.destroy(); return }
    const lang = pickLang(req.headers)
    const status = PAGE_STATUS[kind]
    const wantsHtml = !(req.url ?? '').startsWith('/api/') && /text\/html/.test(req.headers.accept ?? '')
    const extra: Record<string, string> = { 'cache-control': 'no-store', 'x-relay-error': kind }
    if (status === 503) extra['retry-after'] = '5'
    if (wantsHtml) {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extra })
      res.end(htmlPage(kind, lang, offlineForMs))
      return
    }
    // codes from the app's ErrorCode list (shared/src/api/common.ts), so the web client handles relay answers alike
    const code = kind === 'team_unknown' || kind === 'not_found' ? 'not_found' : kind === 'team_suspended' ? 'forbidden' : kind === 'bad_request' || kind === 'request_timeout' ? 'bad_request' : 'unavailable'
    sendJson(res, status, { error: { code, message: pageMessage(kind, lang, offlineForMs), reason: kind, ...(status === 503 ? { retryAfter: 5 } : {}) } }, extra)
  }

  /**
   * The OPEN metadata of a request, or null when the team server could not accept it (absolute-form or `*` target,
   * too many headers, a head over the OPEN size limit). Checked here so a bad request gets a 400 from the relay
   * instead of reaching the team server.
   */
  private meta(req: http.IncomingMessage, kind: 'http' | 'ws'): OpenMeta | null {
    const m: OpenMeta = {
      kind,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      host: (req.headers.host ?? '').toLowerCase(),
      proto: this.cfg.publicProto,
      headers: forwardRequestHeaders(req.rawHeaders, kind),
      clientIp: this.clientIp(req),
    }
    try {
      parseOpenMeta(m)
      jsonPayload(m)
      return m
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------ HTTP proxy

  private proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, ctl: Ctl, meta: OpenMeta): void {
    this.counters.http++
    const team = ctl.team!
    const s = ctl.mux!.open(meta)
    const track: StreamTrack = { s, ctl, waitingHeadSince: null }
    this.tracks.add(track)
    team.streams++
    const t0 = Date.now()
    let reqBytes = 0
    let resBytes = 0
    let owed = 0
    let finished = false
    let reqEnded = bodyless(req)
    let timer: ReturnType<typeof setTimeout> | null = null
    // a request body that stops arriving (slow-loris upload) would hold a stream on the team server forever
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }
    const armIdle = () => {
      clearIdle()
      idleTimer = setTimeout(() => {
        idleTimer = null
        if (s.done || s.endQueued) return
        s.rst(RstCode.TIMEOUT, 'request body stalled')
        if (!res.headersSent) { res.shouldKeepAlive = false; this.sendPage(req, res, 'request_timeout') } else res.destroy()
        finish()
      }, this.cfg.bodyIdleMs)
    }
    const armHeadTimer = () => {
      track.waitingHeadSince = Date.now()
      timer = setTimeout(() => {
        if (s.head || s.done) return
        s.rst(RstCode.TIMEOUT, 'no response head')
        this.sendPage(req, res, 'team_timeout')
        finish()
      }, this.cfg.responseTimeoutMs)
    }
    const finish = () => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      clearIdle()
      this.tracks.delete(track)
      team.streams--
      team.bytesIn += reqBytes
      team.bytesOut += resBytes
      this.log.info('stream', { team: team.id, kind: 'http', bytesIn: reqBytes, bytesOut: resBytes, ms: Date.now() - t0 })
    }

    // request body -> DATA, paced by the stream window (pausing req pushes back on the client's TCP connection)
    if (bodyless(req)) { s.end(); armHeadTimer() } else {
      armIdle()
      req.on('data', (chunk: Buffer) => {
        reqBytes += chunk.byteLength
        const p = s.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        if (p) {
          // waiting for the team server's window is not the client stalling
          clearIdle()
          req.pause()
          void p.then(() => { if (!finished && !s.done) armIdle(); req.resume() })
        } else if (!finished) {
          armIdle()
        }
      })
      req.on('end', () => { reqEnded = true; clearIdle(); s.end(); if (!finished) armHeadTimer() })
    }

    s.onResponse = (h) => {
      track.waitingHeadSince = null
      if (timer) { clearTimeout(timer); timer = null }
      if (res.headersSent || res.destroyed) return
      if (h.status < 200) {
        // 1xx heads can't be relayed as the final answer of an HTTP stream (a 101 would hijack the client connection)
        s.rst(RstCode.PROTOCOL, 'informational status on an HTTP stream')
        this.sendPage(req, res, 'bad_gateway')
        finish()
        return
      }
      // answered before the request body was all here (e.g. 401 / 413 on an upload): the client may stop sending
      // the body, so this connection can't safely carry another request
      if (!reqEnded) res.shouldKeepAlive = false
      const flat: string[] = []
      for (const [k, v] of forwardResponseHeaders(h.headers)) flat.push(k, k.toLowerCase() === 'set-cookie' ? hostOnlyCookie(v) : v)
      try {
        res.writeHead(h.status, flat)
      } catch {
        s.rst(RstCode.PROTOCOL, 'bad response head')
        this.sendPage(req, res, 'bad_gateway')
        finish()
      }
    }
    // response DATA -> client. Window goes back only once the client socket took the bytes.
    s.onData = (b) => {
      resBytes += b.byteLength
      if (res.write(b)) s.consumed(b.byteLength)
      else owed += b.byteLength
    }
    res.on('drain', () => { if (owed) { const n = owed; owed = 0; s.consumed(n) } })
    s.onEnd = () => {
      if (!res.headersSent) { this.sendPage(req, res, 'bad_gateway'); finish(); return }
      res.end()
    }
    s.onRst = (code) => {
      if (!res.headersSent) {
        this.sendPage(req, res, code === RstCode.TIMEOUT ? 'team_timeout' : code === RstCode.CONN_LOST || code === RstCode.REPLACED ? 'team_connection_lost' : code === RstCode.REFUSED ? 'team_busy' : 'bad_gateway')
      } else if (!res.writableEnded) {
        res.destroy() // mid-body: the client must see a truncated response, not a complete one
      }
      // else: the response is complete and the team server just doesn't want the rest of the request body; the
      // reset stream discards it (req keeps flowing) and the client gets its whole answer
      finish()
    }
    res.on('finish', () => finish())
    res.on('close', () => {
      if (!res.writableFinished && !s.done) s.rst(RstCode.CANCEL, 'client went away')
      finish()
    })
  }

  // ------------------------------------------------------------------ upgrades

  private async onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => {})
    if (this.stopping) { socket.destroy(); return }
    const name = this.teamName(req)
    if (name === null) {
      if ((req.url ?? '').split('?')[0] === '/connect') {
        this.ctlWss.handleUpgrade(req, socket, head, (ws) => this.onControl(ws, this.clientIp(req)))
        return
      }
      rawHttp(socket, 404)
      return
    }
    const row = this.lookupName(name)
    if (!row) { rawHttp(socket, 404); return }
    if (row.status === 'suspended') { rawHttp(socket, 403); return }
    const ctl = await this.connFor(row.id, req)
    if (socket.destroyed) return
    if (!ctl) {
      // browsers can't read a status on a failed upgrade: accept, then close 1013 so the client knows why
      this.counters.wsOffline++
      this.wss.handleUpgrade(req, socket, head, (ws) => ws.close(ClientClose.TEAM_OFFLINE, 'team_offline'))
      return
    }
    const meta = this.meta(req, 'ws')
    if (!meta) { rawHttp(socket, 400); return }
    this.proxyWs(req, socket, head, ctl, meta)
  }

  private proxyWs(req: http.IncomingMessage, socket: Duplex, head: Buffer, ctl: Ctl, meta: OpenMeta): void {
    this.counters.ws++
    const team = ctl.team!
    const s = ctl.mux!.open(meta)
    const track: StreamTrack = { s, ctl, waitingHeadSince: Date.now() }
    this.tracks.add(track)
    team.streams++
    const t0 = Date.now()
    let inBytes = 0
    let outBytes = 0
    let ws: WebSocket | null = null
    let finished = false
    const early: { b: Uint8Array; flags: number }[] = []
    const finish = () => {
      if (finished) return
      finished = true
      this.tracks.delete(track)
      team.streams--
      team.bytesIn += inBytes
      team.bytesOut += outBytes
      this.log.info('stream', { team: team.id, kind: 'ws', bytesIn: inBytes, bytesOut: outBytes, ms: Date.now() - t0 })
    }
    const openTimer = setTimeout(() => {
      if (s.head || s.done) return
      s.rst(RstCode.TIMEOUT, 'no answer to the WebSocket')
      rawHttp(socket, 504)
      finish()
    }, this.cfg.wsOpenTimeoutMs)
    const gone = () => { if (!ws) { clearTimeout(openTimer); s.rst(RstCode.CANCEL, 'client went away'); finish() } }
    socket.once('close', gone)

    s.onData = (b, flags) => { early.push({ b, flags }) }
    s.onEnd = () => { if (!ws) { clearTimeout(openTimer); rawHttp(socket, 502); finish() } }
    s.onRst = () => { if (!ws) { clearTimeout(openTimer); rawHttp(socket, 502); finish() } }
    s.onResponse = (h) => {
      clearTimeout(openTimer)
      track.waitingHeadSince = null
      if (h.status !== 101) {
        rawHttp(socket, h.status)
        s.rst(RstCode.CANCEL, 'refused')
        finish()
        return
      }
      socket.off('close', gone)
      // ws asks handleProtocols() for the subprotocol: the one the team server accepted
      this.wss.handleUpgrade(req, socket, head, (w) => {
        ws = w
        this.attachClient(w, s, (n) => { inBytes += n }, (n) => { outBytes += n }, finish)
        for (const e of early.splice(0)) s.onData?.(e.b, e.flags)
      })
    }
    this.pendingProtocols.set(req, () => s.head?.headers.find(([k]) => k.toLowerCase() === 'sec-websocket-protocol')?.[1] ?? false)
  }

  /** ws handleProtocols hook: the subprotocol the team server picked for this request */
  private pendingProtocols = new WeakMap<http.IncomingMessage, () => string | false>()
  private handleProtocols(protocols: Set<string>, req: http.IncomingMessage): string | false {
    const f = this.pendingProtocols.get(req)
    if (f) return f()
    // offline close: echo the first offered protocol so the browser completes the handshake and sees the close code
    const [first] = protocols
    return first ?? false
  }

  private attachClient(ws: WebSocket, s: Stream, countIn: (n: number) => void, countOut: (n: number) => void, finish: () => void): void {
    this.clientSockets.add(ws)
    let frag: Uint8Array[] = []
    let fragBytes = 0
    let owed = 0
    let drainPoll: ReturnType<typeof setInterval> | null = null
    let alive = true
    const pinger = setInterval(() => {
      if (!alive) { ws.terminate(); return }
      alive = false
      try { ws.ping() } catch {}
    }, this.cfg.clientPingMs)
    ws.on('pong', () => { alive = true })

    const credit = (n: number) => {
      if (ws.bufferedAmount < CLIENT_HIGH_WATER) { s.consumed(n); return }
      owed += n
      // `ws` has no drain event: poll only while this client is behind
      drainPoll ??= setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) { clearInterval(drainPoll!); drainPoll = null; return }
        if (ws.bufferedAmount < CLIENT_HIGH_WATER) { clearInterval(drainPoll!); drainPoll = null; const k = owed; owed = 0; s.consumed(k) }
      }, 20)
    }
    s.onData = (b, flags) => {
      if (flags & DataFlag.WS_CLOSE) {
        const { code, reason } = readWsClose(b)
        closeClient(ws, code, reason)
        return
      }
      const binary = !!(flags & DataFlag.WS_BINARY)
      const last = !(flags & DataFlag.WS_CONT)
      countOut(b.byteLength)
      if (WS_FRAGMENTS) {
        // each piece goes out as a WebSocket fragment at once (fin on the last piece): the relay never assembles a
        // message, and every piece returns its window like any other bytes once the browser socket took it
        ws.send(Buffer.from(b.buffer, b.byteOffset, b.byteLength), { binary, fin: last })
        credit(b.byteLength)
        return
      }
      // Bun's built-in `ws` ignores `fin` (unit tests run the relay in Bun): assemble, bounded
      frag.push(b)
      fragBytes += b.byteLength
      if (fragBytes > BUN_MAX_WS_MESSAGE) { s.rst(RstCode.FLOW_CONTROL, 'message too large'); ws.close(ClientClose.TOO_BIG, 'message too large'); return }
      if (!last) { s.consumed(b.byteLength); return }
      const msg = Buffer.concat(frag)
      frag = []
      fragBytes = 0
      ws.send(msg, { binary })
      credit(b.byteLength)
    }
    s.onEnd = () => { if (ws.readyState === WebSocket.OPEN) ws.close(ClientClose.NORMAL, '') }
    s.onRst = (code) => {
      const c = code === RstCode.FLOW_CONTROL ? ClientClose.TOO_SLOW
        : code === RstCode.CONN_LOST || code === RstCode.REPLACED || code === RstCode.TEAM_OFFLINE ? ClientClose.RESTART
        : ClientClose.INTERNAL
      closeClient(ws, c, c === ClientClose.RESTART ? 'team connection lost' : 'stream reset')
    }
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (s.done) return
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      countIn(buf.byteLength)
      void s.write(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), isBinary ? DataFlag.WS_BINARY : 0)
      // a browser socket can't be paused: cap what may queue for the team server
      if (s.outBytes > this.cfg.clientWsCap) {
        s.rst(RstCode.FLOW_CONTROL, 'client sent too much')
        ws.close(ClientClose.TOO_BIG, 'too much data')
      }
    })
    ws.on('close', (code: number, reason: Buffer) => {
      this.clientSockets.delete(ws)
      clearInterval(pinger)
      if (drainPoll) clearInterval(drainPoll)
      if (!s.done && !s.endQueued) {
        s.wsClose(code === 1005 || code === 1006 ? 1001 : code, reason.toString('utf8'))
        // the team server answers with END; don't wait for it forever
        setTimeout(() => { if (!s.done) s.rst(RstCode.CANCEL, 'client closed') }, 5000).unref?.()
      }
      finish()
    })
    ws.on('error', () => {})
  }

  // ------------------------------------------------------------------ control connections

  private onControl(ws: WebSocket, ip: string | null): void {
    const c: Ctl = { ws, nonce: randomBytes(32).toString('base64'), authed: false, team: null, keyId: '', instance: '', idx: 0, mux: null, since: Date.now(), draining: false, probeAt: 0, ip }
    ws.send(JSON.stringify({ t: 'challenge', vs: SUPPORTED_VERSIONS, nonce: c.nonce, ts: Date.now() }))
    const authTimer = setTimeout(() => { if (!c.authed) ws.close(ControlClose.AUTH_FAILED, 'auth timeout') }, AUTH_TIMEOUT_MS)
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!c.authed) {
        clearTimeout(authTimer)
        if (isBinary) { ws.close(ControlClose.PROTOCOL_ERROR, 'auth first'); return }
        this.auth(c, buf.toString('utf8'))
        return
      }
      if (!isBinary || !c.mux) { ws.close(ControlClose.PROTOCOL_ERROR, 'binary frames only'); return }
      try {
        c.mux.onMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
        if (c.probeAt) c.probeAt = 0
      } catch (e) {
        this.log.warn('protocol_error', { team: c.team?.id ?? null, error: e instanceof FrameError ? e.message : 'internal' })
        ws.close(ControlClose.PROTOCOL_ERROR, 'protocol error')
      }
    })
    ws.on('close', (code: number) => { clearTimeout(authTimer); this.dropCtl(c, `close ${code}`) })
    ws.on('error', () => {})
  }

  private reject(c: Ctl, code: number, err: 'auth_failed' | 'version' | 'suspended' | 'protocol', message: string): void {
    try { c.ws.send(JSON.stringify({ t: 'error', code: err, message })) } catch {}
    c.ws.close(code, message.slice(0, 120))
  }

  private auth(c: Ctl, raw: string): void {
    let m
    try { m = parseAuth(JSON.parse(raw)) } catch { this.reject(c, ControlClose.PROTOCOL_ERROR, 'protocol', 'bad auth message'); return }
    if (!SUPPORTED_VERSIONS.includes(m.v)) { this.reject(c, ControlClose.VERSION, 'version', `relay speaks protocol ${SUPPORTED_VERSIONS.join(',')}`); return }
    const row = this.registry.team(m.team)
    // 'unknown team' (the registry has no such team: the team server may register again) vs 'team released'
    if (!row) { this.counters.authFail++; this.reject(c, ControlClose.AUTH_FAILED, 'auth_failed', 'unknown team'); return }
    if (row.status === 'released') { this.counters.authFail++; this.reject(c, ControlClose.AUTH_FAILED, 'auth_failed', 'team released'); return }
    if (row.status === 'suspended') { this.reject(c, ControlClose.SUSPENDED, 'suspended', 'team suspended'); return }
    const key: KeyRow | undefined = this.registry.currentKey(row.id)
    const fresh = Math.abs(Date.now() - m.ts) <= AUTH_MAX_SKEW_MS
    if (!key || !fresh || !verifyB64(key.public_key, authSigningString(m.team, m.instance, c.nonce, m.ts), m.sig)) {
      this.counters.authFail++
      this.log.warn('auth_failed', { team: row.id, reason: !fresh ? 'clock' : 'signature' })
      const t = this.teams.get(row.id)
      if (t && fresh) { t.rejected++; this.notify(t, { type: 'key_rejected', at: Date.now(), count: t.rejected }) }
      this.reject(c, ControlClose.AUTH_FAILED, 'auth_failed', fresh ? 'signature does not match the registered key' : 'clock skew too large')
      return
    }
    const t = this.teamState(row.id, row.name)
    if ([...t.conns].filter((o) => o.instance === m.instance && !o.draining).length >= this.cfg.maxConnsPerTeam) {
      this.reject(c, ControlClose.PROTOCOL_ERROR, 'protocol', 'too many control connections')
      return
    }
    // newer instance wins (same key): the old one gets GOAWAY(replaced) + 4009 and must not reconnect
    if (t.instance && t.instance !== m.instance && t.conns.size) {
      const live = [...t.conns].some((o) => o.mux && Date.now() - o.mux.lastRecv < LIVE_INSTANCE_MS)
      const previous = t.instance
      this.counters.replaced++
      this.log.warn('instance_replaced', { team: t.id, live })
      for (const old of t.conns) {
        old.draining = true
        if (live) old.mux?.event({ type: 'instance_replaced', by: m.instance, previous, at: Date.now() })
        old.mux?.goaway({ reason: 'replaced', by: m.instance })
        setTimeout(() => old.ws.close(ControlClose.REPLACED, 'replaced by a newer instance'), 50)
      }
      t.replacedPrevious = live ? previous : null
    }
    t.instance = m.instance
    c.authed = true
    c.team = t
    c.keyId = key.id
    c.instance = m.instance
    c.idx = m.conn
    c.mux = new Mux(
      { send: (b) => c.ws.send(b), buffered: () => c.ws.bufferedAmount },
      { role: 'relay', initialWindow: this.cfg.initialWindow, highWater: CTL_HIGH_WATER, maxStreams: this.cfg.maxStreamsPerConn },
    )
    const sock = (c.ws as unknown as { _socket?: { on(ev: string, f: () => void): void } })._socket
    sock?.on('drain', () => c.mux?.pump())
    t.conns.add(c)
    this.counters.ctlConnects++
    this.registry.touchConnected(row.id, key.id)
    const wasOffline = t.offlineAt
    t.offlineAt = null
    const ok: AuthOk = {
      t: 'ok', v: m.v, initialWindow: this.cfg.initialWindow, maxStreams: this.cfg.maxStreamsPerConn, pingMs: Math.min(20_000, Math.floor(this.cfg.silenceMs / 2)), silenceMs: this.cfg.silenceMs,
      address: teamAddress(this.cfg, row.name), name: row.name, conns: [...t.conns].filter((o) => o.instance === m.instance).length,
      ...(c.ip ? { seenIp: c.ip } : {}),
    }
    c.ws.send(JSON.stringify(ok))
    this.log.info('ctl_connected', { team: t.id, idx: c.idx, conns: t.conns.size, offlineMs: wasOffline ? Date.now() - wasOffline : null })
    if (t.replacedPrevious) {
      this.counters.notifications++
      c.mux.event({ type: 'instance_replaced', by: m.instance, previous: t.replacedPrevious, at: Date.now() })
      t.replacedPrevious = null
    }
    for (const w of [...t.waiters]) w()
  }

  /** Control-plane notification to the team server (it shows it to the owner). At most one per type per minute. */
  private notify(t: TeamState, ev: RelayEvent): void {
    const last = t.lastNotify.get(ev.type) ?? 0
    if (Date.now() - last < NOTIFY_EVERY_MS) return
    const c = this.pick(t) ?? [...t.conns].find((o) => o.mux && !o.mux.closed)
    if (!c?.mux) return
    t.lastNotify.set(ev.type, Date.now())
    this.counters.notifications++
    c.mux.event(ev)
  }

  private dropCtl(c: Ctl, why: string): void {
    const t = c.team
    if (!c.authed || !t || !t.conns.has(c)) return
    t.conns.delete(c)
    this.counters.ctlDrops++
    c.mux?.close(why)
    this.log.info('ctl_dropped', { team: t.id, idx: c.idx, upS: Math.round((Date.now() - c.since) / 1000), conns: t.conns.size })
    if (!t.conns.size) {
      t.offlineAt = Date.now()
      this.log.warn('team_offline', { team: t.id })
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const t of this.teams.values()) {
      for (const c of t.conns) {
        if (!c.mux) continue
        // half-open detection: nothing at all for silenceMs
        if (now - c.mux.lastRecv > this.cfg.silenceMs) {
          this.counters.silentDrops++
          this.log.warn('ctl_silent', { team: t.id, idx: c.idx, silentMs: now - c.mux.lastRecv })
          this.dropCtl(c, 'silence')
          c.ws.terminate()
          continue
        }
        if (c.probeAt && now - c.probeAt > this.cfg.pongTimeoutMs && c.mux.lastRecv < c.probeAt) {
          this.counters.stallDrops++
          this.log.warn('ctl_stalled', { team: t.id, idx: c.idx })
          this.dropCtl(c, 'no pong')
          c.ws.close(ControlClose.NO_RESPONSE, 'no response')
          setTimeout(() => c.ws.terminate(), 1000).unref?.()
        }
      }
    }
    // stall probes: a stream waiting for its head while its connection has been quiet -> PING that connection,
    // stop giving it new streams until something comes back
    for (const tr of this.tracks) {
      const c = tr.ctl
      if (!c.mux || c.probeAt || tr.waitingHeadSince === null) continue
      if (now - tr.waitingHeadSince > this.cfg.stallMs && now - c.mux.lastRecv > this.cfg.stallMs) {
        c.probeAt = now
        c.mux.ping()
      }
    }
    // registry changes: suspended teams and rotated keys lose their connections
    if (++this.sweeps % 5 === 0) {
      for (const t of this.teams.values()) {
        if (!t.conns.size) continue
        const row = this.registry.team(t.id)
        const key = this.registry.currentKey(t.id)
        for (const c of t.conns) {
          if (row?.status === 'suspended') { c.draining = true; c.mux?.goaway({ reason: 'suspended' }); c.ws.close(ControlClose.SUSPENDED, 'team suspended') }
          else if (!row || row.status === 'released' || key?.id !== c.keyId) { c.draining = true; c.ws.close(ControlClose.AUTH_FAILED, 'key revoked') }
        }
      }
      for (const [ip, hits] of this.registerHits) if (!hits.some((h) => now - h < 3600_000)) this.registerHits.delete(ip)
    }
  }

  /** In-memory rate limit for registrations (IPs are never stored or logged). */
  allowRegistration(req: http.IncomingMessage): boolean {
    const ip = this.clientIp(req) ?? 'unknown'
    const now = Date.now()
    const hits = (this.registerHits.get(ip) ?? []).filter((h) => now - h < 3600_000)
    if (hits.length >= this.cfg.registerPerIpPerHour) { this.registerHits.set(ip, hits); return false }
    hits.push(now)
    // bounded: a flood from many addresses must not grow this table without limit (drop the oldest entries)
    if (!this.registerHits.has(ip) && this.registerHits.size >= MAX_REGISTER_IPS) {
      const first = this.registerHits.keys().next().value
      if (first !== undefined) this.registerHits.delete(first)
    }
    this.registerHits.set(ip, hits)
    return true
  }

  /** after a rename / release / rotation through the API */
  invalidateNames(): void { this.nameCache.clear() }

  /** Close every connection of a team (release / key rotation). */
  disconnectTeam(teamId: string, code: number, reason: string): void {
    const t = this.teams.get(teamId)
    if (!t) return
    for (const c of t.conns) { c.draining = true; c.ws.close(code, reason) }
  }
}

/**
 * A team server's Set-Cookie made host-only: every team address shares the parent domain, so a Domain attribute
 * (Domain=treesoop.com) would let one team's server set cookies for every other team. Design tab 6: cookies are
 * __Host- only; this strips Domain at the relay as well.
 */
export function hostOnlyCookie(v: string): string {
  return v.split(';').filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part)).join(';')
}

/** An error's code or class name only: messages can quote request details (header names, values) the log must not hold. */
function errorName(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown'
  return (e as Error & { code?: string }).code ?? e.name
}

function bodyless(req: http.IncomingMessage): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && !req.headers['content-length'] && !req.headers['transfer-encoding']
}

function closeClient(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return
  const valid = (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)
  try { ws.close(valid ? code : ClientClose.INTERNAL, reason.slice(0, 120)) } catch { ws.terminate() }
}

export function isLoopback(a: string | undefined): boolean {
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

export function sendJson(res: http.ServerResponse, status: number, o: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return }
  const body = JSON.stringify(o)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', ...extra })
  res.end(body)
}

const REASONS: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 426: 'Upgrade Required', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' }
function rawHttp(socket: Duplex, status: number): void {
  if (socket.destroyed) return
  try { socket.end(`HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`) } catch { socket.destroy() }
}

export type { HeaderList }
