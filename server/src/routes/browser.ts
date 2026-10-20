// Route module "browser" — owner: component B (docs/WORKPLAN.md).
// Long-poll fallback of the browser relay for windows whose WebSocket is blocked (company proxies):
// GET /api/browser/calls waits for browser.call of this window, POST /api/browser/results answers one.
// Contract: shared/src/api/browser.ts
import { API } from '@mycel/shared/api'
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
      const calls = await rt.relay.poll(auth.user.id, query.windowId, query.waitMs ?? 25_000, c.req.raw.signal)
      return { calls }
    })
    kit.handle(API.postResult, ({ body, auth }) => {
      if (!rt.relay.result(auth.user.id, body)) fail('not_found')
    }, { jsonLimit: BROWSER_RESULT_LIMIT })
  },
}
