// Route module "ws" — owner: component B (docs/WORKPLAN.md).
// Implements: GET /api/ws (WebSocket: hello/resync/reset, events with seq, browser.call/result)
// Contract: shared/src/api/ws.ts
import type { RouteModule } from './module'

export const wsRoutes: RouteModule = {
  name: 'ws',
  owner: 'B',
  register(_kit, _ctx) {
    // Component B registers its endpoints here with _kit.handle(API.<name>, handler).
  },
}
