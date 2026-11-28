// Route module "local-apps" — owner: component C (docs/WORKPLAN.md).
// Long-poll fallback of the local relay (realtime/local-relay.ts) for windows whose WebSocket is blocked (company
// proxies): GET /api/local-apps/calls waits for local.call of this window, POST /api/local-apps/results answers one.
// Contract: shared/src/api/local-apps.ts
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { getChatRuntime } from '../chat/runtime'
import { MCP_CALL_MAX_BYTES } from '../integrations/connections/mcp'
import { linkResponse } from '../integrations/connections/local-file-links'

export const localAppsRoutes: RouteModule = {
  name: 'local-apps',
  owner: 'C',
  register(kit, ctx) {
    const rt = getChatRuntime(ctx)
    kit.handle(API.pollLocalCalls, async ({ c, query, auth }) => {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(query.windowId)) fail('validation', undefined, { fields: { 'query.windowId': 'bad window id' } })
      const calls = await rt.localRelay.poll(auth.user.id, query.windowId, query.waitMs ?? 25_000, c.req.raw.signal)
      return { calls }
    })
    // an answer may carry a screenshot inline, as an MCP server's does (mcp.ts MCP_CALL_MAX_BYTES)
    kit.handle(API.postLocalResult, ({ body, auth }) => {
      if (!rt.localRelay.result(auth.user.id, body)) fail('not_found')
    }, { jsonLimit: MCP_CALL_MAX_BYTES + 1024 * 1024 })
    // a team file that an app's code or task downloads (local-file-links.ts): outside /api, the token is the auth (the
    // app on the computer has no sign-in of the team page), one download
    kit.raw('GET', '/team-file-links/:token', (c) => linkResponse(ctx, rt.localRelay.links, c.req.raw, c.req.param('token') ?? ''))
  },
}
