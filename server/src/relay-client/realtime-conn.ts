// A relay WebSocket (VirtualWebSocket) as the realtime hub's RealtimeConn, so a browser that reaches the team over
// the relay is attached by RealtimeHub.attach exactly like a direct Bun upgrade (tab 4 "중계로 들어온 요청").
// Same rules as routes/ws.ts bunConn: the hub registers its handlers only after the async session lookup, so a
// connection that closed meanwhile calls a late onClose handler at once (it never stays "open"), and messages that
// arrive before the hub listens are dropped (the client speaks only after `hello`).
import type { RealtimeConn, VirtualWebSocket } from '../services'

const td = new TextDecoder()

export function relayConn(ws: VirtualWebSocket): RealtimeConn {
  const message: ((d: string) => void)[] = []
  const close: (() => void)[] = []
  let closed = ws.readyState === 'closed'
  ws.onMessage = (d) => {
    const text = typeof d === 'string' ? d : td.decode(d)
    for (const f of message) f(text)
  }
  ws.onClose = () => {
    if (closed) return
    closed = true
    for (const f of close.splice(0)) { try { f() } catch { /* one handler failing must not skip the others */ } }
  }
  return {
    send(d) { if (!closed) ws.send(d) },
    close(code, reason) { try { ws.close(code, reason) } catch { /* already gone */ } },
    bufferedAmount() { return ws.bufferedAmount },
    // no ping: the relay keeps the browser connection alive itself
    onMessage(fn) { message.push(fn) },
    onClose(fn) { if (closed) fn(); else close.push(fn) },
  }
}
