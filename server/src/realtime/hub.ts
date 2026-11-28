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
import { originAllowed, originsFor } from '../http/middleware'
import { atLeast, loadPrincipal, RuleSet } from '../policy/access'
import { visibleChanges } from '../team-files/changes'
import { isRoomMember } from '../rooms/store'
import { chatVisibleTo, threadVisibleTo } from '../chat/threads'

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
  /** the desktop app's in-app browser version the page said (WsConnectQuery.pane; 0: none or an older page) */
  pane: number
  /** the team page's origin the window connected from (its Origin header, checked by originAllowed; null: a bearer
   * session, which sends none): where the person's computer reaches this server (local-file-links.ts) */
  origin: string | null
  /** epoch ms when the session expires (Infinity: no expiry known); the socket is closed then */
  expiresAt: number
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
  /** the last forgetReplay: its run (Hub.run) and the seq it was at */
  forgot?: { run: number; seq: number }
}

type SessionEndReason = Parameters<RealtimeHub['disconnectUser']>[1]

export type ClientFrameHandler = (s: { userId: string; windowId: string }, f: ClientFrame) => void
export type WindowListener = (userId: string, windowId: string, state: 'open' | 'closed') => void
/** every session of a person was ended (logout everywhere, password changed, disabled, deleted), open windows or not */
export type UserEndedListener = (userId: string, reason: SessionEndReason) => void

export interface HubOptions {
  pingIntervalMs?: number
  replayMinEvents?: number
  replayMinMs?: number
  maxBufferedBytes?: number
  now?: () => number
  /** does this person still see this chat, for the replay (chat/threads.ts chatVisibleTo; tests of the hub alone hand
   * in their own) */
  chatVisible?: (userId: string, chatId: string) => boolean
}

export class Hub implements RealtimeHub {
  private users = new Map<string, UserState>()
  /** one synchronous run of the server's code: bumped after the run's microtasks (see forgetReplay) */
  private runNo = 0
  private runOpen = false
  private pinger: ReturnType<typeof setInterval> | null = null
  private sweeper: ReturnType<typeof setInterval> | null = null
  private frameHandlers: ClientFrameHandler[] = []
  private windowListeners: WindowListener[] = []
  private seenListeners: ((userId: string, windowId: string) => void)[] = []
  private userEndedListeners: UserEndedListener[] = []
  private o: Required<HubOptions>
  private stopping = false

  constructor(private ctx: AppContext, o: HubOptions = {}) {
    this.o = {
      pingIntervalMs: o.pingIntervalMs ?? WS_PING_INTERVAL_MS,
      replayMinEvents: o.replayMinEvents ?? WS_REPLAY_MIN_EVENTS,
      replayMinMs: o.replayMinMs ?? WS_REPLAY_MIN_MS,
      maxBufferedBytes: o.maxBufferedBytes ?? WS_MAX_BUFFERED_BYTES,
      now: o.now ?? Date.now,
      chatVisible: o.chatVisible ?? ((userId, chatId) => chatVisibleTo(this.ctx, userId, chatId)),
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

  /** One event to each of these people who has a window open now: a running answer's live text and steps to the others
   * in a shared chat (chat/live-answer.ts). The event's data is serialized once for all of them. Someone with no open
   * window gets nothing (nothing is buffered for them either): they read the chat over REST when they open it, and a
   * window that resumes over a gap in the text reads it again (store/thread.ts applyDelta 'gap'). */
  publishOpen(userIds: Iterable<string>, ev: ServerEventInput): void {
    let data: string | null = null
    for (const userId of userIds) {
      if (!this.hasOpenWindow(userId)) continue
      data ??= JSON.stringify(ev.data)
      this.emit(userId, ev, null, data)
    }
  }

  /** At least one ready window of this person. */
  hasOpenWindow(userId: string): boolean {
    const u = this.users.get(userId)
    if (!u) return false
    for (const s of u.sockets.values()) if (s.ready && !s.closed) return true
    return false
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

  private emit(userId: string, input: ServerEventInput, window: string | null, data?: string): number {
    const u = this.state(userId)
    const now = this.o.now()
    const seq = ++u.seq
    const ev = { ...input, seq, at: now } as ServerEvent
    // (publishOpen: the data serialized once for everyone it goes to; the frame is the same JSON)
    const json = data !== undefined ? `{"type":${JSON.stringify(input.type)},"data":${data},"seq":${seq},"at":${now}}` : JSON.stringify(ev)
    this.remember(u, ev, window, json.length, now)
    this.expire(u, now)
    for (const s of u.sockets.values()) {
      if (!s.ready || s.closed) continue
      if (window && s.windowId !== window) continue
      this.send(s, json)
    }
    return seq
  }

  private remember(u: UserState, ev: ServerEvent, window: string | null, bytes: number, now: number) {
    const last = u.buffer[u.buffer.length - 1]
    if (ev.type === 'message.delta' && !ev.data.reset && last && last.ev.type === 'message.delta' && last.window === window
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
    let pageOrigin: string | null = null
    try {
      if (bearer) {
        const h = new Headers({ authorization: `Bearer ${bearer}` })
        auth = await this.ctx.services.sessions.resolve(new Request(req.url, { headers: h }), info)
        if (auth && auth.via !== 'bearer') auth = null
      } else {
        // cookie sessions: the Origin must be this server or a configured public origin (cross-site WebSocket hijacking)
        const origin = req.headers.get('origin')
        if (!origin || origin === 'null' || !originAllowed(origin, req.url, originsFor(this.ctx.config, info))) {
          conn.close(WsClose.forbiddenOrigin, 'origin not allowed'); return
        }
        pageOrigin = new URL(origin).origin
        auth = await this.ctx.services.sessions.resolve(req, info)
      }
    } catch (e) {
      this.ctx.log.error('websocket session lookup failed', { err: e })
      auth = null
    }
    if (!auth) { conn.close(WsClose.unauthorized, 'sign in required'); return }
    // a session that must still change its (temporary) password reaches nothing but /api/me, the password change and
    // logout (http/route.ts enforceAuth): no team events either
    if (auth.user.mustChangePassword) { conn.close(WsClose.unauthorized, 'password change required'); return }

    const userId = auth.user.id
    const windowId = q.data.windowId
    const u = this.state(userId)
    u.lastActive = this.o.now()
    const prev = u.sockets.get(windowId)
    if (prev) { prev.closed = true; u.sockets.delete(windowId); try { prev.conn.close(WsClose.replaced, 'replaced by a newer connection') } catch {} }
    const exp = auth.session.expiresAt ? Date.parse(auth.session.expiresAt) : NaN
    const s: Socket = { conn, userId, windowId, sessionId: auth.session.id, pane: q.data.pane ?? 0, origin: pageOrigin, expiresAt: Number.isFinite(exp) ? exp : Infinity, ready: false, closed: false }
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
      const replay = after > u.seq || after < oldest - 1 ? null
        : u.buffer.filter((e) => e.seq > after && (!e.window || e.window === windowId) && !e.acked)
      if (!replay || !this.stillVisible(userId, replay)) {
        this.sendFrame(s, hello(false))
        this.sendFrame(s, { type: 'resync', epoch, seq: u.seq, reason: 'buffer_overflow' })
      } else {
        this.sendFrame(s, hello(true))
        for (const e of replay) if (!this.send(s, JSON.stringify(e.ev))) break
      }
    }
    // dropped while its hello or replay went out (too slow, gone): 'closed' was already told, so 'open' must not follow
    // (presence would keep the window forever)
    if (s.closed) return
    s.ready = true
    for (const l of this.windowListeners) try { l(userId, windowId, 'open') } catch (e) { this.ctx.log.error('window listener failed', { err: e }) }
  }

  /**
   * Second check before a replay (the first is forgetReplay on every access change): every file path a buffered
   * files.changed / files.conflict names must still be readable by the person under the rules as they are NOW. The
   * events were filtered when they were published; a person removed from a folder since then must not get its new
   * file and folder names from the buffer when HTTP already answers 404. Anything that no longer passes unchanged
   * turns the whole replay into a resync (the window reloads over REST, which checks again), so nothing is skipped
   * silently either. Room events (room.*) the same way: replayed only while the person is still in the room (a
   * removed member gets resync; the rooms list over REST no longer has the room). A chat thread's events (chat.thread)
   * only while the person still sees the thread (chat/threads.ts threadVisibleTo).
   */
  private stillVisible(userId: string, entries: readonly Entry[]): boolean {
    const rooms = new Set<string>()
    for (const { ev } of entries) if (ev.type === 'room.message' || ev.type === 'room.message.updated' || ev.type === 'room.read' || ev.type === 'room.thread' || ev.type === 'room.reactions' || (ev.type === 'room.updated' && ev.data.change !== 'removed')) rooms.add(ev.data.roomId)
    try {
      for (const r of rooms) if (!isRoomMember(this.ctx.db, r, userId)) return false
    } catch (e) {
      this.ctx.log.error('replay room check failed', { err: e, user: userId })
      return false
    }
    // a thread under an AI answer of a shared chat (chat.thread carries reply text): replayed only while the person still
    // sees that chat and answer (chat/threads.ts threadAccess); access is worked out live, so someone taken out of the
    // chat since (people-share.ts, admin/folders.ts) gets resync and reloads over REST
    const threads = new Set<string>()
    for (const { ev } of entries) if (ev.type === 'chat.thread') threads.add(`${ev.data.chatId} ${ev.data.rootId}`)
    // a chat's own events (its messages, live text, steps, cards, artifacts, a changed chat) only while the person still
    // sees it (chatFor): someone taken out of a chat shared with people while offline gets resync, never what was said
    // there since (QA TC-3788). A chat that left their list ('deleted', 'purged') carries nothing of it and goes through
    const chats = new Set<string>()
    for (const { ev } of entries) {
      if (ev.type === 'message.created' || ev.type === 'message.delta' || ev.type === 'message.step' || ev.type === 'message.attachments' || ev.type === 'message.done' || ev.type === 'turn.busy' || ev.type === 'queue.position' || ev.type === 'artifact.updated' || ev.type === 'turn.request' || ev.type === 'deck.progress') chats.add(ev.data.chatId)
      else if (ev.type === 'chat.updated' && ev.data.change !== 'deleted' && ev.data.change !== 'purged') chats.add(ev.data.chatId)
    }
    try {
      for (const id of chats) if (!this.o.chatVisible(userId, id)) return false
    } catch (e) {
      this.ctx.log.error('replay chat check failed', { err: e, user: userId })
      return false
    }
    try {
      for (const k of threads) {
        const [chatId, rootId] = k.split(' ') as [string, string]
        if (!threadVisibleTo(this.ctx, userId, chatId, rootId)) return false
      }
    } catch (e) {
      this.ctx.log.error('replay thread check failed', { err: e, user: userId })
      return false
    }
    const files = entries.filter((e) => e.ev.type === 'files.changed' || e.ev.type === 'files.conflict')
    if (!files.length) return true
    try {
      const who = loadPrincipal(this.ctx.db, userId)
      if (!who) return false
      const rules = RuleSet.load(this.ctx.db)
      const can = (p: string) => atLeast(rules.access(who, p === '' ? [] : p.split('/')), 'read')
      for (const { ev } of files) {
        if (ev.type === 'files.changed') {
          // a move stays a move only when both ends are readable; anything dropped or rewritten fails
          const now = visibleChanges(rules, who, ev.data.changes)
          if (JSON.stringify(now) !== JSON.stringify(ev.data.changes)) return false
        } else if (ev.type === 'files.conflict') {
          if (!can(ev.data.path) || !can(ev.data.copyPath)) return false
        }
      }
      return true
    } catch (e) {
      this.ctx.log.error('replay permission check failed', { err: e, user: userId })
      return false
    }
  }

  private onMessage(s: Socket, data: string) {
    if (s.closed) return
    let raw: unknown
    try { raw = JSON.parse(data) } catch { this.sendFrame(s, { type: 'error', code: 'bad_request', message: 'not JSON' }); return }
    const f = ClientFrame.safeParse(raw)
    if (!f.success) { this.sendFrame(s, { type: 'error', code: 'validation', message: 'unknown or invalid frame' }); return }
    for (const l of this.seenListeners) try { l(s.userId, s.windowId) } catch { /* the listener's own problem */ }
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
    if (u) {
      for (const s of [...u.sockets.values()]) this.endSocket(u, s, reason)
      u.sockets.clear()
    }
    // also with no window open (presence: an account turned off while its last window's grace runs)
    for (const l of this.userEndedListeners) try { l(userId, reason) } catch (e) { this.ctx.log.error('user ended listener failed', { err: e }) }
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

  /**
   * A control frame (no seq, never buffered or replayed: a state like `presence`, realtime/presence.ts) to a person's
   * open windows, or to one of them. Windows still replaying get nothing (they are told when they open); a window whose
   * session has expired is ended first, as before an event.
   */
  sendControl(userId: string, frame: ControlFrame, windowId?: string): void {
    const u = this.users.get(userId)
    if (!u) return
    this.expire(u, this.o.now())
    const json = JSON.stringify(frame)
    for (const s of [...u.sockets.values()]) {
      if (!s.ready || s.closed) continue
      if (windowId && s.windowId !== windowId) continue
      this.send(s, json)
    }
  }

  /** The people with at least one open window. */
  connectedUsers(): string[] {
    const out: string[] = []
    for (const [id, u] of this.users) for (const s of u.sockets.values()) if (s.ready && !s.closed) { out.push(id); break }
    return out
  }

  // ---------------- queries for other parts of B ----------------
  isWindowOpen(userId: string, windowId: string): boolean {
    const s = this.users.get(userId)?.sockets.get(windowId)
    return !!s && !s.closed
  }
  /** the in-app browser version the window's page said when it connected (BROWSER_BRIDGE_VERSION; 0: none), or
   * undefined when the window has no open WebSocket */
  paneOfWindow(userId: string, windowId: string): number | undefined {
    const s = this.users.get(userId)?.sockets.get(windowId)
    return s && !s.closed ? s.pane : undefined
  }
  /** the team page's origin the window connected from (Socket.origin), or null (no open WebSocket, a bearer session) */
  originOfWindow(userId: string, windowId: string): string | null {
    const s = this.users.get(userId)?.sockets.get(windowId)
    return s && !s.closed ? s.origin : null
  }
  /** the sign-in (session) a window is on: its desktop app's computer report is per sign-in (realtime/presence.ts) */
  sessionOfWindow(userId: string, windowId: string): string | undefined { return this.users.get(userId)?.sockets.get(windowId)?.sessionId }
  connectedWindows(userId: string): string[] { return [...(this.users.get(userId)?.sockets.keys() ?? [])] }
  lastSeq(userId: string): number { return this.users.get(userId)?.seq ?? 0 }
  onClientFrame(h: ClientFrameHandler) { this.frameHandlers.push(h) }
  onWindow(l: WindowListener) { this.windowListeners.push(l) }
  /** Every valid frame a window sends (its ping too), after it is parsed: presence's silence cut-off. */
  onFrameSeen(l: (userId: string, windowId: string) => void) { this.seenListeners.push(l) }
  onUserEnded(l: UserEndedListener) { this.userEndedListeners.push(l) }

  // ---------------- housekeeping ----------------
  /**
   * A socket is authenticated once, at connect: when its session expires it is ended (session.ended 'expired', close
   * 4401) before anything else is sent to it, and by the keep-alive / sweep timers when nothing is sent.
   */
  private expire(u: UserState, now: number) {
    for (const [w, s] of [...u.sockets]) if (s.expiresAt <= now) { u.sockets.delete(w); this.endSocket(u, s, 'expired') }
  }

  private pingAll() {
    const now = this.o.now()
    for (const u of this.users.values()) this.expire(u, now)
    for (const u of this.users.values()) for (const s of u.sockets.values()) {
      if (s.closed || !s.conn.ping) continue
      try { s.conn.ping() } catch { this.drop(s, null) }
    }
  }

  /** open connections of every person (F2 sleep, Ops.statusFile) */
  openSockets(): number {
    let n = 0
    for (const u of this.users.values()) n += u.sockets.size
    return n
  }

  /**
   * Drop a person's replay history (their access changed, they were disabled or deleted). The seq counter stays, so
   * any resume from before this point is answered with resync and the window reloads over REST, which applies the
   * new access; nothing published under the old access is replayed. Open windows keep their sockets.
   *
   * A second forget in the same synchronous run (one access change forgets more than once: afterAccessChange, then
   * the rooms' sync for the team room of the group the person left) keeps what the first one's change published since
   * when it only tells the window what it lost (access_changed, a room or a chat removed by id). Before, the second
   * forget dropped the access_changed notice the first had just published, so a window that had seen everything before
   * the change got resync instead of the notice (DECISIONS.md "권한이 바뀌면 그 사람의 이어받기 버퍼를 버린다": 알림
   * 직전까지 다 받은 창은 알림만 이어받는다). Only a tail of such entries is kept, so anything dropped is older than the
   * oldest entry left and a resume from before it is still resync; nothing from before the run's first forget stays.
   */
  forgetReplay(userId: string): void {
    const u = this.users.get(userId)
    if (!u) return
    const run = this.currentRun()
    let keep = u.buffer.length
    if (u.forgot?.run === run) {
      const since = u.forgot.seq
      while (keep > 0 && u.buffer[keep - 1]!.firstSeq > since && onlyTellsLoss(u.buffer[keep - 1]!.ev)) keep--
    }
    u.buffer = u.buffer.slice(keep)
    u.bytes = u.buffer.reduce((n, e) => n + e.bytes, 0)
    if (u.forgot?.run !== run) u.forgot = { run, seq: u.seq }
  }

  /** the number of the synchronous run this is in: it changes once the run's microtasks are done (an await ends a run) */
  private currentRun(): number {
    if (!this.runOpen) {
      this.runOpen = true
      queueMicrotask(() => { this.runNo++; this.runOpen = false })
    }
    return this.runNo
  }

  /** Forget people with no sockets whose buffer has aged out (the buffer must outlive WS_REPLAY_MIN_MS). */
  sweep() {
    const now = this.o.now()
    for (const u of this.users.values()) {
      this.expire(u, now)
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

/** events that only tell a window what the person lost, with no content of it: kept by a second forget in one run */
function onlyTellsLoss(ev: ServerEvent): boolean {
  if (ev.type === 'notice') return ev.data.code === 'access_changed'
  if (ev.type === 'room.updated') return ev.data.change === 'removed' && ev.data.room === null
  if (ev.type === 'chat.updated') return ev.data.change === 'deleted' && ev.data.chat === null
  return false
}
