// Route module "ws" — owner: component B (docs/WORKPLAN.md).
// GET /api/ws: WebSocket upgrade (off-contract route; protocol in shared/src/api/ws.ts). The hub authenticates
// after the upgrade so the browser sees a close code (4401 sign in, 4403 origin, 4400 bad parameters) instead of
// an opaque failed handshake. The relay client attaches its virtual sockets through ctx.services.realtime.attach.
import type { ServerWebSocket } from 'bun'
import { WS_PATH, WS_PROTOCOL } from '@mycel/shared/api'
import type { RouteModule } from './module'
import type { RealtimeConn } from '../services'
import { fail } from '../http/errors'
import type { AppContextC } from '../http/env'
import { getChatRuntime } from '../chat/runtime'

interface WsData {
  /** hono/bun's websocket handler (main.ts) dispatches to these */
  events: {
    onOpen?(evt: Event, ws: { raw: ServerWebSocket<WsData> }): void
    onMessage?(evt: MessageEvent, ws: { raw: ServerWebSocket<WsData> }): void
    onClose?(evt: CloseEvent, ws: { raw: ServerWebSocket<WsData> }): void
  }
  url: URL
  protocol: string
}

export interface ConnHooks { message: ((d: string) => void)[]; close: (() => void)[]; closed: boolean }

/** Wrap a Bun ServerWebSocket as a RealtimeConn. The hub registers its handlers only after the (async) session
 * lookup; a socket that closed meanwhile calls a late onClose handler at once, so it never stays "open". */
export function bunConn(ws: ServerWebSocket<WsData>, hooks: ConnHooks): RealtimeConn {
  return {
    send(d) { if (!hooks.closed) ws.send(d) },
    close(code, reason) { try { ws.close(code, reason) } catch {} },
    bufferedAmount() { try { return ws.getBufferedAmount() } catch { return 0 } },
    ping() { if (!hooks.closed) ws.ping() },
    onMessage(fn) { hooks.message.push(fn) },
    onClose(fn) { if (hooks.closed) fn(); else hooks.close.push(fn) },
  }
}

export const wsRoutes: RouteModule = {
  name: 'ws',
  owner: 'B',
  register(kit, ctx) {
    kit.raw('GET', WS_PATH, async (c) => {
      if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') fail('bad_request', 'WebSocket upgrade expected')
      const server = (c.env as { server?: { upgrade(req: Request, o: { data: WsData; headers?: HeadersInit }): boolean } } | undefined)?.server
      if (!server) fail('unavailable', 'WebSockets are not available on this connection')
      const req = c.req.raw
      const info = (c as unknown as AppContextC).get('info')
      const offered = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      // answer with our protocol name, never echo the bearer-token protocol
      const chosen = offered.includes(WS_PROTOCOL) ? WS_PROTOCOL : null
      const hooks: ConnHooks = { message: [], close: [], closed: false }
      const data: WsData = {
        url: new URL(req.url),
        protocol: chosen ?? '',
        events: {
          onOpen(_e, ws) {
            const conn = bunConn(ws.raw, hooks)
            void getChatRuntime(ctx).hub.attach(conn, req, info).catch((err: unknown) => {
              ctx.log.error('websocket attach failed', { err })
              conn.close(1011, 'internal error')
            })
          },
          onMessage(e) {
            const d = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)
            for (const f of hooks.message) f(d)
          },
          onClose() { hooks.closed = true; for (const f of hooks.close.splice(0)) f() },
        },
      }
      // Bun upgrades only the request object it handed over: through the office public address app.fetch got an https
      // copy (http/tunnel.ts), the original is in env.upgradeReq. The hub checks the copy (https Origin, cookie name).
      const original = (c.env as { upgradeReq?: Request } | undefined)?.upgradeReq ?? req
      const ok = server!.upgrade(original, { data, headers: chosen ? { 'Sec-WebSocket-Protocol': chosen } : undefined })
      if (!ok) fail('bad_request', 'WebSocket upgrade failed')
      return new Response(null)
    })
  },
}
