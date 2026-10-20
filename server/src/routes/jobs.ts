// Route module "jobs" — owner: component C (docs/WORKPLAN.md).
// Implements: JOBS (get, cancel, transcribe)
// Contract: shared/src/api/jobs.ts
import type { RouteModule } from './module'

export const jobsRoutes: RouteModule = {
  name: 'jobs',
  owner: 'C',
  register(_kit, _ctx) {
    // Component C registers its endpoints here with _kit.handle(API.<name>, handler).
  },
}
