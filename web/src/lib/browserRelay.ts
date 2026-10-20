// browser.call → this window's in-app Browser pane (desktop app) → browser.result over the WebSocket.
// The server sends each call only to the window that sent the turn and sends it again after a reconnect until a
// result arrives. In the desktop app the shared relay (shared/src/desktop-bridge.ts createBrowserRelay) runs each
// call once, answers a repeated call with its ack or its kept result, and checks the desktop's answer against the
// contract. A window without the pane (plain browser, PWA) answers at once with an error the AI can act on, instead
// of letting the turn wait for the deadline.
import { createBrowserRelay, type BrowserRelay as SharedRelay, type DesktopBridge } from '@mycel/shared'
import type { BrowserCall, BrowserResult, ClientFrame } from '@mycel/shared/api'
import { desktop } from './desktop'

export const NO_PANE_ERROR = 'This window has no in-app browser. The person is using the web or mobile app; the browser tools work only in the Team AX desktop app.'
const NO_PANE_KEEP = 200

export class BrowserRelay {
  private inner: { bridge: DesktopBridge; relay: SharedRelay } | null = null
  private noPane = new Set<string>()

  constructor(private send: (f: ClientFrame) => void, private app: () => DesktopBridge | null = desktop) {}

  private relayFor(bridge: DesktopBridge): SharedRelay {
    if (this.inner?.bridge !== bridge) {
      // the window id is checked by the server (each window gets only its own calls), so the relay is fed calls
      // directly with run() and never needs it
      this.inner = { bridge, relay: createBrowserRelay({ bridge, windowId: '', send: (f) => this.send(f) }) }
    }
    return this.inner.relay
  }

  handleCall(call: BrowserCall) {
    const bridge = this.app()
    if (bridge) return this.relayFor(bridge).run(call)
    // no pane: answer every time the call comes (a replay after a reconnect needs the result again)
    this.send({ type: 'browser.ack', callId: call.callId })
    const result: BrowserResult = { callId: call.callId, ok: false, content: [], error: NO_PANE_ERROR }
    this.send({ type: 'browser.result', result })
    this.noPane.add(call.callId)
    if (this.noPane.size > NO_PANE_KEEP) this.noPane.delete(this.noPane.values().next().value!)
  }

  cancel(callId: string) {
    this.app()?.browser.cancel(callId)
  }
}
