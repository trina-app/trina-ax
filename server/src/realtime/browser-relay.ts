// Browser relay (tab 4 "브라우저 중계를 WebSocket으로"): the engine calls a browser tool -> browser.call goes to the
// one window that sent the turn (WebSocket, or the long-poll fallback) -> the desktop app runs it on its Browser
// pane -> browser.result comes back (WebSocket frame or POST). Calls are deduplicated by callId on both sides;
// calls still open when a window reconnects are sent again; a window that stays away 60 s fails the call.
// Ported from Saram server/src/browser.ts (long-poll only there).
import { BrowserResult, type BrowserCall, type BrowserToolName } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { CallRelay } from './call-relay'
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

interface Poller { lastSeen: number; waiters: Set<() => void> }
export const MAX_POLLERS_PER_USER = 50

export class BrowserRelay extends CallRelay<BrowserCall, BrowserResult> {
  private pollers = new Map<string, Poller>()
  private o: { callTimeoutMs: number; pollStaleMs: number; repollMs: number }

  constructor(hub: Hub, log: Logger, o: BrowserRelayOptions = {}) {
    super(hub, log, {
      callFrame: (windowId, call) => ({ type: 'browser.call', data: { windowId, call } }),
      cancelFrame: (windowId, callId) => ({ type: 'browser.cancel', data: { windowId, callId } }),
      failure: (callId, error) => ({ callId, ok: false, content: [], error }),
      parse: (raw) => { const r = BrowserResult.safeParse(raw); return r.success ? r.data : null },
      noWindow: 'browser_unavailable: the desktop app window that sent this message is not connected',
      windowGone: 'browser_unavailable: the desktop app window did not come back',
      name: (c) => c.tool,
    }, { windowGoneMs: o.windowGoneMs ?? 60_000, sweepMs: o.sweepMs ?? 2_000 })
    this.o = { callTimeoutMs: o.callTimeoutMs ?? 4 * 60_000, pollStaleMs: o.pollStaleMs ?? 45_000, repollMs: o.repollMs ?? 15_000 }
    hub.onClientFrame((s, f) => {
      if (f.type === 'browser.ack') this.ack(s.userId, f.callId)
      else if (f.type === 'browser.result') this.result(s.userId, f.result)
    })
  }

  private key(userId: string, windowId: string) { return `${userId}\u0000${windowId}` }

  /** Is this window reachable right now (WebSocket open, or polling)? */
  override windowAlive(userId: string, windowId: string): boolean {
    if (super.windowAlive(userId, windowId)) return true
    const p = this.pollers.get(this.key(userId, windowId))
    return !!p && (p.waiters.size > 0 || Date.now() - p.lastSeen < this.o.pollStaleMs)
  }

  /** Run one browser tool on the window's pane. Never throws: failures come back as ok:false results. */
  call(o: { userId: string; windowId: string; turnId: string; chatId: string; tool: BrowserToolName; args: Record<string, unknown>; signal?: AbortSignal }): Promise<BrowserResult> {
    const call: BrowserCall = { callId: uuidv7(), turnId: o.turnId, chatId: o.chatId, tool: o.tool, args: o.args, deadline: Date.now() + this.o.callTimeoutMs }
    return this.open({ userId: o.userId, windowId: o.windowId, call, timeoutMs: this.o.callTimeoutMs, timeoutError: `browser tool ${o.tool} timed out`, signal: o.signal })
  }

  protected override deliver(userId: string, windowId: string, call: BrowserCall) {
    super.deliver(userId, windowId, call)
    const p = this.pollers.get(this.key(userId, windowId))
    if (p) for (const w of [...p.waiters]) w()
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

  protected override sweep() {
    super.sweep()
    const now = Date.now()
    for (const [k, p] of this.pollers) if (!p.waiters.size && now - p.lastSeen > 10 * 60_000) this.pollers.delete(k)
  }
}
