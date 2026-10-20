// Route module "admin" — owner: component A (docs/WORKPLAN.md).
// Implements: ADMIN (users, invites, groups, folders + rules + preview, engines, budgets, settings, usage, audit)
// Contract: shared/src/api/admin.ts
import type { RouteModule } from './module'

export const adminRoutes: RouteModule = {
  name: 'admin',
  owner: 'A',
  register(_kit, _ctx) {
    // Component A registers its endpoints here with _kit.handle(API.<name>, handler).
  },
}
