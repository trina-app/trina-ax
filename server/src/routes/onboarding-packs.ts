// Recommended skill packs (onboarding/skill-packs.ts; docs/DECISIONS.md "W6"), owners and admins: GET
// /api/onboarding/packs (the catalog: 내 스킬's rows and the Team skills fold) and POST /api/onboarding/packs/:id/install
// (the skills a person checked, or the whole pack). An owner's install that put anything in marks 내 스킬 done while
// their welcome steps are under way, as a share applied anywhere does (onboarding/welcome.ts recordShared). Before a
// visual skill goes in on the owner's press, the brand materials are placed when they are not yet (welcome-result.ts
// ensureBrand, FLOW-v6 §1A): the website's pictures and 회사 소개.md that 회사 소개서, 카드뉴스 and 홍보 영상 read. An
// admin's press leaves them as they are, not done: written under the admin's account they would be marked done with
// whatever that account reaches, and the owner's next 회사 소개 save (or the server's run on a read) places them as the
// owner.
// Other people's skill lists follow by themselves: every file written sends files.changed to those who can see it.
import { API, SkillPackId } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { installSkillPack, onVisualSkillInstall, skillPackCatalog } from '../onboarding/skill-packs'
import { ensureBrand } from '../onboarding/welcome-result'
import { readWelcome, updateWelcome } from '../onboarding/welcome'
import type { RouteModule } from './module'

/** The brand materials before a visual skill goes in, on the team owner's own press only (see above). One function, so
 * registering it again (another app in the same process) adds nothing. */
function brandBeforeVisual(ctx: AppContext, userId: string): void {
  const owner = ctx.db.query("SELECT 1 FROM users WHERE id = ? AND role = 'owner' AND deleted_at IS NULL").get(userId)
  if (owner) ensureBrand(ctx, userId)
}

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
    onVisualSkillInstall(brandBeforeVisual)
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
