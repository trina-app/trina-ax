// What the team prepared, as one person sees it (docs/DECISIONS.md "W6.3 — What a new member sees first"; contract
// shared/src/api/skills.ts TeamPrepared, GET /api/skills/examples): Home's "팀에 준비된 것" for every role, the invite
// step's "지금 초대하면 팀원이 볼 게 없어요" line and the Files screen's way into 팀 파일 read it.
//
// Everything is read as the caller, through the same functions as their own lists: their skills are their GET
// /api/skills (scanSkillsWithShadowed: what "/<name>" runs for them), the team folder is counted with their folder
// rules (authorize, RuleSet), the landing skill only when it is in their list. The welcome state itself stays for
// owners and admins: only the team group's folder path is read from it, and sent only when the caller can read that
// folder. Nothing owner-only goes out: no company profile (one boolean), no install, no names of files.
//
// A kept skill gets Trina's example and source line only at its own pack path (skills/<pack>/<name>/SKILL.md): an
// owner's own "card-news" in another folder is the team's skill, not Trina's, and shows as one of the other skills.
import fs from 'node:fs'
import path from 'node:path'
import { BRAND_FOLDER, isSystemName, SHARED_HOME, skillSummary, skillTitle, TEAM_FOLDER_COUNT_MAX, type Locale, type PreparedSkill, type TeamPrepared } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { groupFolder } from '../admin/groups'
import { teamDefaultLocale } from '../admin/settings'
import { groupSkillsDir, isPersonalSkill, scanSkillsWithShadowed, type Skill } from '../chat/skills'
import { readCompanyProfile } from '../onboarding/profile'
import { CATALOG, packExample, packLocale, packSummary, SKILL_PACKS } from '../onboarding/skill-packs'
import { landingSkill, readWelcome } from '../onboarding/welcome'
import { atLeast, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { badSegment, hiddenEntry } from '../policy/names'

/** The kept skills in the order a member meets them (FLOW-v6.3 §4.2): the one for their own text first, then the ones
 * with a topic, the company deck last (회사 소개서 remakes the company's own material). */
export const MEMBER_ORDER = ['humanizer', 'card-news', 'promo-video', 'intro-deck'] as const
/** Entries the count looks at before it stops (a team folder of many folders and few files stays cheap). */
export const COUNT_VISIT_MAX = 5000

const lineOf = (text: string) => (text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '').slice(0, 200)

type Count = { path: string; files: number; more: boolean }

/**
 * The documents under `folder` the caller can read, all levels down, without `skip` (folders left out with all they
 * hold), dot files, Office lock files and the files an operating system makes; links, hard links and odd names are not
 * documents (as on the file screen). Folders are read entry by entry (opendir), so the walk stops where it reaches
 * TEAM_FOLDER_COUNT_MAX (or COUNT_VISIT_MAX entries looked at): `more`. null: the caller cannot list the folder, or it
 * is not one.
 */
export function countDocuments(ctx: Pick<AppContext, 'files'>, user: Principal, folder: string, skip: readonly string[] = []): Count | null {
  const fx = ctx.files.fx
  const rules = ctx.files.rules()
  let r
  try { r = authorize(fx, rules, user, folder, 'list') } catch { return null }
  if (!r.st?.isDirectory()) return null
  const fold = (p: string) => (fx.caseInsensitive ? p.normalize('NFC').toLowerCase() : p.normalize('NFC'))
  const skipped = new Set(skip.map(fold))
  let files = 0, visited = 0, more = false
  /** false: stop the whole walk */
  const walk = (segs: string[], abs: string): boolean => {
    let dir: fs.Dir
    try { dir = fs.opendirSync(abs) } catch { return true }
    try {
      for (let e = dir.readSync(); e; e = dir.readSync()) {
        if (++visited > COUNT_VISIT_MAX) { more = true; return false }
        if (hiddenEntry(e.name, segs.length) || badSegment(e.name) || e.isSymbolicLink()) continue
        if (e.name.startsWith('.') || e.name.startsWith('~$') || isSystemName(e.name)) continue
        const c = [...segs, e.name]
        if (skipped.has(fold(c.join('/')))) continue
        const at = path.join(abs, e.name)
        let st: fs.Stats
        try { st = fs.lstatSync(at) } catch { continue }
        if (st.isDirectory()) {
          if (rules.canList(user, c) && !walk(c, at)) return false
        } else if (st.isFile() && st.nlink === 1 && atLeast(rules.access(user, c), 'read')) {
          if (files >= TEAM_FOLDER_COUNT_MAX) { more = true; return false }
          files++
        }
      }
    } catch { /* a folder that changed while it was read: what was counted stands */ } finally { try { dir.closeSync() } catch { /* closed */ } }
    return true
  }
  walk(r.segs, r.abs)
  return { path: r.rel, files, more }
}

/** How long a person's count is reused: every open Home and the Files screen read it, and a busy team folder is not
 * walked again for each. The person's own change in the folder (the file screen, an upload, their AI's save: the
 * changes every screen hears of, team-files/changes.ts publishChanges) drops theirs at once; someone else's shows within
 * this time. */
export const DOCUMENT_COUNT_CACHE = { ttlMs: 45_000, max: 2000 }
type Cached = { at: number; userId: string; folder: string; value: Count | null }
const caches = new WeakMap<object, Map<string, Cached>>()
const under = (p: string, folder: string) => p === folder || p.startsWith(`${folder}/`) || folder.startsWith(`${p}/`)
function cacheOf(ctx: Pick<AppContext, 'files'>): Map<string, Cached> {
  let m = caches.get(ctx.files)
  if (m) return m
  const own = (m = new Map())
  caches.set(ctx.files, own)
  ctx.files.events.on('tree-changed', (e: { paths?: string[]; by?: string[] } | undefined) => {
    const by = new Set(e?.by ?? [])
    if (!by.size) return
    for (const [k, c] of own) if (by.has(c.userId) && (e?.paths ?? []).some((p) => under(p, c.folder))) own.delete(k)
  })
  return own
}
/** Every reused count forgotten (tests that change files on disk without the file layer). */
export function forgetDocumentCounts(ctx: Pick<AppContext, 'files'>): void { caches.get(ctx.files)?.clear() }

/** countDocuments, reused for DOCUMENT_COUNT_CACHE.ttlMs per person and folder. */
export function cachedDocuments(ctx: Pick<AppContext, 'files'>, user: Principal, folder: string, skip: readonly string[]): Count | null {
  const m = cacheOf(ctx)
  const key = [user.id, folder, ...skip].join('\u0000')
  const now = Date.now()
  const hit = m.get(key)
  if (hit && now - hit.at < DOCUMENT_COUNT_CACHE.ttlMs) return hit.value
  const value = countDocuments(ctx, user, folder, skip)
  if (m.size >= DOCUMENT_COUNT_CACHE.max) for (const [k, c] of m) if (now - c.at >= DOCUMENT_COUNT_CACHE.ttlMs || m.size >= DOCUMENT_COUNT_CACHE.max) m.delete(k)
  m.set(key, { at: now, userId: user.id, folder, value })
  return value
}

/** The team's folder of company material and what in it is the steps' own (the brand folder, the group's skills), as
 * names inside it, from the welcome row: shared/ for a team whose start ran since docs/DECISIONS.md "Team folder basics"
 * (everyone in the team counts it), else the team group's folder as it is now (a renamed group keeps its id). null: no
 * team group yet. */
function teamGroupFolder(ctx: AppContext): { folder: string; without: string[] } | null {
  const tg = readWelcome(ctx)?.teamGroup
  if (!tg) return null
  if (tg.home === SHARED_HOME) {
    const inside = tg.brandFolder?.startsWith(`${SHARED_HOME}/`) ? tg.brandFolder.slice(SHARED_HOME.length + 1) : BRAND_FOLDER[teamDefaultLocale(ctx.db)]
    return { folder: SHARED_HOME, without: [inside] }
  }
  const folder = groupFolder(ctx, tg.id)
  if (!folder) return null
  // the brand folder as recorded, moved with a renamed group; a row from before it records none: the name the steps
  // give it in the team's language
  const inside = tg.brandFolder?.startsWith(`${tg.folder}/`) ? tg.brandFolder.slice(tg.folder.length + 1) : BRAND_FOLDER[teamDefaultLocale(ctx.db)]
  return { folder, without: [inside, groupSkillsDir(folder).slice(folder.length + 1)] }
}

/** The caller ran a team skill in an answer that finished, themselves (a scheduled run is no try: as the goal and the
 * suggestions count, onboarding/goal.ts, onboarding/suggestions.ts). turn_skill_runs records team skills only
 * (migration 223). */
export function ranTeamSkill(ctx: Pick<AppContext, 'db'>, userId: string): boolean {
  return !!ctx.db.query(`SELECT 1 FROM turns t CROSS JOIN turn_skill_runs r ON r.turn_id = t.id
    WHERE t.user_id = ? AND t.status = 'done' AND t.schedule_id IS NULL LIMIT 1`).get(userId)
}

/** GET /api/skills/examples as `userId` (any role), the one lines in `locale`. */
export function teamPrepared(ctx: AppContext, userId: string, locale: Locale): TeamPrepared {
  const me = ctx.files.principal(userId)
  const fold = (p: string) => (ctx.files.fx.caseInsensitive ? p.normalize('NFC').toLowerCase() : p)
  // what "/<name>" runs for the caller, personal skills left out (a team member did not prepare those)
  const mine = scanSkillsWithShadowed(ctx.files, me).skills.filter((s) => !isPersonalSkill(s.path))
  const team = teamDefaultLocale(ctx.db)
  const kept = new Map<string, { s: Skill; out: PreparedSkill }>()
  for (const name of MEMBER_ORDER) {
    const c = CATALOG.find((x) => x.name === name)
    if (!c) continue
    const at = `skills/${c.pack}/${c.name}/SKILL.md`
    const s = mine.find((x) => fold(x.path) === fold(at))
    if (!s) continue
    const lang = packLocale(SKILL_PACKS[c.pack], team)
    // an example that cannot be read leaves the row without 예시, never without the row
    let example
    try { example = packExample(lang, c.name) ?? undefined } catch { example = undefined }
    kept.set(s.path, { s, out: { path: s.path, name: s.name, title: skillTitle(s), summary: packSummary(c.name, locale) || lineOf(skillSummary(s)), ...(example ? { example, locale: lang === 'ko' ? 'ko' : 'en' } : {}), source: c.source(lang) } })
  }
  const others = mine.filter((s) => !kept.has(s.path)).map((s): PreparedSkill => ({ path: s.path, name: s.name, title: skillTitle(s), summary: lineOf(skillSummary(s)) }))
  let landing: string | null = null
  try { landing = landingSkill(ctx, userId) } catch { landing = null }
  if (landing && !mine.some((s) => s.path === landing)) landing = null
  const ordered = [...[...kept.values()].map((k) => k.out), ...others]
  const skills = landing ? [...ordered.filter((s) => s.path === landing), ...ordered.filter((s) => s.path !== landing)] : ordered
  const g = teamGroupFolder(ctx)
  const count = g ? cachedDocuments(ctx, me, g.folder, g.without.map((w) => `${g.folder}/${w}`)) : null
  const teamFolder = g && count ? { ...count, without: g.without } : null
  return { skills, teamFolder, landing, ranTeamSkill: ranTeamSkill(ctx, userId), hasProfile: !!readCompanyProfile(ctx.files, me) }
}
