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
//
// Every team's start (docs/DECISIONS.md "M — One meeting note, everyone's own tasks", setupWelcomeTeam): the general
// pack (할 일 정리, 핵심 정리) installed once like the marketing pack, and the team's own group named after the team, with
// its folder groups/<name>/ (the group's members read and write it, as every group folder) and the meeting notes folder
// in it, made once with the owner in it. Both are recorded in the row, so the steps never make them again by themselves.
import { z } from 'zod'
import {
  BRAND_IMAGES_FOLDER, GENERAL_BRIEF_SKILL, GENERAL_CARDNEWS_SKILL, GENERAL_TASKS_SKILL, NOTES_FOLDER, PACK_FOLDERS, TeamGroupRef, TeamType, WELCOME_RESULT_SKILL, WELCOME_STEPS, WelcomeProgress, WelcomeStepState, normalizeWebsite,
  type Locale, type WelcomePackResult, type WelcomeTeamResult, type WelcomeUpdate,
} from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getTeamSettings, setSetting, teamDefaultLocale } from '../admin/settings'
import { createGroupAs, groupFolder, groupIdByName } from '../admin/groups'
import { fail } from '../http/errors'
import { authorize } from '../policy/authorize'
import { listTeamSkills, sameSkillName } from '../chat/skills'
import { componentC } from '../team-files/component'
import { installSkillPack } from './skill-packs'

export const WELCOME_SETTING = 'onboarding.welcome'

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const PackShape = WelcomeProgress.shape.pack.unwrap()
const GeneralShape = z.object({ at: z.string(), tasksPath: z.string().nullable(), briefPath: z.string().nullable(), cardNewsPath: z.string().nullable().optional() })

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
    // the three-step version's team step, put off and never answered since: the pack is not installed by itself
    ...(steps.team === 'skipped' && pick(TeamType.nullable(), raw.teamType, null) === null ? { teamSkipped: true } : {}),
    // recorded in any shape: installed (as for the marketing pack), the paths falling back to the pack's own; absent
    // until then, so rows from before read exactly as they did
    ...(raw.general === null || raw.general === undefined ? {} : { general: pick(GeneralShape, raw.general, { at: '', tasksPath: GENERAL_TASKS_SKILL, briefPath: GENERAL_BRIEF_SKILL }) }),
    ...(() => { const g = pick(TeamGroupRef.nullable(), raw.teamGroup ?? null, null); return g ? { teamGroup: g } : {} })(),
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
  if (u.finish) {
    // "자료 없이 해 볼게요" without the marketing pack: what is still open is put off, and the steps are over
    for (const s of WELCOME_STEPS) if (p.steps[s] === null) steps[s] = 'skipped'
    if (!p.finishedAt) raw.finishedAt = now
  }
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

/** The skill "/<name>" runs for the team: the pack's own file, else another team skill of that name. */
function generalPath(skills: { path: string; name: string }[], own: string, name: string): string | null {
  return skills.find((s) => s.path === own)?.path ?? skills.find((s) => sameSkillName(s.name, name))?.path ?? null
}

/** Where an install left one of its skills: the pack's file, another team skill of its name, or nowhere (blocked). */
function placed(install: WelcomePackResult['install'], own: string): string | null {
  const s = install?.skills.find((x) => x.path === own)
  if (!s) return null
  return s.status === 'blocked' ? (s.sameNameAs ?? null) : own
}

/** The meeting notes folder inside the team folder: made through the file screen's own "new folder" when missing. */
function ensureNotesFolder(ctx: AppContext, userId: string, rel: string): void {
  const r = authorize(ctx.files.fx, ctx.files.rules(), ctx.files.principal(userId), rel, 'write', { mustExist: false })
  if (!r.exists) componentC(ctx).files.mkdir(userId, rel)
}

/** The brand folder inside the team folder (groups/<team>/브랜드, localized) and its images folder, made when missing:
 * the company intro, 회사 소개.md and the pictures of the first result go there (docs/DECISIONS.md "N"). */
export function brandFoldersOf(ctx: AppContext, userId: string, folder: string, recorded?: string): { brandFolder: string; imagesFolder: string } {
  const locale = teamDefaultLocale(ctx.db)
  // the one recorded keeps its name when the team's language changes later (the page uploads into it)
  const brandFolder = recorded && recorded.startsWith(`${folder}/`) ? recorded : `${folder}/${PACK_FOLDERS.brand[locale]}`
  const imagesFolder = `${brandFolder}/${BRAND_IMAGES_FOLDER[locale]}`
  ensureNotesFolder(ctx, userId, brandFolder)
  ensureNotesFolder(ctx, userId, imagesFolder)
  return { brandFolder, imagesFolder }
}

/** The team's own group: the one these steps recorded while it is there, else a new one named after the team with the
 * owner in it. A group these steps did not make is never taken over, even with the team's name (an admin's group may
 * carry rules on other folders that the team link would hand to everyone who joins): a name already taken gets a
 * number ("Acme 2"). */
function teamGroupFor(ctx: AppContext, userId: string, recorded: TeamGroupRef | null, locale: Locale): TeamGroupRef {
  const notes = NOTES_FOLDER[teamDefaultLocale(ctx.db)]
  if (recorded) {
    const folder = groupFolder(ctx, recorded.id)
    const name = (ctx.db.query('SELECT name FROM groups WHERE id = ?').get(recorded.id) as { name: string } | null)?.name
    if (folder && name) {
      const notesFolder = recorded.folder === folder ? recorded.notesFolder : `${folder}/${notes}`
      ensureNotesFolder(ctx, userId, notesFolder)
      return { id: recorded.id, name, folder, notesFolder, brandFolder: brandFoldersOf(ctx, userId, folder, recorded.folder === folder ? recorded.brandFolder : undefined).brandFolder }
    }
  }
  const team = getTeamSettings(ctx.db).teamName.trim().slice(0, 100) || 'Team'
  const name = !groupIdByName(ctx, team) ? team
    : [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${team.slice(0, 96)} ${n}`).find((n) => !groupIdByName(ctx, n)) ?? `${team.slice(0, 80)} ${Date.now()}`
  const g = createGroupAs(ctx, userId, { name, memberIds: [userId] }, locale)
  const folder = groupFolder(ctx, g.id)
  if (!folder) return fail('internal')
  const notesFolder = `${folder}/${notes}`
  ensureNotesFolder(ctx, userId, notesFolder)
  return { id: g.id, name: g.name, folder, notesFolder, brandFolder: brandFoldersOf(ctx, userId, folder).brandFolder }
}

/**
 * Every team's start, once (owner; the welcome steps call it when the first step is left, and the result step when an
 * older row has none):
 * - the general pack: recorded before → nothing runs; the team already has skills under skills/general/ → recorded
 *   without installing (nothing deleted on purpose comes back); else installed, and recorded when "할 일 정리" is there
 *   afterwards (written now, already there, or another team skill of its name), `blocked` (nothing recorded) otherwise;
 * - the team group: the recorded one while it exists, else a new one named after the team ("Acme 2" when the name is
 *   taken: a group these steps did not make is never taken over) with the owner in it; its folder and the meeting notes
 *   folder in it (made when missing, through the file layer).
 * The pack's record is saved before the group is made, so a failure there never installs the pack twice.
 */
export function setupWelcomeTeam(ctx: AppContext, userId: string, locale: Locale): WelcomeTeamResult {
  const now = new Date().toISOString()
  const raw = forWrite(ctx, now)
  let p = view(raw, now)
  let install: WelcomeTeamResult['install'] = null
  let outcome: WelcomeTeamResult['outcome'] = 'already'
  if (!p.general) {
    const skills = listTeamSkills(ctx.files, ctx.files.principal(userId))
    const tasks = generalPath(skills, GENERAL_TASKS_SKILL, 'meeting-tasks')
    // an install of these steps that was blocked before may run again (it only adds what is missing); a team that has
    // the pack's skills from the Skills page is recorded as it is, and without "할 일 정리" it stays blocked (a skill
    // deleted there on purpose is not brought back)
    const tried = typeof raw.generalBlockedAt === 'string'
    if (!tried && skills.some((s) => s.path.startsWith('skills/general/'))) {
      if (tasks) raw.general = { at: now, tasksPath: tasks, briefPath: generalPath(skills, GENERAL_BRIEF_SKILL, 'doc-brief'), ...(generalPath(skills, GENERAL_CARDNEWS_SKILL, 'card-news') ? { cardNewsPath: generalPath(skills, GENERAL_CARDNEWS_SKILL, 'card-news') } : {}) }
      else outcome = 'blocked'
    } else {
      install = installSkillPack(ctx, userId, 'general')
      const tasksPath = placed(install, GENERAL_TASKS_SKILL)
      if (tasksPath) {
        raw.general = { at: now, tasksPath, briefPath: placed(install, GENERAL_BRIEF_SKILL), cardNewsPath: placed(install, GENERAL_CARDNEWS_SKILL) }
        delete raw.generalBlockedAt
        outcome = 'installed'
      } else {
        raw.generalBlockedAt = now
        outcome = 'blocked'
      }
    }
    p = save(ctx, raw, now)
  }
  raw.teamGroup = teamGroupFor(ctx, userId, p.teamGroup ?? null, locale)
  return { progress: save(ctx, raw, now), install, outcome }
}

/** "/card-news" for the first result (docs/DECISIONS.md "N"): the recorded path, or once, for a row whose general pack
 * was recorded before the skill existed, the skill installed on its own and recorded (null when blocked). `install`
 * runs only then. */
export function cardNewsSkill(ctx: AppContext, userId: string, install: () => { path: string; status: string; sameNameAs?: string }): string | null {
  const now = new Date().toISOString()
  const raw = forWrite(ctx, now)
  const general = isObj(raw.general) ? raw.general : null
  if (!general) return null
  if (typeof general.cardNewsPath === 'string') return general.cardNewsPath
  if (general.cardNewsPath === null) return null
  const r = install()
  const path = r.status === 'blocked' ? (r.sameNameAs ?? null) : r.path
  raw.general = { ...general, cardNewsPath: path }
  save(ctx, raw, now)
  return path
}
