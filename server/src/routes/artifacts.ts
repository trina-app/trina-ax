// Route module "artifacts" — owner: component C (docs/WORKPLAN.md).
// Implements: ARTIFACTS
// Contract: shared/src/api/artifacts.ts
import type { RouteModule } from './module'

export const artifactsRoutes: RouteModule = {
  name: 'artifacts',
  owner: 'C',
  register(_kit, _ctx) {
    // Component C registers its endpoints here with _kit.handle(API.<name>, handler).
  },
}
