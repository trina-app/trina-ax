// Route module "onboarding-welcome" (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding", "M — One meeting
// note, everyone's own tasks", "W6 — Onboarding v6"). Implements WELCOME
// (shared/src/api/onboarding-welcome.ts): the progress of the welcome steps, every team's start (the team group, once),
// 회사 소개's brand materials, and the one suggestion under a result.
import { API } from '@mycel/shared/api'
import { fail, HttpError } from '../http/errors'
import { dismissSuggestion, resultSuggestion } from '../onboarding/suggestions'
import { markWelcomeOpened, readWelcome, setupWelcomeTeam, updateWelcome, welcomeOut } from '../onboarding/welcome'
import { brandOnRead, placeBrand } from '../onboarding/welcome-result'
import { getChatRuntime } from '../chat/runtime'
import type { AppContext } from '../context'
import type { RouteModule } from './module'

/** The team's start and the brand action fail quietly on the welcome steps (the owner is never held there, and the team
 * files step falls back to shared/). An unexpected error is logged by the app's error handler ("unhandled error" with
 * the path, app.ts); a refusal (HttpError) is an ordinary answer there and leaves no line, so it is logged here as a
 * warning with its code (QA: a hosted team's team files step had no folder). Thrown on as before. */
function logged<T>(ctx: AppContext, what: string, userId: string, run: () => T): T {
  try { return run() } catch (err) {
    if (err instanceof HttpError) ctx.log.warn(`${what} was refused in the welcome steps`, { err, userId, code: err.code })
    throw err
  }
}

export const onboardingWelcomeRoutes: RouteModule = {
  name: 'onboarding-welcome',
  owner: 'B',
  register(kit, ctx) {
    // every answer that carries the progress carries the facts the screens read with it (deckStarted, landingSkill).
    // A read first puts in the brand materials of an old row whose profile was saved without a deck, once (brandOnRead)
    kit.handle(API.getWelcome, () => {
      brandOnRead(ctx)
      return { progress: welcomeOut(ctx, readWelcome(ctx)) }
    })
    kit.handle(API.updateWelcome, ({ body, auth }) => ({ progress: welcomeOut(ctx, updateWelcome(ctx, auth.user.id, body)) }))
    kit.handle(API.setupWelcomeTeam, ({ auth, c }) => {
      // the team folder is made as the owner through the file layer (their folder rules)
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      const r = logged(ctx, 'the team start', auth.user.id, () => setupWelcomeTeam(ctx, auth.user.id, c.get('locale')))
      return { ...r, progress: welcomeOut(ctx, r.progress)! }
    })
    kit.handle(API.welcomeBrand, ({ auth, c, body }) => {
      // the pictures and 회사 소개.md are written as the owner through the file layer (their folder rules)
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      markWelcomeOpened(ctx)
      const r = logged(ctx, 'the brand action', auth.user.id, () => placeBrand(ctx, auth.user.id, c.get('locale'), body, { siteIcon: true }))
      return { ...r, progress: welcomeOut(ctx, readWelcome(ctx))! }
    })
    kit.handle(API.getResultSuggestion, ({ query, auth }) => ({ suggestion: resultSuggestion(ctx, auth.user.id, query.chatId, query.messageId, getChatRuntime(ctx), { phone: query.phone === '1' }) }))
    kit.handle(API.dismissSuggestion, ({ body, auth }) => { dismissSuggestion(ctx, auth.user.id, body.key) })
  },
}
