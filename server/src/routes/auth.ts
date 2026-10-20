// Route module "auth" — owner: component A (docs/WORKPLAN.md).
// Implements: AUTH (setup, login, logout, password, me, sessions, invite info/accept)
// Contract: shared/src/api/auth.ts
import type { RouteModule } from './module'

export const authRoutes: RouteModule = {
  name: 'auth',
  owner: 'A',
  register(_kit, _ctx) {
    // Component A registers its endpoints here with _kit.handle(API.<name>, handler).
  },
}
