// One call to the one window that sent the turn, and its result: what the browser pane and the PC runner share. The
// call goes out over that window's WebSocket; the window acks it and answers once. Calls are deduplicated by callId on
// both sides, calls still open when a window reconnects are sent again, a window that stays away fails the call, and
// only the person who owns the call can answer it. Subclasses name their frames and how long a call may take.
import type { ServerEventInput } from '@mycel/shared/api'
import type { Hub } from './hub'
import type { Logger } from '../log'

export interface WindowCall { callId: string; turnId: string }

export interface CallRelayOptions {
  /** fail calls whose window has been gone this long */
  windowGoneMs?: number
  sweepMs?: number
}

export interface Pending<C extends WindowCall, R> {
  call: C
  userId: string
  windowId: string
  acked: boolean
  polledAt: number
  goneSince: number | null
  settle(r: R): void
}

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
  protected pending = new Map<string, Pending<C, R>>()
  /** Send calls again after a reconnect even when the window had them. */
  protected resendAcked = false
  private sweeper: ReturnType<typeof setInterval>
  private windowGoneMs: number

  constructor(protected hub: Hub, protected log: Logger, protected frames: CallFrames<C, R>, o: CallRelayOptions = {}) {
    this.windowGoneMs = o.windowGoneMs ?? 60_000
    hub.onWindow((userId, windowId, state) => { if (state === 'open') this.resend(userId, windowId) })
    this.sweeper = setInterval(() => this.sweep(), o.sweepMs ?? 2_000)
    ;(this.sweeper as { unref?: () => void }).unref?.()
  }

  /** Is this window reachable right now? */
  windowAlive(userId: string, windowId: string): boolean { return this.hub.isWindowOpen(userId, windowId) }

  /** A window that just opened (or reconnected after a server restart) gets a moment to show up. */
  async waitForWindow(userId: string, windowId: string | null, ms = 3000): Promise<boolean> {
    if (!windowId) return false
    for (const end = Date.now() + ms; ; await Bun.sleep(100)) {
      if (this.windowAlive(userId, windowId)) return true
      if (Date.now() > end) return false
    }
  }

  /** Send one call and wait for its result. Never throws: failures come back as results. */
  protected open(o: { userId: string; windowId: string; call: C; timeoutMs: number; timeoutError: string; cancelOnTimeout?: boolean; signal?: AbortSignal; onSettle?: () => void }): Promise<R> {
    const { callId } = o.call
    if (o.signal?.aborted) return Promise.resolve(this.frames.failure(callId, 'the turn was stopped'))
    if (!this.windowAlive(o.userId, o.windowId)) return Promise.resolve(this.frames.failure(callId, this.frames.noWindow))
    return new Promise<R>((resolve) => {
      const timer = setTimeout(() => {
        settle(this.frames.failure(callId, o.timeoutError))
        if (o.cancelOnTimeout) this.hub.publishTo(o.userId, o.windowId, this.frames.cancelFrame(o.windowId, callId))
      }, o.timeoutMs)
      const onAbort = () => {
        settle(this.frames.failure(callId, 'the turn was stopped'))
        this.hub.publishTo(o.userId, o.windowId, this.frames.cancelFrame(o.windowId, callId))
      }
      const settle = (r: R) => {
        if (!this.pending.delete(callId)) return
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
        o.onSettle?.()
        resolve(r)
      }
      o.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(callId, { call: o.call, userId: o.userId, windowId: o.windowId, acked: false, polledAt: 0, goneSince: null, settle })
      this.deliver(o.userId, o.windowId, o.call)
    })
  }

  protected deliver(userId: string, windowId: string, call: C) {
    this.hub.publishTo(userId, windowId, this.frames.callFrame(windowId, call))
  }

  /** The window has the call: not re-sent after a reconnect. */
  protected ack(userId: string, callId: string) {
    const p = this.pending.get(callId)
    if (p && p.userId === userId) p.acked = true
  }

  /** A result from the window. Only the caller's own calls; once. */
  result(userId: string, raw: unknown): boolean {
    const r = this.frames.parse(raw)
    if (!r) return false
    const p = this.pending.get(r.callId)
    if (!p || p.userId !== userId) return false
    p.settle(r)
    return true
  }

  /** The window reconnected: send its open calls again (it ignores callIds it already ran). */
  private resend(userId: string, windowId: string) {
    for (const p of this.pending.values()) {
      if (p.userId !== userId || p.windowId !== windowId) continue
      if (!p.acked || this.resendAcked) this.hub.publishTo(userId, windowId, this.frames.callFrame(windowId, p.call))
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

  protected sweep() {
    const now = Date.now()
    for (const p of [...this.pending.values()]) {
      if (this.windowAlive(p.userId, p.windowId)) { p.goneSince = null; continue }
      p.goneSince ??= now
      if (now - p.goneSince >= this.windowGoneMs) {
        this.log.info('window call failed: window gone', { tool: this.frames.name(p.call) })
        p.settle(this.frames.failure(p.call.callId, this.frames.windowGone))
      }
    }
  }

  close() {
    clearInterval(this.sweeper)
    for (const p of [...this.pending.values()]) p.settle(this.frames.failure(p.call.callId, 'server shutting down'))
  }
}
