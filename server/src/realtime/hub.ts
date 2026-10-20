// Realtime hub (tab 4 "WebSocket 이벤트"): one socket per signed-in window, per-user seq inside a server epoch,
// a memory ring buffer for resume, merged text deltas, window-targeted events (browser.call), slow-client and
// keep-alive handling. Transport-agnostic: Bun WebSockets (routes/ws.ts) and the relay client's virtual sockets
// both come in through attach().
import {
  ClientFrame, WS_BEARER_PREFIX, WS_MAX_BUFFERED_BYTES, WS_PING_INTERVAL_MS, WS_REPLAY_MIN_EVENTS, WS_REPLAY_MIN_MS,
  WsClose, WsConnectQuery, type ControlFrame, type ServerEvent, type ServerEventInput,
} from '@mycel/shared/api'
import type { AuthInfo, RealtimeConn, RealtimeHub, RequestInfo } from '../services'
import type { AppContext } from '../context'
import { originAllowed } from '../http/middleware'

/** Hard caps on top of the contract's "at least 2000 events / 5 minutes" (memory stays bounded per person). */
export const REPLAY_MAX_EVENTS = 20_000
export const REPLAY_MAX_BYTES = 16 * 1024 * 1024
/** Open windows per person; past this the oldest one is closed (a team member can't pile up sockets). */
export const MAX_SOCKETS_PER_USER = 50
/** Merged delta entries stop growing past this (a new entry starts). */
const MAX_MERGED_DELTA = 256 * 1024

interface Entry {
  /** first seq this entry stands for (merged deltas cover firstSeq..seq) */
  firstSeq: number
  seq: number
  at: number
  ev: ServerEvent
  /** only this window receives it (browser.call, browser_site requests) */
  window: string | null
  bytes: number
  /** browser.call acknowledged by its window: not re-sent on resume */
  acked?: boolean
}

interface Socket {
  conn: RealtimeConn
  userId: string
  windowId: string
  sessionId: string
  /** set while replaying; live events are queued behind the replay */
  ready: boolean
  closed: boolean
}

interface UserState {
  seq: number
  buffer: Entry[]
  bytes: number
  sockets: Map<string, Socket>
  lastActive: number
}

type SessionEndReason = Parameters<RealtimeHub['disconnectUser']>[1]

export type ClientFrameHandler = (s: { userId: string; windowId: string }, f: ClientFrame) => void
export type WindowListener = (userId: string, windowId: string, state: 'open' | 'closed') => void

export interface HubOptions {
  pingIntervalMs?: number
  replayMinEvents?: number
  replayMinMs?: number
  maxBufferedBytes?: number
  now?: () => number
}

export class Hub implements RealtimeHub {
  private users = new Map<string, UserState>()
  private pinger: ReturnType<typeof setInterval> | null = null
  private sweeper: ReturnType<typeof setInterval> | null = null
  private frameHandlers: ClientFrameHandler[] = []
  private windowListeners: WindowListener[] = []
  private o: Required<HubOptions>
  private stopping = false

  constructor(private ctx: AppContext, o: HubOptions = {}) {
    this.o = {
      pingIntervalMs: o.pingIntervalMs ?? WS_PING_INTERVAL_MS,
      replayMinEvents: o.replayMinEvents ?? WS_REPLAY_MIN_EVENTS,
      replayMinMs: o.replayMinMs ?? WS_REPLAY_MIN_MS,
      maxBufferedBytes: o.maxBufferedBytes ?? WS_MAX_BUFFERED_BYTES,
      now: o.now ?? Date.now,
    }
    this.pinger = setInterval(() => this.pingAll(), this.o.pingIntervalMs)
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    ;(this.pinger as { unref?: () => void }).unref?.()
    ;(this.sweeper as { unref?: () => void }).unref?.()
  }

  // ---------------- publishing ----------------
  publish(userId: string, ev: ServerEventInput): void { this.emit(userId, ev, null) }

  /** Send to one window of a person only (still buffered, filtered on resume). */
  publishTo(userId: string, windowId: string, ev: ServerEventInput): number { return this.emit(userId, ev, windowId) }

  publishEach(build: (userId: string) => ServerEventInput | null): void {
    for (const userId of [...this.users.keys()]) {
      let ev: ServerEventInput | null = null
      try { ev = build(userId) } catch (e) { this.ctx.log.error('publishEach build failed', { err: e, user: userId }) }
      if (ev) this.publish(userId, ev)
    }
  }

  /** Mark a buffered browser.call as received by its window (not re-sent on resume). */
  ackBrowserCall(userId: string, callId: string) {
    const u = this.users.get(userId)
    if (!u) return
    for (let i = u.buffer.length - 1; i >= 0; i--) {
      const e = u.buffer[i]!
      if (e.ev.type === 'browser.call' && e.ev.data.call.callId === callId) { e.acked = true; return }
    }
  }

  private state(userId: string): UserState {
    let u = this.users.get(userId)
    if (!u) { u = { seq: 0, buffer: [], bytes: 0, sockets: new Map(), lastActive: this.o.now() }; this.users.set(userId, u) }
    return u
  }

  private emit(userId: string, input: ServerEventInput, window: string | null): number {
    const u = this.state(userId)
    const now = this.o.now()
    const seq = ++u.seq
    const ev = { ...input, seq, at: now } as ServerEvent
    const json = JSON.stringify(ev)
    this.remember(u, ev, window, json.length, now)
    for (const s of u.sockets.values()) {
      if (!s.ready || s.closed) continue
      if (window && s.windowId !== window) continue
      this.send(s, json)
    }
    return seq
  }

  private remember(u: UserState, ev: ServerEvent, window: string | null, bytes: number, now: number) {
    const last = u.buffer[u.buffer.length - 1]
    if (ev.type === 'message.delta' && last && last.ev.type === 'message.delta' && last.window === window
      && last.ev.data.messageId === ev.data.messageId && last.ev.data.offset + last.ev.data.text.length === ev.data.offset
      && last.ev.data.text.length + ev.data.text.length <= MAX_MERGED_DELTA) {
      // one entry per run of consecutive deltas of the same message (tab 4): it takes the newest seq
      const merged = { ...last.ev, seq: ev.seq, at: ev.at, data: { ...last.ev.data, text: last.ev.data.text + ev.data.text } } as ServerEvent
      u.bytes += ev.data.text.length
      last.ev = merged
      last.seq = ev.seq
      last.at = ev.at
      last.bytes += ev.data.text.length
    } else {
      u.buffer.push({ firstSeq: ev.seq, seq: ev.seq, at: now, ev, window, bytes })
      u.bytes += bytes
    }
    this.prune(u, now)
  }

  private prune(u: UserState, now: number) {
    while (u.buffer.length) {
      const first = u.buffer[0]!
      const old = u.buffer.length > this.o.replayMinEvents && now - first.at >= this.o.replayMinMs
      const over = u.buffer.length > REPLAY_MAX_EVENTS || u.bytes > REPLAY_MAX_BYTES
      if (!old && !over) break
      u.buffer.shift()
      u.bytes -= first.bytes
    }
  }

  // ---------------- connections ----------------
  /** Authenticate and register a connection (direct WebSocket or relay stream). */
  async attach(conn: RealtimeConn, req: Request, info: RequestInfo): Promise<void> {
    let url: URL
    try { url = new URL(req.url) } catch { conn.close(WsClose.badRequest, 'bad url'); return }
    if (this.stopping) { conn.close(WsClose.serviceRestart, 'server restarting'); return }
    const q = WsConnectQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!q.success) { conn.close(WsClose.badRequest, 'bad connect parameters'); return }
    const offered = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const bearer = offered.find((p) => p.startsWith(WS_BEARER_PREFIX))?.slice(WS_BEARER_PREFIX.length)
    let auth: AuthInfo | null = null
    try {
      if (bearer) {
        const h = new Headers({ authorization: `Bearer ${bearer}` })
        auth = await this.ctx.services.sessions.resolve(new Request(req.url, { headers: h }), info)
        if (auth && auth.via !== 'bearer') auth = null
      } else {
        // cookie sessions: the Origin must be this server or a configured public origin (cross-site WebSocket hijacking)
        const origin = req.headers.get('origin')
        if (!origin || origin === 'null' || !originAllowed(origin, req.url, this.ctx.config.publicOrigins)) {
          conn.close(WsClose.forbiddenOrigin, 'origin not allowed'); return
        }
        auth = await this.ctx.services.sessions.resolve(req, info)
      }
    } catch (e) {
      this.ctx.log.error('websocket session lookup failed', { err: e })
      auth = null
    }
    if (!auth) { conn.close(WsClose.unauthorized, 'sign in required'); return }

    const userId = auth.user.id
    const windowId = q.data.windowId
    const u = this.state(userId)
    u.lastActive = this.o.now()
    const prev = u.sockets.get(windowId)
    if (prev) { prev.closed = true; u.sockets.delete(windowId); try { prev.conn.close(WsClose.replaced, 'replaced by a newer connection') } catch {} }
    const s: Socket = { conn, userId, windowId, sessionId: auth.session.id, ready: false, closed: false }
    u.sockets.set(windowId, s)
    while (u.sockets.size > MAX_SOCKETS_PER_USER) {
      const [, oldest] = u.sockets.entries().next().value as [string, Socket]
      this.drop(oldest, WsClose.replaced)
    }
    conn.onMessage((d) => this.onMessage(s, d))
    conn.onClose(() => this.onClose(s))
    if (s.closed) return // the connection went away during the session lookup

    const epoch = this.ctx.epoch
    const resumeAsked = q.data.epoch !== undefined || q.data.after !== undefined
    const hello = (resumed: boolean): ControlFrame => ({
      type: 'hello', epoch, seq: u.seq, resumed, windowId, serverVersion: this.ctx.version, pingIntervalMs: this.o.pingIntervalMs,
    })
    if (!resumeAsked) {
      this.sendFrame(s, hello(false))
    } else if (q.data.epoch !== epoch) {
      this.sendFrame(s, hello(false))
      this.sendFrame(s, { type: 'reset', epoch, seq: u.seq, reason: q.data.epoch ? 'server_restarted' : 'epoch_mismatch' })
    } else {
      const after = q.data.after ?? 0
      const oldest = u.buffer[0]?.firstSeq ?? u.seq + 1
      if (after > u.seq || after < oldest - 1) {
        this.sendFrame(s, hello(false))
        this.sendFrame(s, { type: 'resync', epoch, seq: u.seq, reason: 'buffer_overflow' })
      } else {
        this.sendFrame(s, hello(true))
        for (const e of u.buffer) {
          if (e.seq <= after) continue
          if (e.window && e.window !== windowId) continue
          if (e.acked) continue
          if (!this.send(s, JSON.stringify(e.ev))) break
        }
      }
    }
    s.ready = true
    for (const l of this.windowListeners) try { l(userId, windowId, 'open') } catch (e) { this.ctx.log.error('window listener failed', { err: e }) }
  }

  private onMessage(s: Socket, data: string) {
    if (s.closed) return
    let raw: unknown
    try { raw = JSON.parse(data) } catch { this.sendFrame(s, { type: 'error', code: 'bad_request', message: 'not JSON' }); return }
    const f = ClientFrame.safeParse(raw)
    if (!f.success) { this.sendFrame(s, { type: 'error', code: 'validation', message: 'unknown or invalid frame' }); return }
    if (f.data.type === 'ping') { this.sendFrame(s, { type: 'pong', t: f.data.t }); return }
    if (f.data.type === 'browser.ack') this.ackBrowserCall(s.userId, f.data.callId)
    for (const h of this.frameHandlers) try { h({ userId: s.userId, windowId: s.windowId }, f.data) } catch (e) { this.ctx.log.error('client frame handler failed', { err: e }) }
  }

  private onClose(s: Socket) {
    s.closed = true
    const u = this.users.get(s.userId)
    if (u && u.sockets.get(s.windowId) === s) {
      u.sockets.delete(s.windowId)
      u.lastActive = this.o.now()
      for (const l of this.windowListeners) try { l(s.userId, s.windowId, 'closed') } catch {}
    }
  }

  private sendFrame(s: Socket, f: ControlFrame) { this.send(s, JSON.stringify(f)) }

  /** false when the socket was closed (gone or too slow) */
  private send(s: Socket, json: string): boolean {
    if (s.closed) return false
    try { s.conn.send(json) } catch { this.drop(s, null); return false }
    if (s.conn.bufferedAmount() > this.o.maxBufferedBytes) { this.drop(s, WsClose.tooSlow); return false }
    return true
  }

  private drop(s: Socket, code: number | null) {
    if (s.closed) return
    s.closed = true
    const u = this.users.get(s.userId)
    if (u && u.sockets.get(s.windowId) === s) u.sockets.delete(s.windowId)
    if (code !== null) try { s.conn.close(code, 'client too slow; reconnect and resume') } catch {}
    for (const l of this.windowListeners) try { l(s.userId, s.windowId, 'closed') } catch {}
  }

  disconnectUser(userId: string, reason: SessionEndReason): void {
    const u = this.users.get(userId)
    if (!u) return
    for (const s of [...u.sockets.values()]) this.endSocket(u, s, reason)
    u.sockets.clear()
  }

  /** Close sockets that belong to one session (logout of one device, the other sessions after a password change). */
  disconnectSession(sessionId: string, reason: SessionEndReason = 'logout') {
    for (const u of this.users.values()) {
      for (const [w, s] of [...u.sockets]) if (s.sessionId === sessionId) { u.sockets.delete(w); this.endSocket(u, s, reason) }
    }
  }

  /**
   * session.ended to this socket only, then close 4401 (contract ws.ts). The event takes the person's next seq but is
   * not kept in the replay buffer: the person's other sessions may still be signed in, and a window that signs in
   * again must not replay it and sign itself out.
   */
  private endSocket(u: UserState, s: Socket, reason: SessionEndReason) {
    if (s.ready && !s.closed) {
      const ev: ServerEvent = { type: 'session.ended', seq: ++u.seq, at: this.o.now(), data: { reason } }
      this.send(s, JSON.stringify(ev))
    }
    s.closed = true
    try { s.conn.close(WsClose.unauthorized, reason) } catch {}
    for (const l of this.windowListeners) try { l(s.userId, s.windowId, 'closed') } catch {}
  }

  // ---------------- queries for other parts of B ----------------
  isWindowOpen(userId: string, windowId: string): boolean {
    const s = this.users.get(userId)?.sockets.get(windowId)
    return !!s && !s.closed
  }
  connectedWindows(userId: string): string[] { return [...(this.users.get(userId)?.sockets.keys() ?? [])] }
  lastSeq(userId: string): number { return this.users.get(userId)?.seq ?? 0 }
  onClientFrame(h: ClientFrameHandler) { this.frameHandlers.push(h) }
  onWindow(l: WindowListener) { this.windowListeners.push(l) }

  // ---------------- housekeeping ----------------
  private pingAll() {
    for (const u of this.users.values()) for (const s of u.sockets.values()) {
      if (s.closed || !s.conn.ping) continue
      try { s.conn.ping() } catch { this.drop(s, null) }
    }
  }

  /** Forget people with no sockets whose buffer has aged out (the buffer must outlive WS_REPLAY_MIN_MS). */
  sweep() {
    const now = this.o.now()
    for (const u of this.users.values()) {
      if (u.sockets.size) continue
      if (now - u.lastActive > Math.max(this.o.replayMinMs, 10 * 60_000) && (!u.buffer.length || now - u.buffer[u.buffer.length - 1]!.at > this.o.replayMinMs)) {
        // keep the seq counter so a later resume in this epoch is answered with resync, not with a wrong replay
        u.buffer = []
        u.bytes = 0
      }
      // the person's entry itself stays (a few numbers per account): dropping it would restart seq at 1 in this
      // epoch, and a window resuming with an old `after` could then be answered with a replay that skips events
    }
  }

  /** Server shutdown: tell every window to reconnect (1012). */
  close() {
    this.stopping = true
    if (this.pinger) clearInterval(this.pinger)
    if (this.sweeper) clearInterval(this.sweeper)
    for (const u of this.users.values()) {
      for (const s of u.sockets.values()) { s.closed = true; try { s.conn.close(WsClose.serviceRestart, 'server restarting') } catch {} }
      u.sockets.clear()
    }
  }
}
