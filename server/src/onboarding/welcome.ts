// The welcome steps' progress (docs/DECISIONS.md "W — Welcome steps"; contract shared/src/api/onboarding-welcome.ts):
// one settings row of the team, so the steps resume on another device. The owner writes it, owners and admins read
// it. The marketing pack is installed here at most once: the row records that it ran, and a second call (the same
// choice again, a resume, two windows) does not install again, since installing again would restore skills someone
// deleted on purpose (stream C). Everything below is synchronous, so a check and its write never interleave with
// another request's.
import { normalizeWebsite, WelcomeProgress, type WelcomeUpdate, type WelcomePackResult, WELCOME_RESULT_SKILL } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getSetting, setSetting } from '../admin/settings'
import { fail } from '../http/errors'
import { installSkillPack } from './skill-packs'

export const WELCOME_SETTING = 'onboarding.welcome'

const fresh = (now: string): WelcomeProgress => ({
  startedAt: now, updatedAt: now, teamType: null,
  steps: { team: null, profile: null, result: null, invite: null },
  pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
})

/** The stored progress, or null when the steps were never opened (or the row does not read). */
export function readWelcome(ctx: Pick<AppContext, 'db'>): WelcomeProgress | null {
  const v = WelcomeProgress.safeParse(getSetting(ctx.db, WELCOME_SETTING))
  return v.success ? v.data : null
}

/** team, profile and result done, and the invite either way */
export const welcomeFinished = (p: WelcomeProgress) => p.steps.team === 'done' && p.steps.profile === 'done' && p.steps.result === 'done' && p.steps.invite !== null

function save(ctx: Pick<AppContext, 'db'>, p: WelcomeProgress, now: string): WelcomeProgress {
  if (!p.finishedAt && welcomeFinished(p)) p.finishedAt = now
  p.updatedAt = now
  setSetting(ctx.db, WELCOME_SETTING, p)
  return p
}

/** Apply one change of the owner's (an empty change only starts the progress). */
export function updateWelcome(ctx: Pick<AppContext, 'db'>, userId: string, u: WelcomeUpdate): WelcomeProgress {
  const now = new Date().toISOString()
  const p = readWelcome(ctx) ?? fresh(now)
  if (u.resultChatId !== undefined) {
    // the bar shows on this chat: one of the caller's own, not deleted
    const own = ctx.db.query('SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(u.resultChatId, userId)
    if (!own) fail('not_found')
    p.resultChatId = u.resultChatId
  }
  if (u.teamType) p.teamType = u.teamType
  if (u.step) {
    // done stays done: going back to a step and putting it off again does not undo it
    if (u.step.state === 'done' || p.steps[u.step.id] !== 'done') p.steps[u.step.id] = u.step.state
    // the invite put off before there was a result comes back once there is one (the bar on the result chat)
    if (u.step.id === 'result' && u.step.state === 'done' && p.steps.invite === 'skipped') p.steps.invite = null
  }
  if (u.inviteShown && !p.inviteShownAt) p.inviteShownAt = now
  if (u.site !== undefined) {
    const site = normalizeWebsite(u.site)
    if (site) p.site = site
  }
  if (u.dismissed !== undefined) p.dismissedAt = u.dismissed ? (p.dismissedAt ?? now) : null
  return save(ctx, p, now)
}

/** Install the marketing pack for these steps unless they already did (then nothing runs). */
export function installWelcomePack(ctx: AppContext, userId: string): WelcomePackResult {
  const now = new Date().toISOString()
  const p = readWelcome(ctx) ?? fresh(now)
  if (p.pack) return { progress: p, install: null }
  const install = installSkillPack(ctx, userId, 'marketing')
  // the ad copy as installed; when another team skill already has its name, "/ad-copy" runs that one: point there
  const adCopy = install.skills.find((s) => s.path === WELCOME_RESULT_SKILL)
  const skillPath = adCopy?.status === 'blocked' && adCopy.sameNameAs ? adCopy.sameNameAs : WELCOME_RESULT_SKILL
  p.pack = { id: 'marketing', at: now, skillPath }
  return { progress: save(ctx, p, now), install }
}
