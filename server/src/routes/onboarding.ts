// Route module "onboarding" (docs/DECISIONS.md "D — Company profile from the company website").
// Implements: ONBOARDING (the company profile: read, save, draft from the website or pasted text; a team skill from an
// answer, server/src/onboarding/skill-draft.ts). Contract:
// shared/src/api/onboarding.ts. The profile file and its rules: server/src/onboarding/profile.ts; drafts (a chat turn
// of the caller): server/src/onboarding/draft.ts.
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { getChatRuntime } from '../chat/runtime'
import { mapErrors } from '../team-files/errors'
import { readCompanyProfile, saveCompanyProfile } from '../onboarding/profile'
import { profileDraftState, startProfileDraft } from '../onboarding/draft'
import { saveSkillDraft, skillDraftState, startSkillDraft } from '../onboarding/skill-draft'
import { fail } from '../http/errors'

export const onboardingRoutes: RouteModule = {
  name: 'onboarding',
  owner: 'B',
  register(kit, ctx) {
    const principal = (id: string) => { try { return ctx.files.principal(id) } catch { return fail('forbidden') } }
    // any signed-in member; the folder rules of skills/ decide: someone who cannot read the file gets null
    kit.handle(API.getCompanyProfile, ({ auth }) => ({ profile: readCompanyProfile(ctx.files, principal(auth.user.id)) }))
    // owner or admin (the endpoint), written as them through the file layer (the folder rules of skills/ again)
    kit.handle(API.saveCompanyProfile, ({ c, body, auth }) => mapErrors(c.get('locale'), () => saveCompanyProfile(ctx.files, auth.user.id, body, c.get('locale'))))
    kit.handle(API.startProfileDraft, ({ c, body, auth }) => startProfileDraft(ctx, getChatRuntime(ctx), auth, c.get('locale'), body))
    kit.handle(API.getProfileDraft, ({ params, auth }) => profileDraftState(ctx, getChatRuntime(ctx), auth.user.id, params.chatId))
    // a team skill from one of the caller's answers (docs/DECISIONS.md "S"): a draft turn of theirs, then their own save
    kit.handle(API.startSkillDraft, ({ c, body, auth }) => startSkillDraft(ctx, getChatRuntime(ctx), auth, c.get('locale'), body))
    kit.handle(API.getSkillDraft, ({ params, auth }) => skillDraftState(ctx, getChatRuntime(ctx), auth.user.id, params.chatId))
    kit.handle(API.saveSkillDraft, ({ c, params, body, auth }) => mapErrors(c.get('locale'), () => saveSkillDraft(ctx, getChatRuntime(ctx), auth, c.get('locale'), params.chatId, body)))
  },
}
