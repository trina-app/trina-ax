// Apps on the person's computer (docs/decisions/20261118-local-app-connectors.md): the sibling of the browser relay on
// the same base (call-relay.ts). One JSON-RPC message for an app's program goes as local.call to the one desktop window
// that sent the turn (or that asked for the Settings check), and its answer comes back as local.result (WebSocket
// frame, or POST /api/local-apps/results on the long-poll path). The desktop app starts the program on that computer
// and passes the message on; nothing else of the computer is reached.
import { LocalResult, type LocalAppSpec, type LocalCall } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import type { Hub } from './hub'
import type { Logger } from '../log'
import { CallRelay, type CallRelayOptions } from './call-relay'
import { LocalFileLinks } from '../integrations/connections/local-file-links'

export const LOCAL_NO_WINDOW = 'local_unavailable: the desktop app window that sent this message is not connected'
export const LOCAL_WINDOW_GONE = 'local_unavailable: the desktop app window did not come back'

export class LocalRelay extends CallRelay<LocalCall, LocalResult> {
  /** one-time links to team files that an app's code or task downloads (local-file-links.ts) */
  readonly links = new LocalFileLinks()
  constructor(hub: Hub, log: Logger, o: CallRelayOptions = {}) {
    // a tools/call may run as long as an MCP server's (mcp.ts MCP_CALL_TIMEOUT_MS): the caller sets each call's limit
    super(hub, log, {
      callFrame: (windowId, call) => ({ type: 'local.call', data: { windowId, call } }),
      cancelFrame: (windowId, callId) => ({ type: 'local.cancel', data: { windowId, callId } }),
      failure: (callId, error) => ({ callId, ok: false, error }),
      parse: (raw) => { const r = LocalResult.safeParse(raw); return r.success ? r.data : null },
      noWindow: LOCAL_NO_WINDOW,
      windowGone: LOCAL_WINDOW_GONE,
      name: (call) => `local ${String(call.message.method ?? 'message').slice(0, 40)}`,
    }, { callTimeoutMs: 16 * 60_000, ...o })
    hub.onClientFrame((s, f) => {
      if (f.type === 'local.ack') this.ack(s.userId, f.callId)
      else if (f.type === 'local.result') this.result(s.userId, f.result)
    })
  }

  /** The turn ended: its calls are cancelled (CallRelay) and its team file links that were not used go. */
  override cancelTurn(turnId: string) {
    super.cancelTurn(turnId)
    this.links.endTurn(turnId)
  }

  /** Pass one JSON-RPC message to the program of `connectionId` on the computer of this window. Never throws. */
  async call(o: { userId: string; windowId: string; turnId: string | null; connectionId: string; name: string; spec: LocalAppSpec; message: Record<string, unknown>; timeoutMs: number; signal?: AbortSignal }): Promise<LocalResult> {
    const callId = uuidv7()
    const call: LocalCall = { callId, turnId: o.turnId, connectionId: o.connectionId, name: o.name, spec: o.spec, message: o.message, deadline: Date.now() + o.timeoutMs }
    const r = await this.open({ userId: o.userId, windowId: o.windowId, call, timeoutMs: o.timeoutMs, timeoutError: `${o.name} did not answer in time`, signal: o.signal })
    return { ...r, callId }
  }
}
