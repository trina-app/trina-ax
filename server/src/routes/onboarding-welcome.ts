// Route module "onboarding-welcome" (docs/DECISIONS.md "W — Welcome steps"). Implements WELCOME
// (shared/src/api/onboarding-welcome.ts): the progress of the welcome steps and their one-time pack install.
import { API } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { installWelcomePack, readWelcome, updateWelcome } from '../onboarding/welcome'
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
  },
}
