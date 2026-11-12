// Route module "often-asked" (docs/DECISIONS.md "Home: what my group often asks"; chat/often-asked.ts,
// chat/often-asked-run.ts): Home's list for the caller, and the timer of the daily run (items past the 3-day hold go,
// a run starts when one is due).
import { API } from '@mycel/shared/api'
import { oftenAskedFor } from '../chat/often-asked'
import { startOftenAsked } from '../chat/often-asked-run'
import type { RouteModule } from './module'

export const oftenAskedRoutes: RouteModule = {
  name: 'often-asked',
  owner: 'B',
  register(kit, ctx) {
    startOftenAsked(ctx)
    kit.handle(API.oftenAsked, ({ auth }) => oftenAskedFor(ctx.db, auth.user.id))
  },
}
