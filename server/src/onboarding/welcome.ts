// The welcome steps' progress (docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding"; contract
// shared/src/api/onboarding-welcome.ts):
// one settings row of the team, so the steps resume on another device. The owner writes it, owners and admins read
// it. Everything below is synchronous, so a check and its write never interleave with another request's. A `team` step
// of a row written before the team type stopped being a step is kept, not read; so is a `pack` (the marketing pack an
// earlier version's steps installed, docs/DECISIONS.md "DS3").
//
// The row is read field by field: a field that does not read (a later release changed it, a hand edit) falls back to
// its default for display, and a write changes only the fields it sets, keeping everything else of the stored object
// as it was (unknown fields too). A recorded general pack counts as installed whatever its shape, so nothing resets
// it. A row that is not a JSON object at all is refused for writes (never replaced by a fresh one).
//
// Every team's start (docs/DECISIONS.md "M — One meeting note, everyone's own tasks", setupWelcomeTeam): the general
// pack (the intro deck, the card news, the promo video) installed at most once, since installing again would restore
// skills someone deleted on purpose (stream C), and the team's own group named after the team, with its folder
// groups/<name>/ (the group's members read and write it, as every group folder) and the meeting notes folder in it,
// made once with the owner in it. Both are recorded in the row, so the steps never make them again by themselves.
import { z } from 'zod'
import {
  BRAND_FOLDER, BRAND_IMAGES_FOLDER, GENERAL_CARDNEWS_SKILL, GENERAL_DECK_SKILL, GENERAL_PROMO_SKILL, NOTES_FOLDER, TeamGroupRef, TeamType, WELCOME_STEPS, WelcomeProgress, WelcomeStepState, normalizeWebsite,
  type Locale, type WelcomeTeamResult, type WelcomeUpdate,
} from '@mycel/shared/api'
import type { AppContext } from '../context'
import { getTeamSettings, setSetting, teamDefaultLocale } from '../admin/settings'
import { createGroupAs, groupFolder, groupIdByName } from '../admin/groups'
import { fail } from '../http/errors'
import { authorize } from '../policy/authorize'
import { listTeamSkills, sameSkillName } from '../chat/skills'
import { componentC } from '../team-files/component'
import { installSkillPack } from './skill-packs'
import { retireLegacyDefaultSkills } from './retired-skills'

export const WELCOME_SETTING = 'onboarding.welcome'

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const SharedShape = WelcomeProgress.shape.shared.unwrap().unwrap()
const GeneralShape = z.object({ at: z.string(), cardNewsPath: z.string().nullable().optional(), promoVideoPath: z.string().nullable().optional(), introDeckPath: z.string().nullable().optional() })

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
  return {
    startedAt: pick(str, raw.startedAt, now),
    updatedAt: pick(str, raw.updatedAt, now),
    teamType: pick(TeamType.nullable(), raw.teamType, null),
    // the AI step only when it was ever recorded (a row from before it, or an owner whose AI answered from the start,
    // reads as it did)
    steps: Object.fromEntries(WELCOME_STEPS.map((s) => [s, pick(WelcomeStepState.nullable(), steps[s], null)]).filter(([s, v]) => s !== 'ai' || v !== null)) as WelcomeProgress['steps'],
    resultChatId: pick(opt, raw.resultChatId, null),
    inviteShownAt: pick(opt, raw.inviteShownAt, null),
    site: pick(opt, raw.site, null),
    dismissedAt: pick(opt, raw.dismissedAt, null),
    finishedAt: pick(opt, raw.finishedAt, null),
    ...(typeof raw.doneShownAt === 'string' ? { doneShownAt: raw.doneShownAt } : {}),
    // the three-step version's team step, put off and never answered since
    ...(steps.team === 'skipped' && pick(TeamType.nullable(), raw.teamType, null) === null ? { teamSkipped: true } : {}),
    // recorded in any shape: installed (the steps never install again because of a field they cannot read); absent
    // until then, so rows from before read exactly as they did
    ...(raw.general === null || raw.general === undefined ? {} : { general: pick(GeneralShape, raw.general, { at: '' }) }),
    ...(() => { const g = pick(TeamGroupRef.nullable(), raw.teamGroup ?? null, null); return g ? { teamGroup: g } : {} })(),
    ...(raw.skillsLater === true ? { skillsLater: true } : {}),
    ...(() => { const sh = pick(SharedShape.nullable(), raw.shared ?? null, null); return sh ? { shared: sh } : {} })(),
  }
}

// `result` stays null: the first result is no longer a step (docs/DECISIONS.md "W5"), but the stored row is still a
// WelcomeProgress, and an older build that reads it after a rollback reads it as before (`pack` too: null, nothing
// installed by the steps)
const fresh = (now: string): Raw => ({
  startedAt: now, updatedAt: now, teamType: null,
  steps: { profile: null, result: null, skills: null, files: null, invite: null },
  pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
})

/** The stored object to change: the row as it is (the deck's chat settled, settleDeck), or a fresh one when there is
 * none. A row that is not an object is refused: it is never replaced by a fresh one (that would forget the general
 * pack and the team group). */
function forWrite(ctx: Pick<AppContext, 'db'>, now: string): Raw {
  const s = stored(ctx)
  if (s.row && !s.raw) fail('conflict')
  if (!s.raw) return fresh(now)
  const raw = { ...s.raw, steps: isObj(s.raw.steps) ? { ...s.raw.steps } : {} }
  settleDeck(ctx, raw)
  return raw
}

/** The stored progress (the deck's chat settled, settleDeck), or null when the steps were never opened (or the row is
 * not an object). */
export function readWelcome(ctx: Pick<AppContext, 'db'>): WelcomeProgress | null {
  const s = stored(ctx)
  if (!s.raw) return null
  const raw = { ...s.raw, steps: isObj(s.raw.steps) ? { ...s.raw.steps } : {} }
  settleDeck(ctx, raw)
  return view(raw, new Date().toISOString())
}

// ---------------------------------------------------------------- the intro deck's chat (docs/DECISIONS.md "W5")
// The chat POST …/first-result makes is kept in the row's own field `deckChatId` (never shown), and becomes
// `resultChatId` only once it holds a message: 회사 소개 counts as saved with a deck only when the deck's message really
// went in. A tab closed or a send that failed after "저장하고 계속" leaves 회사 소개 open, and its next "저장하고 계속"
// gets the same chat again (review of PR #100: the chat used to be recorded as the deck before the page sent).
const DECK_CHAT = 'deckChatId'
const chatThere = (ctx: Pick<AppContext, 'db'>, id: string, userId?: string) =>
  !!(userId ? ctx.db.query('SELECT 1 FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId) : ctx.db.query('SELECT 1 FROM chats WHERE id = ? AND deleted_at IS NULL').get(id))
const holdsMessage = (ctx: Pick<AppContext, 'db'>, id: string) => !!ctx.db.query('SELECT 1 FROM chats c WHERE c.id = ? AND c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)').get(id)

/** The deck's chat as it is now, on a copy of the row: the kept chat that holds its message becomes `resultChatId`; a
 * `resultChatId` recorded before this rule for a deck whose message never went (its chat there and empty, no first
 * result answered: old row (a) after a closed tab) goes back to being the kept chat. Never throws (a database without
 * chats reads the row as stored). */
function settleDeck(ctx: Pick<AppContext, 'db'>, raw: Raw): void {
  try {
    const steps = isObj(raw.steps) ? raw.steps : {}
    if (typeof raw.resultChatId === 'string' && (steps.result ?? null) === null && chatThere(ctx, raw.resultChatId) && !holdsMessage(ctx, raw.resultChatId)) {
      if (typeof raw[DECK_CHAT] !== 'string') raw[DECK_CHAT] = raw.resultChatId
      raw.resultChatId = null
    }
    const kept = raw[DECK_CHAT]
    if ((raw.resultChatId ?? null) === null && typeof kept === 'string' && holdsMessage(ctx, kept)) raw.resultChatId = kept
  } catch { /* as stored */ }
}

/** The name the intro deck runs by ("/intro-deck"): the folder of its SKILL.md. */
const deckName = (p: WelcomeProgress) => (p.general?.introDeckPath ?? GENERAL_DECK_SKILL).split('/').slice(-2, -1)[0] || 'intro-deck'

/** An intro deck really started (docs/DECISIONS.md "W5", the end screen's line): the deck's chat (`resultChatId`, or
 * the kept one) is there and holds the "/intro-deck" message, or a deck build was made in it. A first result of a row
 * from before (a card news, an ad copy) is no deck. */
export function deckStarted(ctx: Pick<AppContext, 'db'>): boolean {
  const s = stored(ctx)
  if (!s.raw) return false
  const p = readWelcome(ctx)!
  const cmd = `/${deckName(p)}`
  for (const id of new Set([p.resultChatId, s.raw[DECK_CHAT]].filter((x): x is string => typeof x === 'string'))) {
    if (!chatThere(ctx, id)) continue
    try {
      if (ctx.db.query('SELECT 1 FROM intro_deck_builds WHERE chat_id = ? LIMIT 1').get(id)) return true
    } catch { /* a database without deck builds */ }
    const said = ctx.db.query("SELECT substr(content, 1, 100) AS c FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at LIMIT 20").all(id) as { c: string }[]
    if (said.some((m) => m.c === cmd || m.c.startsWith(`${cmd} `) || m.c.startsWith(`${cmd}\n`))) return true
  }
  return false
}

/** The progress as the screens get it: the row and the facts read for them (`deckStarted`, `landingSkill`). */
export function welcomeOut(ctx: AppContext, p: WelcomeProgress | null): WelcomeProgress | null {
  if (!p) return p
  let landing: string | null = null
  try { landing = landingSkill(ctx) } catch { /* none */ }
  return { ...p, deckStarted: deckStarted(ctx), landingSkill: landing }
}

/**
 * 회사 소개 answered (docs/DECISIONS.md "W5"): put off, or saved with the intro deck started (`resultChatId`) or, on a
 * row from before, its first result answered either way. A row from before whose profile was saved but whose first
 * result never ran (old row (a)) is still open: 회사 소개's "저장하고 계속" starts the deck there.
 */
export const profileAnswered = (p: WelcomeProgress) => p.steps.profile === 'skipped' || (p.steps.profile === 'done' && (p.resultChatId !== null || p.steps.result !== null))
const answered = (v: WelcomeStepState | null | undefined) => v === 'done' || v === 'skipped'
/** 회사 소개 answered, and 내 스킬, 팀 파일 and the invite each done or put off; not while 내 스킬 waits for a computer
 * (skillsLater). The deck is a fact, not a step. */
export const welcomeFinished = (p: WelcomeProgress) => profileAnswered(p) && answered(p.steps.skills) && answered(p.steps.files) && answered(p.steps.invite) && !p.skillsLater

/** What runs when a save ends the steps, or the owner's ✕ on them held (the merges that waited for them:
 * skills/share-merge.ts). Registered by the module that owns it, so this file needs no import of the chat runtime; a
 * hook that throws is logged, never fatal. */
type EndedHook = (ctx: AppContext, ownerId: string) => void
// kept on a hoisted function, not a module constant: share-merge.ts registers while the import cycle through the
// skill packs has not run this module's body yet
function endedHooks(): EndedHook[] { return ((endedHooks as unknown as { list?: EndedHook[] }).list ??= []) }
export function onWelcomeEnded(fn: EndedHook): void { if (!endedHooks().includes(fn)) endedHooks().push(fn) }
function finishedNow(ctx: Pick<AppContext, 'db' | 'log'> & Partial<AppContext>, ownerId: string): void {
  for (const fn of endedHooks()) {
    try { fn(ctx as AppContext, ownerId) } catch (err) { ctx.log?.warn('after the welcome steps ended: a hook failed', { err }) }
  }
}

/** Write the row; `finished` is true when this save just ended the steps (finishedAt set now). */
function saveRow(ctx: Pick<AppContext, 'db'>, raw: Raw, now: string): { progress: WelcomeProgress; finished: boolean } {
  let finished = false
  if (!view(raw, now).finishedAt && welcomeFinished(view(raw, now))) { raw.finishedAt = now; finished = true }
  raw.updatedAt = now
  setSetting(ctx.db, WELCOME_SETTING, raw)
  return { progress: view(raw, now), finished }
}
const save = (ctx: Pick<AppContext, 'db'>, raw: Raw, now: string): WelcomeProgress => saveRow(ctx, raw, now).progress

/** Apply one change of the owner's (an empty change only starts the progress). */
export function updateWelcome(ctx: Pick<AppContext, 'db' | 'log'> & Partial<AppContext>, userId: string, u: WelcomeUpdate): WelcomeProgress {
  const now = new Date().toISOString()
  const raw = forWrite(ctx, now)
  const p = view(raw, now)
  const steps = raw.steps as Raw
  if (u.resultChatId !== undefined) {
    // the deck's chat: one of the caller's own, not deleted; recorded once it holds a message (a page that sends it
    // later: settleDeck records the kept chat when its message is in)
    if (!chatThere(ctx, u.resultChatId, userId)) fail('not_found')
    if (holdsMessage(ctx, u.resultChatId)) raw.resultChatId = u.resultChatId
  }
  if (u.teamType) raw.teamType = u.teamType
  if (u.step) {
    // done stays done: going back to a step and putting it off again does not undo it. The AI step: `skipped` when it
    // was shown (AI was needed), `done` once AI answers the owner after that (docs/DECISIONS.md "W2")
    if (u.step.state === 'done' || p.steps[u.step.id] !== 'done') steps[u.step.id] = u.step.state
    // 회사 소개 put off on a row whose profile was saved before without a deck (old row (a), docs/DECISIONS.md "W5"): the
    // profile stays saved and the deck is put off (`result: skipped`, old row (d)), so the step is answered and the
    // steps do not come back to it
    if (u.step.id === 'profile' && u.step.state === 'skipped' && p.steps.profile === 'done' && !p.resultChatId && (p.steps.result ?? null) === null) steps.result = 'skipped'
    // 내 스킬 가져오기 done or put off on a computer: no longer waiting for one
    if (u.step.id === 'skills') delete raw.skillsLater
  }
  if (u.skillsLater && !u.step) {
    // put off on a phone: skipped there, open again on a computer (never undoes a share that was done)
    if (p.steps.skills !== 'done') { steps.skills = 'skipped'; raw.skillsLater = true }
  }
  if (u.landing !== undefined) {
    // the invite opens one of the shared skills (바꾸기): nothing else
    if (!p.shared?.skills.some((x) => x.path === u.landing)) fail('validation', undefined, { fields: { 'body.landing': 'not a shared skill' } })
    raw.shared = { ...p.shared!, landing: u.landing }
  }
  if (u.inviteShown && !p.inviteShownAt) raw.inviteShownAt = now
  if (u.site !== undefined) {
    const site = normalizeWebsite(u.site)
    if (site) raw.site = site
  }
  if (u.dismissed !== undefined) raw.dismissedAt = u.dismissed ? (p.dismissedAt ?? now) : null
  // the end screen shows once
  if (u.doneShown && !p.doneShownAt) raw.doneShownAt = now
  if (u.finish) {
    // "자료 없이 해 볼게요": what is still open is put off, and the steps are over
    for (const s of WELCOME_STEPS) if (s !== 'ai' && p.steps[s] === null) steps[s] = 'skipped'
    delete raw.skillsLater
    if (!p.finishedAt) raw.finishedAt = now
  }
  const r = saveRow(ctx, raw, now)
  // the legacy "finish" sets finishedAt itself: it ends the steps too
  if (r.finished || (u.finish && !p.finishedAt)) finishedNow(ctx, userId)
  // hiding the steps (✕) lets what waited for them go, but only once it holds: the setup row's toast can undo it
  if (u.dismissed && !p.dismissedAt) afterDismissHold(ctx, userId)
  return r.progress
}

/**
 * How long a hidden setup row (✕) must stay hidden before it counts as the end of the steps for what waited for them
 * (docs/DECISIONS.md "W5": the merges into team skills). The row's undo toast lasts seconds; ✕ then undo inside this
 * starts nothing in the middle of the steps.
 */
export const DISMISS_HOLD_MS = 60_000
/** The steps were hidden (✕) at least DISMISS_HOLD_MS ago and not brought back. */
const dismissHeld = (p: WelcomeProgress, now = Date.now()) => !!p.dismissedAt && now - Date.parse(p.dismissedAt) >= DISMISS_HOLD_MS

/** After a ✕, once DISMISS_HOLD_MS passed: the steps' end hooks run if they are still hidden then (endHeldDismissal).
 * A server stopped meanwhile leaves it to the share sweep (skills/share-merge.ts startStaleMerges), which starts what
 * no longer waits. */
function afterDismissHold(ctx: Pick<AppContext, 'db' | 'log'> & Partial<AppContext>, ownerId: string): void {
  const t = setTimeout(() => endHeldDismissal(ctx, ownerId), DISMISS_HOLD_MS + 1000)
  ;(t as { unref?: () => void }).unref?.()
}

/** The steps hidden for good (✕ held, not finished): what waited for their end goes now. Idempotent (the hooks are). */
export function endHeldDismissal(ctx: Pick<AppContext, 'db' | 'log'> & Partial<AppContext>, ownerId: string, now = Date.now()): boolean {
  let p: WelcomeProgress | null
  try { p = readWelcome(ctx) } catch { return false }
  if (!p || p.finishedAt || !dismissHeld(p, now)) return false
  finishedNow(ctx, ownerId)
  return true
}

/** The owner's welcome steps are under way (the row exists, not finished, not hidden for good) and `userId` is the
 * owner: merges into team skills wait for their end (skills/share-merge.ts). Steps hidden for at least DISMISS_HOLD_MS
 * hold nothing back: no setup row leads to them, so a merge waiting for them would wait for good. A ✕ still inside its
 * undo time holds them as before. */
export function welcomeUnfinishedFor(ctx: Pick<AppContext, 'db'>, userId: string): boolean {
  try {
    const owner = ctx.db.query("SELECT 1 FROM users WHERE id = ? AND role = 'owner' AND deleted_at IS NULL").get(userId)
    if (!owner) return false
    const p = readWelcome(ctx)
    return !!p && !p.finishedAt && !dismissHeld(p)
  } catch { return false }
}

/** Does this team skill exist for the person (the file layer, their folder rules)? */
function skillThere(ctx: AppContext, userId: string | null, rel: string): boolean {
  try {
    const who = userId ? ctx.files.principal(userId) : null
    if (!who) return false
    return authorize(ctx.files.fx, ctx.files.rules(), who, rel, 'read', { mustExist: true }).st?.isFile() ?? false
  } catch { return false }
}

/**
 * The skill everything points at (docs/DECISIONS.md "W5"): the invite link, the goal card, the end screen. The shared
 * skill the invite opens (`shared.landing`) while it is there, else null: the invite link then lands on Home and the
 * end screen offers 홈으로 only (docs/DECISIONS.md "DS3": no pack skill stands in, a row's old 할 일 정리 included).
 * Never the intro deck: it is the owner's own first run, not the team's skill. `as`: whose view of the files decides
 * "there" (default: the first owner).
 */
export function landingSkill(ctx: AppContext, as?: string): string | null {
  const p = readWelcome(ctx)
  const path = p?.shared?.landing
  if (!p || !path) return null
  const who = as ?? ((ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string } | null)?.id ?? null)
  const deck = new Set([GENERAL_DECK_SKILL, p.general?.introDeckPath].filter((x): x is string => !!x))
  return !deck.has(path) && skillThere(ctx, who, path) ? path : null
}

/** The skill "/<name>" runs for the team: the pack's own file, else another team skill of that name. */
function generalPath(skills: { path: string; name: string }[], own: string, name: string): string | null {
  return skills.find((s) => s.path === own)?.path ?? skills.find((s) => sameSkillName(s.name, name))?.path ?? null
}

/** Written into every new `general` record although nothing reads them: an older build (after a rollback) requires both
 * to read the record, and would otherwise fall back to its defaults and lose the intro deck's path (docs/DECISIONS.md
 * "DS3"; the skills they named no longer ship). */
const OLD_GENERAL_FIELDS = { tasksPath: null, briefPath: null } as const

/** Where an install left one of its skills: the pack's file, another team skill of its name, or nowhere (blocked). */
function placed(install: WelcomeTeamResult['install'], own: string): string | null {
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
  const brandFolder = recorded && recorded.startsWith(`${folder}/`) ? recorded : `${folder}/${BRAND_FOLDER[locale]}`
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
 *   without installing (nothing deleted on purpose comes back); else installed, and recorded when any of its skills is
 *   there afterwards (written now, already there, or another team skill of its name), `blocked` (nothing recorded) when
 *   the folder rules kept every one out. No one skill of it decides (docs/DECISIONS.md "DS3": 할 일 정리, which used to,
 *   is gone), so a skill missing never holds the start back;
 * - the team group: the recorded one while it exists, else a new one named after the team ("Acme 2" when the name is
 *   taken: a group these steps did not make is never taken over) with the owner in it; its folder and the meeting notes
 *   folder in it (made when missing, through the file layer).
 * The pack's record is saved before the group is made, so a failure there never installs the pack twice. Nothing else
 * is installed here: no other pack is added by itself. The old seeder's settings row gets its keys recorded as retired
 * (a settings write, no files: onboarding/retired-skills.ts).
 */
export function setupWelcomeTeam(ctx: AppContext, userId: string, locale: Locale): WelcomeTeamResult {
  const now = new Date().toISOString()
  const raw = forWrite(ctx, now)
  let p = view(raw, now)
  let install: WelcomeTeamResult['install'] = null
  let outcome: WelcomeTeamResult['outcome'] = 'already'
  if (!p.general) {
    const skills = listTeamSkills(ctx.files, ctx.files.principal(userId))
    // an install of these steps that was blocked before may run again (it only adds what is missing); a team that has
    // the pack's skills from the Skills page is recorded as it is (a skill deleted there on purpose is not brought back)
    const tried = typeof raw.generalBlockedAt === 'string'
    if (!tried && skills.some((s) => s.path.startsWith('skills/general/'))) {
      // the intro deck not there yet stays unrecorded: the first result adds it on its own once (introDeckSkill)
      const cardNewsPath = generalPath(skills, GENERAL_CARDNEWS_SKILL, 'card-news')
      const promoVideoPath = generalPath(skills, GENERAL_PROMO_SKILL, 'promo-video')
      const introDeckPath = generalPath(skills, GENERAL_DECK_SKILL, 'intro-deck')
      raw.general = { at: now, ...OLD_GENERAL_FIELDS, ...(cardNewsPath ? { cardNewsPath } : {}), ...(promoVideoPath ? { promoVideoPath } : {}), ...(introDeckPath ? { introDeckPath } : {}) }
    } else {
      install = installSkillPack(ctx, userId, 'general')
      const cardNewsPath = placed(install, GENERAL_CARDNEWS_SKILL)
      const promoVideoPath = placed(install, GENERAL_PROMO_SKILL)
      const introDeckPath = placed(install, GENERAL_DECK_SKILL)
      if (cardNewsPath || promoVideoPath || introDeckPath) {
        raw.general = { at: now, ...OLD_GENERAL_FIELDS, cardNewsPath, promoVideoPath, introDeckPath }
        delete raw.generalBlockedAt
        outcome = 'installed'
      } else {
        raw.generalBlockedAt = now
        outcome = 'blocked'
      }
    }
    p = save(ctx, raw, now)
  }
  // an older build's seeder, run again later, adds none of the skills it knew (onboarding/retired-skills.ts); a settings
  // write that fails never stops the team's start (the server's start writes it too)
  try { retireLegacyDefaultSkills(ctx.db) } catch (e) { ctx.log.warn('the old default skills not recorded as retired in the welcome steps', { err: e }) }
  raw.teamGroup = teamGroupFor(ctx, userId, p.teamGroup ?? null, locale)
  return { progress: save(ctx, raw, now), install, outcome }
}

/**
 * The intro deck's chat, once per team (docs/DECISIONS.md "W5": 회사 소개's "저장하고 계속" starts it; saving again only
 * saves). `started`: the deck's chat is the owner's, not deleted, and holds a message (recorded as `resultChatId` now if
 * it was not yet). `reuse`: the chat made for the deck is theirs and holds none (the page was closed, or its send
 * failed): it is handed out again. Otherwise `make` creates the chat and it is kept for the deck (`deckChatId`, not yet
 * `resultChatId`) in the same synchronous step, so two requests at once get one chat.
 */
export function deckChatFor(ctx: Pick<AppContext, 'db'>, userId: string, make: () => string): { kind: 'started'; chatId: string } | { kind: 'reuse' | 'new'; chatId: string } {
  const now = new Date().toISOString()
  const raw = forWrite(ctx, now)
  const recorded = view(raw, now).resultChatId
  if (recorded && chatThere(ctx, recorded, userId)) {
    // a deck that started; or a first result's chat of a row from before that never got its message: sent into again
    return holdsMessage(ctx, recorded) ? { kind: 'started', chatId: recorded } : { kind: 'reuse', chatId: recorded }
  }
  const kept = typeof raw[DECK_CHAT] === 'string' ? raw[DECK_CHAT] as string : null
  if (kept && chatThere(ctx, kept, userId)) {
    if (!holdsMessage(ctx, kept)) return { kind: 'reuse', chatId: kept }
    // its message is in while `resultChatId` still names a deleted chat: this one is the deck
    raw.resultChatId = kept
    save(ctx, raw, now)
    return { kind: 'started', chatId: kept }
  }
  const chatId = make()
  raw[DECK_CHAT] = chatId
  // a recorded chat that is gone (deleted) is no deck any more: the new one becomes it once its message is in
  raw.resultChatId = null
  save(ctx, raw, now)
  return { kind: 'new', chatId }
}

/** "/intro-deck" for the first result (docs/DECISIONS.md "D2"; the promo video of "V" and the card news of "N" before
 * it, both still installed with the pack): the recorded path, or once, for a row whose general pack was recorded before
 * the skill existed, the skill installed on its own and recorded (null when blocked). `install` runs only then; a skill
 * recorded and deleted on purpose afterwards is not brought back. */
export function introDeckSkill(ctx: AppContext, userId: string, install: () => { path: string; status: string; sameNameAs?: string }): string | null {
  const now = new Date().toISOString()
  const raw = forWrite(ctx, now)
  const general = isObj(raw.general) ? raw.general : null
  if (!general) return null
  if (typeof general.introDeckPath === 'string') return general.introDeckPath
  if (general.introDeckPath === null) return null
  const r = install()
  const path = r.status === 'blocked' ? (r.sameNameAs ?? null) : r.path
  raw.general = { ...general, introDeckPath: path }
  save(ctx, raw, now)
  return path
}

/**
 * The skills an owner just shared from 내 스킬 가져오기 (docs/DECISIONS.md "SK", "W5"; server/src/skills/share.ts apply),
 * from the welcome step or from /skills/share/:id alike: any apply that went through (`went`: skills added, merges
 * started or waiting, the team rule, tools) marks 내 스킬 done (and no longer waiting for a computer); the skills added
 * go to `shared` in order (each path once), and the invite's skill is set once (`landing`: the first recommended one
 * added, else the first added; the owner changes it on the invite). Only while the steps' row exists and only for the
 * owner (an admin's share changes nothing here). Never throws: the share is done either way. Returns whether this save
 * just ended the steps (the hooks of onWelcomeEnded have run then).
 */
export function recordShared(ctx: Pick<AppContext, 'db' | 'log'> & Partial<AppContext>, userId: string, added: { path: string; title: string; recommended: boolean }[], went = added.length > 0): boolean {
  if (!went && !added.length) return false
  try {
    const owner = ctx.db.query("SELECT 1 FROM users WHERE id = ? AND role = 'owner'").get(userId)
    const s = stored(ctx)
    if (!owner || !s.raw) return false
    const now = new Date().toISOString()
    const raw: Raw = { ...s.raw, steps: isObj(s.raw.steps) ? { ...s.raw.steps } : {} }
    settleDeck(ctx, raw)
    const p = view(raw, now)
    if (added.length) {
      const skills = [...(p.shared?.skills ?? [])]
      for (const a of added) if (!skills.some((x) => x.path === a.path)) skills.push({ path: a.path, title: a.title })
      const landing = p.shared?.landing ?? added.find((a) => a.recommended)?.path ?? added[0]!.path
      raw.shared = { at: p.shared?.at ?? now, skills, landing }
    }
    ;(raw.steps as Raw).skills = 'done'
    delete raw.skillsLater
    const r = saveRow(ctx, raw, now)
    if (r.finished) finishedNow(ctx, userId)
    return r.finished
  } catch (err) {
    ctx.log.warn('welcome shared skills not recorded', { err })
    return false
  }
}
