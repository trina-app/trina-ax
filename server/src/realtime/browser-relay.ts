// Browser relay (tab 4 "브라우저 중계를 WebSocket으로"): the engine calls a browser tool -> browser.call goes to the
// one window that sent the turn (WebSocket, or the long-poll fallback) -> the desktop app runs it on its Browser
// pane -> browser.result comes back (WebSocket frame or POST). Calls are deduplicated by callId on both sides;
// calls still open when a window reconnects are sent again; a window that stays away 60 s fails the call.
// Ported from Saram server/src/browser.ts (long-poll only there). The common part is call-relay.ts (shared with the
// apps on the person's computer, local-relay.ts).
import { BROWSER_CALL_SITES_MAX, BrowserResult, BrowserSiteKey, type BrowserCall, type BrowserToolName } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import type { Hub } from './hub'
import type { Logger } from '../log'
import { CallRelay, type CallRelayOptions } from './call-relay'
import { BrowserUploads } from './browser-uploads'

export { MAX_POLLERS_PER_USER } from './call-relay'
/** a call waits at most this long for its result (site prompts on the desktop wait up to 3 min) */
export type BrowserRelayOptions = CallRelayOptions

const fail = (callId: string, error: string): BrowserResult => ({ callId, ok: false, content: [], error })

export class BrowserRelay extends CallRelay<BrowserCall, BrowserResult> {
  /** file_upload's single-use tickets (browser-uploads.ts) */
  readonly uploads = new BrowserUploads()

  constructor(hub: Hub, log: Logger, o: BrowserRelayOptions = {}) {
    super(hub, log, {
      callFrame: (windowId, call) => ({ type: 'browser.call', data: { windowId, call } }),
      cancelFrame: (windowId, callId) => ({ type: 'browser.cancel', data: { windowId, callId } }),
      failure: fail,
      parse: (raw) => { const r = BrowserResult.safeParse(raw); return r.success ? r.data : null },
      noWindow: 'browser_unavailable: the desktop app window that sent this message is not connected',
      windowGone: 'browser_unavailable: the desktop app window did not come back',
      name: (call) => `browser ${call.tool}`,
    }, o)
    hub.onClientFrame((s, f) => {
      if (f.type === 'browser.ack') this.ack(s.userId, f.callId)
      else if (f.type === 'browser.result') this.result(s.userId, f.result)
    })
  }

  /** Run one browser tool on the window's pane. Never throws: failures come back as ok:false results. `prepare`: the
   * call's arguments made with its callId and deadline (file_upload's tickets), or a refusal (nothing is sent). */
  async call(o: { userId: string; windowId: string; turnId: string; chatId: string; tool: BrowserToolName; args: Record<string, unknown>; signal?: AbortSignal; sites?: string[]; office?: string[]; prepare?: (callId: string, deadline: number) => Record<string, unknown> | string }): Promise<BrowserResult> {
    const callId = uuidv7()
    const deadline = Date.now() + this.o.callTimeoutMs
    let args = o.args
    if (o.prepare) {
      const made = o.prepare(callId, deadline)
      if (typeof made === 'string') return { callId, ok: false, content: [], error: made }
      args = made
    }
    try { return await this.send(o, callId, deadline, args) } finally { this.uploads.revokeCall(callId) }
  }

  private async send(o: Parameters<BrowserRelay['call']>[0], callId: string, deadline: number, args: Record<string, unknown>): Promise<BrowserResult> {
    // only keys the desktop app reads (a call it cannot parse would fail as a whole)
    const keys = (l?: string[]) => [...new Set(l ?? [])].filter((k) => BrowserSiteKey.safeParse(k).success).slice(0, BROWSER_CALL_SITES_MAX)
    const sites = keys(o.sites), office = keys(o.office)
    const call: BrowserCall = {
      callId, turnId: o.turnId, chatId: o.chatId, tool: o.tool, args, deadline,
      // what the person already allowed (chat/tools.ts browserTool): sent only when there is something to say
      ...(sites.length ? { sites } : {}), ...(office.length ? { office } : {}),
    }
    const r = await this.open({ userId: o.userId, windowId: o.windowId, call, timeoutError: `browser tool ${o.tool} timed out`, signal: o.signal })
    return { ...r, callId }
  }
}
