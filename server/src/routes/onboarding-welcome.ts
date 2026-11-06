// Route module "onboarding-welcome" (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One meeting
// note, everyone's own tasks"). Implements WELCOME
// (shared/src/api/onboarding-welcome.ts): the progress of the welcome steps and their one-time pack install, and the
// one suggestion under a result.
import { API } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { dismissSuggestion, resultSuggestion } from '../onboarding/suggestions'
import { installWelcomePack, readWelcome, setupWelcomeTeam, updateWelcome, welcomeOut } from '../onboarding/welcome'
import { startFirstResult } from '../onboarding/welcome-result'
import { getChatRuntime } from '../chat/runtime'
import type { RouteModule } from './module'

export const onboardingWelcomeRoutes: RouteModule = {
  name: 'onboarding-welcome',
  owner: 'B',
  register(kit, ctx) {
    // every answer that carries the progress carries the facts the screens read with it (deckStarted, landingSkill)
    kit.handle(API.getWelcome, () => ({ progress: welcomeOut(ctx, readWelcome(ctx)) }))
    kit.handle(API.updateWelcome, ({ body, auth }) => ({ progress: welcomeOut(ctx, updateWelcome(ctx, auth.user.id, body)) }))
    kit.handle(API.installWelcomePack, ({ auth }) => {
      // the pack is written as the owner through the file layer (their folder rules)
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      const r = installWelcomePack(ctx, auth.user.id)
      return { ...r, progress: welcomeOut(ctx, r.progress)! }
    })
    kit.handle(API.setupWelcomeTeam, ({ auth, c }) => {
      // the pack and the team folder are written as the owner through the file layer (their folder rules)
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      const r = setupWelcomeTeam(ctx, auth.user.id, c.get('locale'))
      return { ...r, progress: welcomeOut(ctx, r.progress)! }
    })
    kit.handle(API.startFirstResult, ({ auth, c, body }) => {
      // the pictures, 회사 소개.md and the chat are written as the owner through the file layer (their folder rules)
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      return startFirstResult(ctx, getChatRuntime(ctx), auth, c.get('locale'), body)
    })
    kit.handle(API.getResultSuggestion, ({ query, auth }) => ({ suggestion: resultSuggestion(ctx, auth.user.id, query.chatId, query.messageId, getChatRuntime(ctx), { phone: query.phone === '1' }) }))
    kit.handle(API.dismissSuggestion, ({ body, auth }) => { dismissSuggestion(ctx, auth.user.id, body.key) })
  },
}
