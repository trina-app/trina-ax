// Route module "skill-shares" (docs/DECISIONS.md "SK — 내 스킬 가져오기"). Implements: SKILL_SHARES
// (shared/src/api/skill-shares.ts): an owner's or admin's share proposals of their own Claude skills, created from a
// picked .claude folder (Claude Code sends them through the connector's share_skills tool instead), read, applied and
// dismissed by the person who made them only; a merge chat that waits for its person is started by them (share-merge.ts).
// Members get 403 from the endpoints' `auth: 'admin'` (their way stays "스킬로 제안"). The work:
// server/src/skills/share.ts.
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { getChatRuntime } from '../chat/runtime'
import { applySkillShare, createSkillShare, dismissSkillShare, getSkillShare, listSkillShares, SKILL_SHARE_BODY_MAX } from '../skills/share'
import { startOpenedMerge } from '../skills/share-merge'

export const skillSharesRoutes: RouteModule = {
  name: 'skill-shares',
  owner: 'B',
  register(kit, ctx) {
    const rt = () => getChatRuntime(ctx)
    kit.handle(API.createSkillShare, ({ c, body, auth }) => createSkillShare(ctx, rt(), auth.user, c.get('locale'), body, { via: 'app' }), { jsonLimit: SKILL_SHARE_BODY_MAX })
    kit.handle(API.listSkillShares, ({ query, auth }) => ({ items: listSkillShares(ctx, rt(), auth.user.id, query) }))
    kit.handle(API.getSkillShare, ({ params, auth }) => getSkillShare(ctx, rt(), auth.user.id, params.id))
    kit.handle(API.applySkillShare, ({ c, params, body, auth }) => applySkillShare(ctx, rt(), auth, c.get('locale'), params.id, body))
    kit.handle(API.dismissSkillShare, ({ params, auth }) => { dismissSkillShare(ctx, rt(), auth.user.id, params.id) })
    // a merge chat made at the end of the welcome steps starts when its person opens it (docs/DECISIONS.md "W5")
    kit.handle(API.startSkillMerge, ({ params, auth }) => ({ started: startOpenedMerge(ctx, rt(), auth.user, params.id) }))
  },
}
