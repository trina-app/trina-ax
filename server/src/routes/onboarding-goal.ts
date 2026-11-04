// Route module "onboarding-goal" (docs/DECISIONS.md "G — The 7-day team goal"). Implements: ONBOARDING_GOAL (the card
// on Home for owners and admins). Contract: shared/src/api/onboarding-goal.ts; counting: server/src/onboarding/goal.ts.
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { teamGoal } from '../onboarding/goal'

export const onboardingGoalRoutes: RouteModule = {
  name: 'onboarding-goal',
  owner: 'B',
  register(kit, ctx) {
    // owner or admin (the endpoint's auth level); names of the people who ran the top skill, and while the goal is
    // open at most one name of someone who joined and has not run it (the rest a count, never a list)
    kit.handle(API.getTeamGoal, ({ auth }) => ({ goal: teamGoal(ctx, auth.user.id) }))
  },
}
