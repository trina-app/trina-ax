// The welcome steps' progress (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding"; contract
// shared/src/api/onboarding-welcome.ts):
// one settings row of the team, so the steps resume on another device. The owner writes it, owners and admins read
// it. The marketing pack is installed here at most once: the row records that it ran, and a second call (the same
// choice again, a resume, two windows) does not install again, since installing again would restore skills someone
// deleted on purpose (stream C). Everything below is synchronous, so a check and its write never interleave with
// another request's. A `team` step of a row written before the team type stopped being a step is kept, not read.
//
// The row is read field by field: a field that does not read (a later release changed it, a hand edit) falls back to
// its default for display, and a write changes only the fields it sets, keeping everything else of the stored object
// as it was (unknown fields too). A recorded pack counts as installed whatever its shape, so nothing resets it. A
// row that is not a JSON object at all is refused for writes (never replaced by a fresh one).
import { z } from 'zod'
import { TeamType, WELCOME_RESULT_SKILL, WELCOME_STEPS, WelcomeProgress, WelcomeStepState, normalizeWebsite, type WelcomePackResult, type WelcomeUpdate } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { setSetting } from '../admin/settings'
import { fail } from '../http/errors'
import { listTeamSkills, sameSkillName } from '../chat/skills'
import { installSkillPack } from './skill-packs'

export const WELCOME_SETTING = 'onboarding.welcome'

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const PackShape = WelcomeProgress.shape.pack.unwrap()

/** The stored row: none, an object, or something that is not an object (`raw` null with `row` true). */
function stored(ctx: Pick<AppContext, 'db'>): { row: boolean; raw: Raw | null } {
  const r = ctx.db.query('SELECT value FROM settings WHERE key = ?').get(WELCOME_SETTING) as { value: string } | null
  if (!r) return { row: false, raw: null }
  try {
    const v = JSON.parse(r.value) as unknown
    return { row: true, raw: isObj(v) ? v : null }
  } catch {
    return { row: true, raw: null }
  }
}

const pick = <T>(schema: z.ZodType<T>, v: unknown, d: T): T => {
  const r = schema.safeParse(v)
  return r.success ? r.data : d
}
const str = z.string()
const opt = z.string().nullable()

/** The progress as the API shows it: each field read on its own, defaults where one does not read. */
function view(raw: Raw, now: string): WelcomeProgress {
  const steps = isObj(raw.steps) ? raw.steps : {}
  const rawPack = raw.pack
  return {
    startedAt: pick(str, raw.startedAt, now),
    updatedAt: pick(str, raw.updatedAt, now),
    teamType: pick(TeamType.nullable(), raw.teamType, null),
    steps: Object.fromEntries(WELCOME_STEPS.map((s) => [s, pick(WelcomeStepState.nullable(), steps[s], null)])) as WelcomeProgress['steps'],
    // recorded in any shape: installed (the steps never install again because of a field they cannot read)
    pack: rawPack === null || rawPack === undefined ? null : pick(PackShape, rawPack, {
      id: 'marketing',
      at: isObj(rawPack) ? pick(str, rawPack.at, '') : '',
      skillPath: isObj(rawPack) ? pick(str, rawPack.skillPath, WELCOME_RESULT_SKILL) : WELCOME_RESULT_SKILL,
    }),
    resultChatId: pick(opt, raw.resultChatId, null),
    inviteShownAt: pick(opt, raw.inviteShownAt, null),
    site: pick(opt, raw.site, null),
    dismissedAt: pick(opt, raw.dismissedAt, null),
    finishedAt: pick(opt, raw.finishedAt, null),
  }
}

const fresh = (now: string): Raw => ({
  startedAt: now, updatedAt: now, teamType: null,
  steps: { profile: null, result: null, invite: null },
  pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
})

/** The stored object to change: the row as it is, or a fresh one when there is none. A row that is not an object is
 * refused: it is never replaced by a fresh one (that would forget the pack). */
function forWrite(ctx: Pick<AppContext, 'db'>, now: string): Raw {
  const s = stored(ctx)
  if (s.row && !s.raw) fail('conflict')
  return s.raw ? { ...s.raw, steps: isObj(s.raw.steps) ? { ...s.raw.steps } : {} } : fresh(now)
}

/** The stored progress, or null when the steps were never opened (or the row is not an object). */
export function readWelcome(ctx: Pick<AppContext, 'db'>): WelcomeProgress | null {
  const s = stored(ctx)
  return s.raw ? view(s.raw, new Date().toISOString()) : null
}

/** profile and result done, and the invite either way */
export const welcomeFinished = (p: WelcomeProgress) => p.steps.profile === 'done' && p.steps.result === 'done' && p.steps.invite !== null

function save(ctx: Pick<AppContext, 'db'>, raw: Raw, now: string): WelcomeProgress {
  if (!view(raw, now).finishedAt && welcomeFinished(view(raw, now))) raw.finishedAt = now
  raw.updatedAt = now
  setSetting(ctx.db, WELCOME_SETTING, raw)
  return view(raw, now)
}

/** Apply one change of the owner's (an empty change only starts the progress). */
export function updateWelcome(ctx: Pick<AppContext, 'db'>, userId: string, u: WelcomeUpdate): WelcomeProgress {
  const now = new Date().toISOString()
  const raw = forWrite(ctx, now)
  const p = view(raw, now)
  const steps = raw.steps as Raw
  if (u.resultChatId !== undefined) {
    // the bar shows on this chat: one of the caller's own, not deleted
    const own = ctx.db.query('SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(u.resultChatId, userId)
    if (!own) fail('not_found')
    raw.resultChatId = u.resultChatId
  }
  if (u.teamType) raw.teamType = u.teamType
  if (u.step) {
    // done stays done: going back to a step and putting it off again does not undo it
    if (u.step.state === 'done' || p.steps[u.step.id] !== 'done') steps[u.step.id] = u.step.state
    // the invite put off before there was a result comes back once there is one (the bar on the result chat)
    if (u.step.id === 'result' && u.step.state === 'done' && p.steps.invite === 'skipped') steps.invite = null
  }
  if (u.inviteShown && !p.inviteShownAt) raw.inviteShownAt = now
  if (u.site !== undefined) {
    const site = normalizeWebsite(u.site)
    if (site) raw.site = site
  }
  if (u.dismissed !== undefined) raw.dismissedAt = u.dismissed ? (p.dismissedAt ?? now) : null
  return save(ctx, raw, now)
}

/** The ad copy skill "/ad-copy" runs for the team: the pack's own file, else another team skill of that name. */
function adCopyPath(ctx: AppContext, userId: string, skills = listTeamSkills(ctx.files, ctx.files.principal(userId))): string | null {
  return skills.find((s) => s.path === WELCOME_RESULT_SKILL)?.path ?? skills.find((s) => sameSkillName(s.name, 'ad-copy'))?.path ?? null
}

/**
 * Install the marketing pack for these steps, once:
 * - recorded before (by these steps): nothing runs (`already`);
 * - the team already has skills under skills/marketing/ (the Skills page installed the pack): recorded without
 *   installing, so a skill deleted there on purpose is not brought back (`already`);
 * - else it installs; it is recorded only when the first-result skill is there afterwards (written now, already there,
 *   or another team skill of its name); when the folder rules blocked it nothing is recorded (`blocked`).
 */
export function installWelcomePack(ctx: AppContext, userId: string): WelcomePackResult {
  const now = new Date().toISOString()
  const raw = forWrite(ctx, now)
  if (view(raw, now).pack) return { progress: view(raw, now), install: null, outcome: 'already' }
  const skills = listTeamSkills(ctx.files, ctx.files.principal(userId))
  if (skills.some((s) => s.path.startsWith('skills/marketing/'))) {
    raw.pack = { id: 'marketing', at: now, skillPath: adCopyPath(ctx, userId, skills) ?? WELCOME_RESULT_SKILL }
    return { progress: save(ctx, raw, now), install: null, outcome: 'already' }
  }
  const install = installSkillPack(ctx, userId, 'marketing')
  const adCopy = install.skills.find((s) => s.path === WELCOME_RESULT_SKILL)
  // when another team skill already has its name, "/ad-copy" runs that one: point there
  const skillPath = adCopy?.status === 'blocked' ? (adCopy.sameNameAs ?? null) : adCopy ? WELCOME_RESULT_SKILL : null
  if (!skillPath) return { progress: save(ctx, raw, now), install, outcome: 'blocked' }
  raw.pack = { id: 'marketing', at: now, skillPath }
  return { progress: save(ctx, raw, now), install, outcome: 'installed' }
}
