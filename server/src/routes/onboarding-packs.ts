// Recommended skill packs (onboarding/skill-packs.ts): POST /api/onboarding/packs/:id/install, owners and admins.
// Other people's skill lists follow by themselves: every file written sends files.changed to those who can see it.
import { API, SkillPackId } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { installSkillPack } from '../onboarding/skill-packs'
import type { RouteModule } from './module'

export const onboardingPacksRoutes: RouteModule = {
  name: 'onboarding-packs', owner: 'B',
  register(kit, ctx) {
    kit.handle(API.installSkillPack, ({ params, auth }) => {
      const id = SkillPackId.safeParse(params.id)
      if (!id.success) return fail('not_found')
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      return installSkillPack(ctx, auth.user.id, id.data)
    })
  },
}
