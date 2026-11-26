// Route module "browser" — owner: component B (docs/WORKPLAN.md).
// Long-poll fallback of the browser relay for windows whose WebSocket is blocked (company proxies):
// GET /api/browser/calls waits for browser.call of this window, POST /api/browser/results answers one.
// Contract: shared/src/api/browser.ts
import { API, BrowserUploadTicket } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { getChatRuntime } from '../chat/runtime'

/** Screenshots come back base64 inside the result (contract: up to 20 MB of image data). */
export const BROWSER_RESULT_LIMIT = 25 * 1024 * 1024

export const browserRoutes: RouteModule = {
  name: 'browser',
  owner: 'B',
  register(kit, ctx) {
    const rt = getChatRuntime(ctx)
    kit.handle(API.pollCalls, async ({ c, query, auth }) => {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(query.windowId)) fail('validation', undefined, { fields: { 'query.windowId': 'bad window id' } })
      const calls = await rt.relay.poll(auth.user.id, query.windowId, query.waitMs ?? 25_000, c.req.raw.signal, query.pane)
      return { calls }
    })
    // file_upload's files, one ticket each (realtime/browser-uploads.ts): the person's own, once, after the file is
    // checked again; whatever goes wrong is the same 404 (no hint whether a ticket exists or whose it is)
    kit.handle(API.browserUpload, ({ c, auth }) => {
      const ticket = c.req.param('ticket') ?? ''
      const got = BrowserUploadTicket.safeParse(ticket).success ? rt.relay.uploads.take(ticket, auth.user.id) : null
      if (!got) return fail('not_found')
      // the Buffer as it is (no copy of up to 100 MB)
      return new Response(got.bytes as unknown as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(got.bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' },
      })
    })
    kit.handle(API.postResult, ({ body, auth }) => {
      if (!rt.relay.result(auth.user.id, body)) fail('not_found')
    }, { jsonLimit: BROWSER_RESULT_LIMIT })
  },
}
