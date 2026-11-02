// pc.call -> the desktop app of the one window that sent the turn -> pc.result (docs/DECISIONS.md "PC runner"). Only that
// window, so a turn of one person can never run on the computer of another. While the app waits for the person it says
// so (pc.waiting), and the turn's time limit pauses like it does for a card.
import { PcResult, type PcCall, type PcToolName } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { CallRelay, type CallRelayOptions } from '../realtime/call-relay'
import type { Hub } from '../realtime/hub'
import type { Logger } from '../log'

interface Waiter { userId: string; waiting: boolean; onWaiting(waiting: boolean): void }

export class PcRelay extends CallRelay<PcCall, PcResult> {
  private waiters = new Map<string, Waiter>()
  /** A reload of the team page loses its promise of a running call, not the call: the app keeps it by callId and answers
   * the same call with the same result. Without this the turn would wait out the command's whole time limit. */
  protected override resendAcked = true

  constructor(hub: Hub, log: Logger, o: CallRelayOptions = {}) {
    super(hub, log, {
      callFrame: (windowId, call) => ({ type: 'pc.call', data: { windowId, call } }),
      cancelFrame: (windowId, callId) => ({ type: 'pc.cancel', data: { windowId, callId } }),
      failure: (callId, error) => ({ callId, ok: false, content: [], error, approval: 'none' }),
      parse: (raw) => { const r = PcResult.safeParse(raw); return r.success ? r.data : null },
      noWindow: 'pc_unavailable: the desktop app window that sent this message is not connected',
      windowGone: 'pc_unavailable: the desktop app window did not come back',
      name: (c) => c.tool,
    }, o)
    hub.onClientFrame((s, f) => {
      if (f.type === 'pc.ack') this.ack(s.userId, f.callId)
      else if (f.type === 'pc.result') this.result(s.userId, f.result)
      else if (f.type === 'pc.waiting') this.note(s.userId, f.callId, f.waiting)
    })
  }

  private note(userId: string, callId: string, waiting: boolean) {
    const w = this.waiters.get(callId)
    if (!w || w.userId !== userId || w.waiting === waiting) return
    w.waiting = waiting
    w.onWaiting(waiting)
  }

  /** Run one tool in the app of this window. Never throws: failures come back as ok:false results. */
  call(o: { userId: string; windowId: string; turnId: string; chatId: string; project: PcCall['project']; tool: PcToolName; args: Record<string, unknown>; timeoutMs: number; signal?: AbortSignal; onWaiting(waiting: boolean): void }): Promise<PcResult> {
    const callId = uuidv7()
    const call: PcCall = { callId, turnId: o.turnId, chatId: o.chatId, project: o.project, tool: o.tool, args: o.args }
    this.waiters.set(callId, { userId: o.userId, waiting: false, onWaiting: o.onWaiting })
    return this.open({
      userId: o.userId, windowId: o.windowId, call, timeoutMs: o.timeoutMs, timeoutError: `${o.tool} timed out`, cancelOnTimeout: true, signal: o.signal,
      onSettle: () => { const w = this.waiters.get(callId); this.waiters.delete(callId); if (w?.waiting) w.onWaiting(false) },
    }).finally(() => this.waiters.delete(callId))
  }
}
