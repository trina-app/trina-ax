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
import { CallRelay, isChromeWindow, type CallRelayOptions, type WindowTransport } from './call-relay'
import { BrowserUploads } from './browser-uploads'
import type { ChromeLinks } from '../chrome/links'

/** The relay's windows: the hub's desktop windows, and the person's linked Chrome (`chrome:<linkId>`, chrome/links.ts) */
class BrowserWindows implements WindowTransport {
  constructor(private hub: Hub, private chrome: ChromeLinks | null) {}
  onWindow(l: (userId: string, windowId: string, state: 'open' | 'closed') => void) { this.hub.onWindow(l); this.chrome?.onWindow(l) }
  isWindowOpen(userId: string, windowId: string) { return isChromeWindow(windowId) ? !!this.chrome?.isWindowOpen(userId, windowId) : this.hub.isWindowOpen(userId, windowId) }
  paneOfWindow(userId: string, windowId: string) { return isChromeWindow(windowId) ? this.chrome?.paneOfWindow(userId, windowId) : this.hub.paneOfWindow(userId, windowId) }
  publishTo(userId: string, windowId: string, ev: Parameters<Hub['publishTo']>[2]) { return isChromeWindow(windowId) ? (this.chrome?.publishTo(userId, windowId, ev) ?? 0) : this.hub.publishTo(userId, windowId, ev) }
}

export { MAX_POLLERS_PER_USER } from './call-relay'
/** a call waits at most this long for its result (site prompts on the desktop wait up to 3 min) */
export type BrowserRelayOptions = CallRelayOptions

const fail = (callId: string, error: string): BrowserResult => ({ callId, ok: false, content: [], error })

export class BrowserRelay extends CallRelay<BrowserCall, BrowserResult> {
  /** file_upload's single-use tickets (browser-uploads.ts) */
  readonly uploads = new BrowserUploads()

  constructor(hub: Hub, log: Logger, o: BrowserRelayOptions = {}, chrome: ChromeLinks | null = null) {
    super(new BrowserWindows(hub, chrome), log, {
      callFrame: (windowId, call) => ({ type: 'browser.call', data: { windowId, call } }),
      cancelFrame: (windowId, callId) => ({ type: 'browser.cancel', data: { windowId, callId } }),
      failure: fail,
      parse: (raw) => { const r = BrowserResult.safeParse(raw); return r.success ? r.data : null },
      noWindow: 'browser_unavailable: the browser this answer uses is not connected (the desktop app window, or the user\'s Chrome)',
      windowGone: 'browser_unavailable: the browser this answer uses did not come back (the desktop app window, or the user\'s Chrome)',
      name: (call) => `browser ${call.tool}`,
    }, o)
    hub.onClientFrame((s, f) => {
      if (f.type === 'browser.ack') this.ack(s.userId, f.callId, s.windowId)
      else if (f.type === 'browser.result') this.result(s.userId, f.result, s.windowId)
    })
    chrome?.onFrame((userId, windowId, f) => {
      if (f.type === 'browser.ack') this.ack(userId, f.callId, windowId)
      else this.result(userId, f.result, windowId)
    })
  }

  /** Run one browser tool on the window's pane. Never throws: failures come back as ok:false results. `prepare`: the
   * call's arguments made with its callId and deadline (file_upload's tickets), or a refusal (nothing is sent). */
  async call(o: { userId: string; windowId: string; turnId: string; chatId: string; tool: BrowserToolName; args: Record<string, unknown>; signal?: AbortSignal; sites?: string[]; office?: string[]; run?: { id: string; title: string }; prepare?: (callId: string, deadline: number) => Record<string, unknown> | string }): Promise<BrowserResult> {
    const callId = uuidv7()
    // a call to a linked Chrome always names its run: the extension keeps each run's tabs apart by it
    if (isChromeWindow(o.windowId) && !o.run) return { callId, ok: false, content: [], error: 'browser_unavailable: no run for this call' }
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
      ...(o.run ? { run: { id: o.run.id.slice(0, 100), title: o.run.title.slice(0, 80) } } : {}),
    }
    const r = await this.open({ userId: o.userId, windowId: o.windowId, call, timeoutError: `browser tool ${o.tool} timed out`, signal: o.signal })
    return { ...r, callId }
  }
}
