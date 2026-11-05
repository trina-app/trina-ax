// Route module "onboarding-welcome" (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One meeting
// note, everyone's own tasks"). Implements WELCOME
// (shared/src/api/onboarding-welcome.ts): the progress of the welcome steps and their one-time pack install, and the
// one suggestion under a result.
import { API } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { dismissSuggestion, resultSuggestion } from '../onboarding/suggestions'
import { installWelcomePack, readWelcome, setupWelcomeTeam, updateWelcome } from '../onboarding/welcome'
import type { RouteModule } from './module'

export const onboardingWelcomeRoutes: RouteModule = {
  name: 'onboarding-welcome',
  owner: 'B',
  register(kit, ctx) {
    kit.handle(API.getWelcome, () => ({ progress: readWelcome(ctx) }))
    kit.handle(API.updateWelcome, ({ body, auth }) => ({ progress: updateWelcome(ctx, auth.user.id, body) }))
    kit.handle(API.installWelcomePack, ({ auth }) => {
      // the pack is written as the owner through the file layer (their folder rules)
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      return installWelcomePack(ctx, auth.user.id)
    })
    kit.handle(API.setupWelcomeTeam, ({ auth, c }) => {
      // the pack and the team folder are written as the owner through the file layer (their folder rules)
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      return setupWelcomeTeam(ctx, auth.user.id, c.get('locale'))
    })
    kit.handle(API.getResultSuggestion, ({ query, auth }) => ({ suggestion: resultSuggestion(ctx, auth.user.id, query.chatId, query.messageId) }))
    kit.handle(API.dismissSuggestion, ({ body, auth }) => { dismissSuggestion(ctx, auth.user.id, body.key) })
  },
}
