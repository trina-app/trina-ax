// Browser relay (tab 4 "브라우저 중계를 WebSocket으로"): the engine calls a browser tool -> browser.call goes to the
// one window that sent the turn (WebSocket, or the long-poll fallback) -> the desktop app runs it on its Browser
// pane -> browser.result comes back (WebSocket frame or POST). Calls are deduplicated by callId on both sides;
// calls still open when a window reconnects are sent again; a window that stays away 60 s fails the call.
// Ported from Saram server/src/browser.ts (long-poll only there).
import { BrowserResult, type BrowserCall, type BrowserToolName } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import type { Hub } from './hub'
import type { Logger } from '../log'

export interface BrowserRelayOptions {
  /** a call waits at most this long for its result (site prompts on the desktop wait up to 3 min) */
  callTimeoutMs?: number
  /** fail calls whose window has been gone this long */
  windowGoneMs?: number
  /** a poller that has not polled for this long is gone */
  pollStaleMs?: number
  /** a call returned to a poller is returned again after this long without a result (lost response) */
  repollMs?: number
  sweepMs?: number
}

interface Pending {
  call: BrowserCall
  userId: string
  windowId: string
  acked: boolean
  polledAt: number
  goneSince: number | null
  settle(r: BrowserResult): void
}
interface Poller { lastSeen: number; waiters: Set<() => void> }
export const MAX_POLLERS_PER_USER = 50

export class BrowserRelay {
  private pending = new Map<string, Pending>()
  private pollers = new Map<string, Poller>()
  private sweeper: ReturnType<typeof setInterval>
  private o: Required<BrowserRelayOptions>

  constructor(private hub: Hub, private log: Logger, o: BrowserRelayOptions = {}) {
    this.o = {
      callTimeoutMs: o.callTimeoutMs ?? 4 * 60_000,
      windowGoneMs: o.windowGoneMs ?? 60_000,
      pollStaleMs: o.pollStaleMs ?? 45_000,
      repollMs: o.repollMs ?? 15_000,
      sweepMs: o.sweepMs ?? 2_000,
    }
    hub.onClientFrame((s, f) => {
      if (f.type === 'browser.ack') { const p = this.pending.get(f.callId); if (p && p.userId === s.userId) p.acked = true }
      else if (f.type === 'browser.result') this.result(s.userId, f.result)
    })
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

  /** A window that just opened (or reconnected after a server restart) gets a moment to show up. */
  async waitForWindow(userId: string, windowId: string | null, ms = 3000): Promise<boolean> {
    if (!windowId) return false
    for (const end = Date.now() + ms; ; await Bun.sleep(100)) {
      if (this.windowAlive(userId, windowId)) return true
      if (Date.now() > end) return false
    }
  }

  /** Run one browser tool on the window's pane. Never throws: failures come back as ok:false results. */
  call(o: { userId: string; windowId: string; turnId: string; chatId: string; tool: BrowserToolName; args: Record<string, unknown>; signal?: AbortSignal }): Promise<BrowserResult> {
    const callId = uuidv7()
    const fail = (error: string): BrowserResult => ({ callId, ok: false, content: [], error })
    if (o.signal?.aborted) return Promise.resolve(fail('the turn was stopped'))
    if (!this.windowAlive(o.userId, o.windowId)) return Promise.resolve(fail('browser_unavailable: the desktop app window that sent this message is not connected'))
    const call: BrowserCall = { callId, turnId: o.turnId, chatId: o.chatId, tool: o.tool, args: o.args, deadline: Date.now() + this.o.callTimeoutMs }
    return new Promise<BrowserResult>((resolve) => {
      const timer = setTimeout(() => settle(fail(`browser tool ${o.tool} timed out`)), this.o.callTimeoutMs)
      const onAbort = () => {
        settle(fail('the turn was stopped'))
        this.hub.publishTo(o.userId, o.windowId, { type: 'browser.cancel', data: { windowId: o.windowId, callId } })
      }
      const settle = (r: BrowserResult) => {
        if (!this.pending.delete(callId)) return
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
        resolve({ ...r, callId })
      }
      o.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(callId, { call, userId: o.userId, windowId: o.windowId, acked: false, polledAt: 0, goneSince: null, settle })
      this.deliver(o.userId, o.windowId, call)
    })
  }

  private deliver(userId: string, windowId: string, call: BrowserCall) {
    this.hub.publishTo(userId, windowId, { type: 'browser.call', data: { windowId, call } })
    const p = this.pollers.get(this.key(userId, windowId))
    if (p) for (const w of [...p.waiters]) w()
  }

  /** A result from the window (WebSocket frame or POST /api/browser/results). Only the caller's own calls; once. */
  result(userId: string, raw: unknown): boolean {
    const r = BrowserResult.safeParse(raw)
    if (!r.success) return false
    const p = this.pending.get(r.data.callId)
    if (!p || p.userId !== userId) return false
    p.settle(r.data)
    return true
  }

  /** Long-poll fallback: open calls for this window (waits up to waitMs for one). */
  async poll(userId: string, windowId: string, waitMs: number, signal?: AbortSignal): Promise<BrowserCall[]> {
    const k = this.key(userId, windowId)
    let p = this.pollers.get(k)
    if (!p) {
      p = { lastSeen: Date.now(), waiters: new Set() }
      this.pollers.set(k, p)
      this.capPollers(userId)
    }
    p.lastSeen = Date.now()
    const take = () => {
      const now = Date.now()
      const out: BrowserCall[] = []
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
      if (p.userId === userId && p.windowId === windowId && !p.acked) this.hub.publishTo(userId, windowId, { type: 'browser.call', data: { windowId, call: p.call } })
      if (p.userId === userId && p.windowId === windowId) p.goneSince = null
    }
  }

  /** The turn ended: abandon its open calls. */
  cancelTurn(turnId: string) {
    for (const p of [...this.pending.values()]) {
      if (p.call.turnId !== turnId) continue
      p.settle({ callId: p.call.callId, ok: false, content: [], error: 'the turn ended' })
      this.hub.publishTo(p.userId, p.windowId, { type: 'browser.cancel', data: { windowId: p.windowId, callId: p.call.callId } })
    }
  }

  openCalls(): number { return this.pending.size }

  private sweep() {
    const now = Date.now()
    for (const p of [...this.pending.values()]) {
      if (this.windowAlive(p.userId, p.windowId)) { p.goneSince = null; continue }
      p.goneSince ??= now
      if (now - p.goneSince >= this.o.windowGoneMs) {
        this.log.info('browser call failed: window gone', { tool: p.call.tool })
        p.settle({ callId: p.call.callId, ok: false, content: [], error: 'browser_unavailable: the desktop app window did not come back' })
      }
    }
    for (const [k, p] of this.pollers) if (!p.waiters.size && now - p.lastSeen > 10 * 60_000) this.pollers.delete(k)
  }

  close() {
    clearInterval(this.sweeper)
    for (const p of [...this.pending.values()]) p.settle({ callId: p.call.callId, ok: false, content: [], error: 'server shutting down' })
  }
}
