// One call to the one window that sent the turn, and its result: what the in-app browser (browser-relay.ts) and the
// apps on the person's computer (local-relay.ts) share. The call goes out over that window's WebSocket, or to the
// window's long-poll when its WebSocket is blocked (company proxies); the window acks it and answers once. Calls are
// deduplicated by callId on both sides, calls still open when a window reconnects are sent again, a window that stays
// away fails the call, and only the person who owns the call can answer it. Subclasses name their frames.
import type { ServerEventInput } from '@mycel/shared/api'
import type { Logger } from '../log'

/** What a relay needs from where its windows live: the realtime hub (desktop windows), or that plus the person's linked
 * Chrome (chrome/links.ts, behind browser-relay.ts BrowserWindows). */
export interface WindowTransport {
  onWindow(l: (userId: string, windowId: string, state: 'open' | 'closed') => void): void
  isWindowOpen(userId: string, windowId: string): boolean
  paneOfWindow(userId: string, windowId: string): number | undefined
  publishTo(userId: string, windowId: string, ev: ServerEventInput): unknown
}
/** window ids of linked Chromes (never a hub window's: those are the page's own random ids, without this prefix) */
export const CHROME_WINDOW_PREFIX = 'chrome:'
export const isChromeWindow = (windowId: string) => windowId.startsWith(CHROME_WINDOW_PREFIX)

export interface WindowCall { callId: string; turnId?: string | null }

export interface CallRelayOptions {
  /** a call waits at most this long for its result */
  callTimeoutMs?: number
  /** fail calls whose window has been gone this long */
  windowGoneMs?: number
  /** a poller that has not polled for this long is gone */
  pollStaleMs?: number
  /** a call returned to a poller is returned again after this long without a result (lost response) */
  repollMs?: number
  sweepMs?: number
}

interface Pending<C extends WindowCall, R> {
  call: C
  userId: string
  windowId: string
  acked: boolean
  polledAt: number
  goneSince: number | null
  settle(r: R): void
}
interface Poller { lastSeen: number; waiters: Set<() => void>; pane: number }
export const MAX_POLLERS_PER_USER = 50

export interface CallFrames<C extends WindowCall, R> {
  callFrame(windowId: string, call: C): ServerEventInput
  cancelFrame(windowId: string, callId: string): ServerEventInput
  /** a result nobody ran: stopped, timed out, the window went away */
  failure(callId: string, error: string): R
  /** what the window sent, or null when it is not a result */
  parse(raw: unknown): (R & { callId: string }) | null
  /** the result of a call that goes out to no one */
  noWindow: string
  /** the result of a call whose window did not come back */
  windowGone: string
  /** for the log line */
  name(call: C): string
}

export abstract class CallRelay<C extends WindowCall, R> {
  private pending = new Map<string, Pending<C, R>>()
  private pollers = new Map<string, Poller>()
  private sweeper: ReturnType<typeof setInterval>
  protected o: Required<CallRelayOptions>

  constructor(protected hub: WindowTransport, protected log: Logger, private frames: CallFrames<C, R>, o: CallRelayOptions = {}) {
    this.o = {
      callTimeoutMs: o.callTimeoutMs ?? 4 * 60_000,
      windowGoneMs: o.windowGoneMs ?? 60_000,
      pollStaleMs: o.pollStaleMs ?? 45_000,
      repollMs: o.repollMs ?? 15_000,
      sweepMs: o.sweepMs ?? 2_000,
    }
    hub.onWindow((userId, windowId, state) => { if (state === 'open') this.resend(userId, windowId) })
    this.sweeper = setInterval(() => this.sweep(), this.o.sweepMs)
    ;(this.sweeper as { unref?: () => void }).unref?.()
  }

  private key(userId: string, windowId: string) { return `${userId}\u0000${windowId}` }

  /** Is this window reachable right now (WebSocket open, or polling)? */
  windowAlive(userId: string, windowId: string): boolean {
    if (this.hub.isWindowOpen(userId, windowId)) return true
    const p = this.pollers.get(this.key(userId, windowId))
    return !!p && (p.waiters.size > 0 || Date.now() - p.lastSeen < this.o.pollStaleMs)
  }

  /** The in-app browser version this window's page said (WebSocket first, else its long-poll; 0: none, or an older
   * page or desktop app): a tool the browser.call contract added later is offered only where the app runs it. */
  paneVersion(userId: string, windowId: string | null | undefined): number {
    if (!windowId) return 0
    const ws = this.hub.paneOfWindow(userId, windowId)
    if (ws !== undefined) return ws
    return this.pollers.get(this.key(userId, windowId))?.pane ?? 0
  }

  /** A window that just opened (or reconnected after a server restart) gets a moment to show up. */
  async waitForWindow(userId: string, windowId: string | null, ms = 3000): Promise<boolean> {
    if (!windowId) return false
    for (const end = Date.now() + ms; ; await Bun.sleep(100)) {
      if (this.windowAlive(userId, windowId)) return true
      if (Date.now() > end) return false
    }
  }

  /** Send one call and wait for its result. Never throws: failures come back as results. */
  protected open(o: { userId: string; windowId: string; call: C; timeoutMs?: number; timeoutError: string; signal?: AbortSignal }): Promise<R> {
    const { callId } = o.call
    const fail = (error: string) => this.frames.failure(callId, error)
    if (o.signal?.aborted) return Promise.resolve(fail('the turn was stopped'))
    if (!this.windowAlive(o.userId, o.windowId)) return Promise.resolve(fail(this.frames.noWindow))
    return new Promise<R>((resolve) => {
      const timer = setTimeout(() => settle(fail(o.timeoutError)), o.timeoutMs ?? this.o.callTimeoutMs)
      const onAbort = () => {
        settle(fail('the turn was stopped'))
        this.hub.publishTo(o.userId, o.windowId, this.frames.cancelFrame(o.windowId, callId))
      }
      const settle = (r: R) => {
        if (!this.pending.delete(callId)) return
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
        resolve(r)
      }
      o.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(callId, { call: o.call, userId: o.userId, windowId: o.windowId, acked: false, polledAt: 0, goneSince: null, settle })
      this.deliver(o.userId, o.windowId, o.call)
    })
  }

  private deliver(userId: string, windowId: string, call: C) {
    this.hub.publishTo(userId, windowId, this.frames.callFrame(windowId, call))
    const p = this.pollers.get(this.key(userId, windowId))
    if (p) for (const w of [...p.waiters]) w()
  }

  /** A call to a linked Chrome is answered only by that Chrome's own connection (`from`), never by a window of the page. */
  private fromItsWindow(p: Pending<C, R>, from: string | undefined): boolean {
    return !isChromeWindow(p.windowId) || from === p.windowId
  }

  /** The window has the call: it is not sent again after a reconnect. Only the caller's own calls. */
  ack(userId: string, callId: string, from?: string) {
    const p = this.pending.get(callId)
    if (p && p.userId === userId && this.fromItsWindow(p, from)) p.acked = true
  }

  /** A result from the window (WebSocket frame or the long-poll's POST; `from`: the window it came from, when known).
   * Only the caller's own calls; once. */
  result(userId: string, raw: unknown, from?: string): boolean {
    const r = this.frames.parse(raw)
    if (!r) return false
    const p = this.pending.get(r.callId)
    if (!p || p.userId !== userId || !this.fromItsWindow(p, from)) return false
    p.settle(r)
    return true
  }

  /** Long-poll fallback: open calls for this window (waits up to waitMs for one). */
  async poll(userId: string, windowId: string, waitMs: number, signal?: AbortSignal, pane?: number): Promise<C[]> {
    const k = this.key(userId, windowId)
    let p = this.pollers.get(k)
    if (!p) {
      p = { lastSeen: Date.now(), waiters: new Set(), pane: 0 }
      this.pollers.set(k, p)
      this.capPollers(userId)
    }
    p.lastSeen = Date.now()
    // the newest poll says what the page runs in (an app updated meanwhile)
    if (pane !== undefined) p.pane = pane
    const take = () => {
      const now = Date.now()
      const out: C[] = []
      for (const x of this.pending.values()) {
        if (x.userId !== userId || x.windowId !== windowId || x.acked) continue
        if (now - x.polledAt < this.o.repollMs) continue
        x.polledAt = now
        out.push(x.call)
      }
      return out
    }
    let calls = take()
    if (calls.length || waitMs <= 0) return calls
    const poller = p
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); poller.waiters.delete(done); signal?.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, waitMs)
      poller.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
    poller.lastSeen = Date.now()
    calls = take()
    return calls
  }

  /** A person polls for at most MAX_POLLERS_PER_USER windows; the longest-idle one without a waiting request goes. */
  private capPollers(userId: string) {
    const mine = [...this.pollers].filter(([k]) => k.startsWith(userId + '\u0000'))
    if (mine.length <= MAX_POLLERS_PER_USER) return
    const idle = mine.filter(([, p]) => !p.waiters.size).sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    for (const [k] of idle.slice(0, mine.length - MAX_POLLERS_PER_USER)) this.pollers.delete(k)
  }

  /** The window reconnected: send its open calls again (it ignores callIds it already ran). */
  private resend(userId: string, windowId: string) {
    for (const p of this.pending.values()) {
      if (p.userId !== userId || p.windowId !== windowId) continue
      if (!p.acked) this.hub.publishTo(userId, windowId, this.frames.callFrame(windowId, p.call))
      p.goneSince = null
    }
  }

  /** The turn ended: abandon its open calls. */
  cancelTurn(turnId: string) {
    for (const p of [...this.pending.values()]) {
      if (p.call.turnId !== turnId) continue
      p.settle(this.frames.failure(p.call.callId, 'the turn ended'))
      this.hub.publishTo(p.userId, p.windowId, this.frames.cancelFrame(p.windowId, p.call.callId))
    }
  }

  openCalls(): number { return this.pending.size }

  private sweep() {
    const now = Date.now()
    for (const p of [...this.pending.values()]) {
      if (this.windowAlive(p.userId, p.windowId)) { p.goneSince = null; continue }
      p.goneSince ??= now
      if (now - p.goneSince >= this.o.windowGoneMs) {
        this.log.info('window call failed: window gone', { tool: this.frames.name(p.call) })
        p.settle(this.frames.failure(p.call.callId, this.frames.windowGone))
      }
    }
    for (const [k, p] of this.pollers) if (!p.waiters.size && now - p.lastSeen > 10 * 60_000) this.pollers.delete(k)
  }

  close() {
    clearInterval(this.sweeper)
    for (const p of [...this.pending.values()]) p.settle(this.frames.failure(p.call.callId, 'server shutting down'))
  }
}
