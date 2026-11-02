// pc.call -> the desktop app of this window -> pc.result over the WebSocket (docs/DECISIONS.md "PC runner"). The page only
// passes calls on: the person answers in the desktop app's own view. A window without the app answers at once with an
// error the AI can act on, instead of letting the turn wait.
import { createPcRelay, PRODUCT, type DesktopBridge, type PcRelay as SharedRelay } from '@mycel/shared'
import type { ClientFrame, PcCall, PcResult } from '@mycel/shared/api'
import { desktop } from './desktop'

export const NO_APP_ERROR = `pc_unavailable: this window is not the ${PRODUCT.displayName} desktop app. Tell the person to send the message from the desktop app.`
export const OLD_APP_ERROR = `pc_unavailable: the ${PRODUCT.displayName} desktop app of this person is too old for the PC tools. Ask them to update it.`

export class PcRelay {
  private inner: { pc: NonNullable<DesktopBridge['pc']>; relay: SharedRelay } | null = null

  constructor(private send: (f: ClientFrame) => void, private app: () => DesktopBridge | null = desktop) {}

  handleCall(call: PcCall) {
    const bridge = this.app()
    if (bridge?.pc) {
      if (this.inner?.pc !== bridge.pc) {
        this.inner?.relay.dispose()
        this.inner = { pc: bridge.pc, relay: createPcRelay({ pc: bridge.pc, send: (f) => this.send(f) }) }
      }
      return this.inner.relay.run(call)
    }
    // answer every time the call comes (a replay after a reconnect needs the result again)
    this.send({ type: 'pc.ack', callId: call.callId })
    const error = bridge ? OLD_APP_ERROR : NO_APP_ERROR
    const result: PcResult = { callId: call.callId, ok: false, content: [], error, approval: 'none' }
    this.send({ type: 'pc.result', result })
  }

  cancel(callId: string) {
    this.inner?.relay.cancel(callId)
  }
}
