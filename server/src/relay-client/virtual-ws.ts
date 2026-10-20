// A browser WebSocket that reaches the team server as a relay stream (kind 'ws'). Implements the transport-agnostic
// VirtualWebSocket the realtime hub attaches (tab 4 "중계로 들어온 요청"). Messages ride DATA frames (WS_CONT for
// pieces, WS_BINARY for binary); close is a WS_CLOSE piece followed by END. send() respects the stream window: what
// can't go out yet stays queued (bufferedAmount), and a backlog over the cap resets the stream (the relay closes the
// browser with 4408; it reconnects and resumes).
import { WS_MAX_BUFFERED_BYTES } from '@mycel/shared/api'
import { DataFlag, RstCode, readWsClose, type Stream } from '@mycel/shared/relay-protocol'
import type { VirtualWebSocket } from '../services'

const te = new TextEncoder()
const td = new TextDecoder()
/** Safety net above the hub's own slow-client limit. */
export const VIRTUAL_WS_MAX_BACKLOG = WS_MAX_BUFFERED_BYTES + 256 * 1024
const CLOSE_WAIT_MS = 5000

export class RelayWebSocket implements VirtualWebSocket {
  readonly protocol: string
  readyState: 'open' | 'closing' | 'closed' = 'open'
  onMessage: ((data: string | Uint8Array) => void) | null = null
  onClose: ((code: number, reason: string) => void) | null = null
  private s: Stream
  private frag: Uint8Array[] = []
  private closeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(s: Stream, protocol: string) {
    this.s = s
    this.protocol = protocol
    s.onData = (b, flags) => this.recv(b, flags)
    s.onEnd = () => {
      // peer ended without a close piece: treat as an abnormal close, and end our side too
      this.closed(1006, '')
      s.end()
    }
    s.onRst = (code) => this.closed(1006, code === RstCode.FLOW_CONTROL ? 'too slow' : 'connection lost')
  }

  get bufferedAmount(): number { return this.s.outBytes }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 'open') return
    const b = typeof data === 'string' ? te.encode(data) : data
    void this.s.write(b, typeof data === 'string' ? 0 : DataFlag.WS_BINARY)
    if (this.s.outBytes > VIRTUAL_WS_MAX_BACKLOG) {
      this.s.rst(RstCode.FLOW_CONTROL, 'client too slow')
      this.closed(4408, 'too slow')
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState !== 'open') return
    this.readyState = 'closing'
    this.s.wsClose(code, reason)
    // the relay answers with the browser's close + END; don't wait forever
    this.closeTimer = setTimeout(() => {
      if (this.readyState === 'closed') return
      this.s.rst(RstCode.CANCEL, 'close timeout')
      this.closed(code, reason)
    }, CLOSE_WAIT_MS)
  }

  private recv(b: Uint8Array, flags: number): void {
    if (flags & DataFlag.WS_CLOSE) {
      const { code, reason } = readWsClose(b)
      if (this.readyState === 'open') this.s.wsClose(code, reason) // echo the close, then END
      this.closed(code, reason)
      return
    }
    if (flags & DataFlag.WS_CONT) { this.frag.push(b); return }
    let msg = b
    if (this.frag.length) {
      const total = this.frag.reduce((n, x) => n + x.byteLength, b.byteLength)
      msg = new Uint8Array(total)
      let o = 0
      for (const x of [...this.frag, b]) { msg.set(x, o); o += x.byteLength }
      this.frag = []
    }
    this.s.consumed(msg.byteLength)
    if (this.readyState !== 'open') return
    try {
      this.onMessage?.(flags & DataFlag.WS_BINARY ? msg : td.decode(msg))
    } catch {
      this.close(1011, 'internal error')
    }
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    if (this.closeTimer) clearTimeout(this.closeTimer)
    try { this.onClose?.(code, reason) } catch { /* the hub's handler failing must not break the stream */ }
  }
}
