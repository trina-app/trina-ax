// Route module "browser" — owner: component B (docs/WORKPLAN.md).
// Implements: BROWSER (long-poll fallback for browser.call / browser.result)
// Contract: shared/src/api/browser.ts
import type { RouteModule } from './module'

export const browserRoutes: RouteModule = {
  name: 'browser',
  owner: 'B',
  register(_kit, _ctx) {
    // Component B registers its endpoints here with _kit.handle(API.<name>, handler).
  },
}
