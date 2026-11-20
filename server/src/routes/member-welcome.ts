// Route module "member-welcome" (docs/DECISIONS.md "A welcome for invited people"). Implements: MEMBER_WELCOME (the
// welcome card on Home for invited people). Contract: shared/src/api/member-welcome.ts; logic:
// server/src/onboarding/member-welcome.ts.
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { updateWelcome, welcomeAnswer } from '../onboarding/member-welcome'

export const memberWelcomeRoutes: RouteModule = {
  name: 'member-welcome',
  owner: 'B',
  register(kit, ctx) {
    // the caller's own card only: there is no id in the address, and nobody reads or changes anyone else's
    kit.handle(API.getMemberWelcome, ({ auth }) => welcomeAnswer(ctx, auth.user.id))
    kit.handle(API.updateMemberWelcome, ({ auth, body }) => updateWelcome(ctx, auth.user.id, body))
  },
}
