// Recommended skill packs (onboarding/skill-packs.ts; docs/DECISIONS.md "W6"), owners and admins: GET
// /api/onboarding/packs (the catalog: 내 스킬's rows and the Team skills fold) and POST /api/onboarding/packs/:id/install
// (the skills a person checked, or the whole pack). An owner's install that put anything in marks 내 스킬 done while
// their welcome steps are under way, as a share applied anywhere does (onboarding/welcome.ts recordShared).
// Other people's skill lists follow by themselves: every file written sends files.changed to those who can see it.
import { API, SkillPackId } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { installSkillPack, skillPackCatalog } from '../onboarding/skill-packs'
import { readWelcome, updateWelcome } from '../onboarding/welcome'
import type { RouteModule } from './module'

/** 내 스킬 done for the owner whose welcome steps are under way (a row, not finished); never throws: the skills are in. */
function recordInWelcome(ctx: AppContext, user: { id: string; role: string }): void {
  if (user.role !== 'owner') return
  try {
    const p = readWelcome(ctx)
    if (p && !p.finishedAt && p.steps.skills !== 'done') updateWelcome(ctx, user.id, { step: { id: 'skills', state: 'done' } })
  } catch (err) {
    ctx.log.warn('welcome step not recorded after a pack install', { err })
  }
}

export const onboardingPacksRoutes: RouteModule = {
  name: 'onboarding-packs', owner: 'B',
  register(kit, ctx) {
    kit.handle(API.listSkillPacks, ({ c, auth }) => {
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      return skillPackCatalog(ctx, auth.user.id, c.get('locale'))
    })
    kit.handle(API.installSkillPack, ({ params, body, auth }) => {
      const id = SkillPackId.safeParse(params.id)
      if (!id.success) return fail('not_found')
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      const r = installSkillPack(ctx, auth.user.id, id.data, body.skills)
      if (r.skills.some((s) => s.status !== 'blocked')) recordInWelcome(ctx, auth.user)
      return r
    })
  },
}
