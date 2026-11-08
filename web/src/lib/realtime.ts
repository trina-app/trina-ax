// WebSocket client for GET /api/ws (protocol: shared/src/api/ws.ts).
//
// - One socket per window. Resume after a drop with ?epoch=E&after=N; the server replays what was missed, or says
//   `reset` (server restarted) / `resync` (we fell out of its buffer) and the app reloads from REST.
// - Events carry a per-user seq; anything at or below the last applied seq is a duplicate and is dropped. A resumed
//   hello says the user's seq at that moment: the events up to it are the replay of what was missed (`replay: true`),
//   so nothing that reacts to new things (the room sound, lib/roomSound.ts) takes them for new.
// - Reconnect: 0–1 s random, then 1, 2, 4 … s up to 10 s. After 30 s without a connection the state becomes
//   'offline' (the banner then says "can't reach the team server"); a dropped link alone is 'reconnecting'.
// - Close 4401 = signed out (no reconnect), 4409 = the same window id connected elsewhere (duplicated tab): take a
//   new window id and reconnect. App-level ping every 20 s; no pong within 10 s → treat the link as dead.
// - `presence` (who is online or away, docs/DECISIONS.md "접속 상태") is a state, not an event: the whole list after
//   each hello, then changes, never replayed (onPresence). This window's own `presence` frame is never queued while
//   disconnected (only the newest state matters, and it is sent again after each hello).
import { ClientFrame, ServerEvent as ServerEventSchema, ServerFrame, WS_PATH, WS_PROTOCOL, WsClose, type PresenceFrame, type ServerEvent } from '@mycel/shared/api'

/** the event names this page knows (one it cannot read is then a shape it no longer agrees with) */
const KNOWN_EVENTS: ReadonlySet<string> = new Set(ServerEventSchema.options.map((o) => o.shape.type.value as string))
/** unreadable events within this long make one reload of the app's state, and such reloads come at most this often (a
 * page left open on an old version would otherwise reload everything during each streamed answer) */
export const UNREADABLE_RESYNC_MS = 2000
export const UNREADABLE_RESYNC_EVERY_MS = 60_000

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'offline' | 'signed-out'

export interface WsLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  now(): number
}

export interface RealtimeOptions {
  /** ws(s)://host — default: from location */
  baseUrl: string
  windowId: () => string
  renewWindowId: () => string
  createSocket: (url: string, protocols: string[]) => WsLike
  /** replay: sent again after a reconnect (it happened while this window was away), not just now */
  onEvent: (ev: ServerEvent, meta: { replay: boolean }) => void
  /** server restarted / we missed too much: reload chats and messages from REST */
  onReload: (reason: 'reset' | 'resync') => void
  onState?: (s: ConnState) => void
  /** server version from hello (to notice an update) */
  onHello?: (h: { serverVersion: string; resumed: boolean; epoch: string }) => void
  /** who is online or away: the whole list (full) after each hello, then changes */
  onPresence?: (f: PresenceFrame) => void
  timers?: Timers
  random?: () => number
  pingIntervalMs?: number
  pongTimeoutMs?: number
  offlineAfterMs?: number
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

const OPEN = 1
export const OUTBOX_MAX_FRAMES = 200
export const OUTBOX_MAX_BYTES = 16 * 1024 * 1024

/** Backoff before reconnect attempt n (0-based): first 0–1 s random, then 1, 2, 4, 8, 10, 10 … s. */
export function backoffMs(attempt: number, random: () => number): number {
  if (attempt <= 0) return Math.floor(random() * 1000)
  return Math.min(10_000, 1000 * 2 ** (attempt - 1))
}

export class RealtimeClient {
  private ws: WsLike | null = null
  private epoch: string | null = null
  private lastSeq = 0
  /** a resumed hello's seq: events up to it are the server's replay */
  private replayUpTo = 0
  private attempt = 0
  private state: ConnState = 'idle'
  private stopped = true
  private retryTimer: unknown = null
  private pingTimer: unknown = null
  private pongTimer: unknown = null
  private downSince: number | null = null
  private offlineTimer: unknown = null
  private outbox: string[] = []
  private outboxBytes = 0
  /** a reset/resync already asked the app to reload on this connection (hello may say "not resumed" too) */
  private reloadedThisConn = false
  /** a reload asked for after an event this page could not read, and when the last such reload ran */
  private unreadableTimer: unknown = null
  private unreadableAt = -Infinity
  private readonly t: Timers
  private readonly rnd: () => number

  constructor(private o: RealtimeOptions) {
    this.t = o.timers ?? realTimers
    this.rnd = o.random ?? Math.random
  }

  get connState() { return this.state }
  get position() { return { epoch: this.epoch, seq: this.lastSeq } }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      try { ws.close(1000, 'bye') } catch { /* already closed */ }
    }
    this.setState('idle')
  }

  /** Reconnect right away (browser came back online, tab became visible after a long sleep). */
  nudge() {
    if (this.stopped || this.state === 'open' || this.state === 'connecting' || this.state === 'signed-out') return
    if (this.retryTimer) this.t.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    this.connect()
  }

  /**
   * Send a client frame; queued while disconnected (browser.result must not get lost). The queue is bounded (a
   * browser.result can carry a screenshot): past OUTBOX_MAX_FRAMES or OUTBOX_MAX_BYTES the oldest frames are dropped —
   * the server has long given up on those calls by then.
   */
  send(frame: ClientFrame) {
    const s = JSON.stringify(ClientFrame.parse(frame))
    if (this.ws && this.ws.readyState === OPEN && this.state === 'open') this.ws.send(s)
    else if (frame.type !== 'ping' && frame.type !== 'presence') {
      this.outbox.push(s)
      this.outboxBytes += s.length
      while (this.outbox.length > OUTBOX_MAX_FRAMES || (this.outboxBytes > OUTBOX_MAX_BYTES && this.outbox.length > 1)) this.outboxBytes -= this.outbox.shift()!.length
    }
  }

  /** Frames waiting for the connection (tests). */
  get queued() { return this.outbox.length }

  private setState(s: ConnState) {
    if (this.state === s) return
    this.state = s
    this.o.onState?.(s)
  }

  private url(): string {
    const q = new URLSearchParams({ windowId: this.o.windowId() })
    if (this.epoch) {
      q.set('epoch', this.epoch)
      q.set('after', String(this.lastSeq))
    }
    return `${this.o.baseUrl}${WS_PATH}?${q}`
  }

  private connect() {
    if (this.stopped) return
    this.setState(this.attempt === 0 && this.downSince === null ? 'connecting' : this.state === 'offline' ? 'offline' : 'reconnecting')
    let ws: WsLike
    try {
      ws = this.o.createSocket(this.url(), [WS_PROTOCOL])
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = ws
    this.reloadedThisConn = false
    ws.onopen = () => { /* wait for hello before calling it open */ }
    ws.onerror = () => { /* onclose follows */ }
    ws.onmessage = (m) => this.onMessage(m.data)
    ws.onclose = (ev) => this.onClose(ev.code)
  }

  private onMessage(raw: unknown) {
    if (typeof raw !== 'string') return
    let json: unknown
    try { json = JSON.parse(raw) } catch { return }
    const parsed = ServerFrame.safeParse(json)
    if (!parsed.success) {
      // a newer server's event we don't know yet: ignore, don't break the socket. But an event this page knows by name
      // and cannot read (the server was updated under a page that stayed open): what it said is lost, so the app reads
      // its state again over REST (a room read on another device would otherwise leave its badge here for good), once
      // for those that come close together
      const type = (json as { type?: unknown } | null)?.type
      if (typeof type === 'string' && KNOWN_EVENTS.has(type) && !this.unreadableTimer) {
        const wait = Math.max(UNREADABLE_RESYNC_MS, this.unreadableAt + UNREADABLE_RESYNC_EVERY_MS - this.t.now())
        this.unreadableTimer = this.t.setTimeout(() => {
          this.unreadableTimer = null
          if (this.stopped) return
          this.unreadableAt = this.t.now()
          this.o.onReload('resync')
        }, wait)
      }
      return
    }
    const f = parsed.data
    switch (f.type) {
      case 'hello': {
        const restarted = this.epoch !== null && f.epoch !== this.epoch
        this.epoch = f.epoch
        this.replayUpTo = f.resumed ? f.seq : 0
        if (!f.resumed) {
          // fresh window, or the server could not resume us: anything we had may be stale
          if ((restarted || this.lastSeq > 0) && !this.reloadedThisConn) {
            this.reloadedThisConn = true
            this.reload('reset')
          }
          this.lastSeq = f.seq
        }
        this.attempt = 0
        this.downSince = null
        if (this.offlineTimer) this.t.clearTimeout(this.offlineTimer)
        this.offlineTimer = null
        this.setState('open')
        this.o.onHello?.({ serverVersion: f.serverVersion, resumed: f.resumed, epoch: f.epoch })
        this.flushOutbox()
        this.schedulePing()
        return
      }
      case 'reset':
      case 'resync':
        this.epoch = f.epoch
        this.lastSeq = f.seq
        if (!this.reloadedThisConn) this.reload(f.type)
        this.reloadedThisConn = true
        return
      case 'pong':
        if (this.pongTimer) this.t.clearTimeout(this.pongTimer)
        this.pongTimer = null
        return
      case 'error':
        return
      case 'presence':
        this.o.onPresence?.(f)
        return
      default: {
        if (f.seq <= this.lastSeq) return // replayed twice
        this.lastSeq = f.seq
        this.o.onEvent(f, { replay: f.seq <= this.replayUpTo })
        if (f.type === 'session.ended') this.signedOut()
      }
    }
  }

  /** The app reads its state again: what an unreadable event lost is in it too. */
  private reload(reason: 'reset' | 'resync') {
    if (this.unreadableTimer) this.t.clearTimeout(this.unreadableTimer)
    this.unreadableTimer = null
    this.o.onReload(reason)
  }

  private flushOutbox() {
    const ws = this.ws
    while (ws && this.outbox.length && ws.readyState === OPEN) {
      const s = this.outbox.shift()!
      this.outboxBytes -= s.length
      ws.send(s)
    }
  }

  private onClose(code: number) {
    this.ws = null
    this.clearPing()
    if (this.stopped) return
    if (code === WsClose.unauthorized) return this.signedOut()
    if (code === WsClose.replaced) {
      // duplicated tab (same sessionStorage): this one takes a new id
      this.o.renewWindowId()
      this.attempt = 0
    }
    if (code === WsClose.badRequest) this.o.renewWindowId()
    this.scheduleRetry()
  }

  private signedOut() {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      try { ws.close(1000) } catch { /* ignore */ }
    }
    this.setState('signed-out')
  }

  private scheduleRetry() {
    if (this.stopped) return
    if (this.downSince === null) {
      this.downSince = this.t.now()
      const after = this.o.offlineAfterMs ?? 30_000
      this.offlineTimer = this.t.setTimeout(() => {
        this.offlineTimer = null
        if (this.state !== 'open' && !this.stopped) this.setState('offline')
      }, after)
    }
    if (this.state !== 'offline') this.setState('reconnecting')
    const wait = backoffMs(this.attempt++, this.rnd)
    this.retryTimer = this.t.setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, wait)
  }

  private schedulePing() {
    if (this.pingTimer) this.t.clearTimeout(this.pingTimer)
    const every = this.o.pingIntervalMs ?? 20_000
    this.pingTimer = this.t.setTimeout(() => {
      this.pingTimer = null
      const ws = this.ws
      if (!ws || ws.readyState !== OPEN) return
      ws.send(JSON.stringify({ type: 'ping', t: this.t.now() }))
      if (!this.pongTimer) this.pongTimer = this.t.setTimeout(() => {
        // no answer: the link is dead even if the browser hasn't noticed (relay connections can hang)
        this.pongTimer = null
        const dead = this.ws
        if (dead) {
          dead.onclose = null
          try { dead.close(4000, 'ping timeout') } catch { /* ignore */ }
          this.onClose(4000)
        }
      }, this.o.pongTimeoutMs ?? 10_000)
      this.schedulePing()
    }, every)
  }

  private clearPing() {
    if (this.pingTimer) this.t.clearTimeout(this.pingTimer)
    if (this.pongTimer) this.t.clearTimeout(this.pongTimer)
    this.pingTimer = this.pongTimer = null
  }

  private clearTimers() {
    this.clearPing()
    if (this.retryTimer) this.t.clearTimeout(this.retryTimer)
    if (this.offlineTimer) this.t.clearTimeout(this.offlineTimer)
    if (this.unreadableTimer) this.t.clearTimeout(this.unreadableTimer)
    this.retryTimer = this.offlineTimer = this.unreadableTimer = null
  }
}

export function defaultWsBase(): string {
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}`
}
