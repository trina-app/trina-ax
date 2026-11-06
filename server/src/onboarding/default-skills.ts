// Default skills (docs/DECISIONS.md "DS — Every skill pack is a default"): every skill of the packs in
// DEFAULT_SKILL_PACKS (general, marketing, work) is in the team without anyone installing it. Each skill is added once,
// in the team's language (English when the pack has none for it), written as the owner through the same file layer as
// a pack install (onboarding/skill-packs.ts placeSkill: folder rules decide, version history and the skills/ audit
// follow, the file event is marked as the pack's, so the owner is not its maker).
//
// "Once" is recorded per skill in one settings row, so a skill the team deletes or moves later never comes back. A
// skill is recorded without writing anything when:
// - its file is there already (the pack's text: `present`; other text, someone edited it: `kept`; never replaced);
// - another team skill already has its name (`blocked`: "/<name>" would run either one; no second copy);
// - its path has a history in file_events but no file now (`removed`: an install before this one, then a delete or a
//   move; file_events keep at least 365 days, older than the packs themselves).
// Only a write the folder rules refused stays unrecorded and is tried again on the next run.
//
// Runs on the server's start and then every 10 minutes (never under `bun test`), and in the welcome steps right after
// the general pack (setupWelcomeTeam), so a new team has its skills from its first steps. With nothing left to add a
// run reads one settings row. A server with no active owner yet (setup not done) does nothing.
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SKILL_PACKS, type SkillPackId } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { setSetting, teamDefaultLocale } from '../admin/settings'
import { listTeamSkills } from '../chat/skills'
import { packLocale, placeSkill, SKILL_PACKS } from './skill-packs'

export const DEFAULT_SKILLS_SETTING = 'onboarding.defaultSkills'
/** how often a running server looks for default skills it has not added yet */
export const DEFAULT_SKILLS_EVERY_MS = 10 * 60_000
/** the first run after the start: after the listeners are up, never in the way of the health check */
const FIRST_RUN_MS = 5_000

type Recorded = Record<string, { at: string; status: string }>
export interface DefaultSkillsResult { created: string[]; recorded: number; pending: number }

/** The row as stored: an object, none (empty), or null when it does not read (it is then left alone, never replaced). */
function recordedSkills(ctx: Pick<AppContext, 'db'>): Recorded | null {
  const r = ctx.db.query('SELECT value FROM settings WHERE key = ?').get(DEFAULT_SKILLS_SETTING) as { value: string } | null
  if (!r) return {}
  try {
    const v = JSON.parse(r.value) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Recorded : null
  } catch { return null }
}

/** Every default skill as `<pack>/<name>`, in pack order. */
export function defaultSkillKeys(): { id: SkillPackId; name: string; key: string }[] {
  return DEFAULT_SKILL_PACKS.flatMap((id) => Object.keys(SKILL_PACKS[id].skills.en).map((name) => ({ id, name, key: `${id}/${name}` })))
}

/** The account the skills are written as: the first active owner. */
function ownerId(ctx: Pick<AppContext, 'db'>): string | null {
  const r = ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string } | null
  return r?.id ?? null
}

const hadHistory = (ctx: Pick<AppContext, 'db'>, rel: string) => !!ctx.db.query('SELECT 1 FROM file_events WHERE path = ? LIMIT 1').get(rel)
/** Something is at the path (a file, a folder, a link): only whether, never read; placeSkill decides what it means. */
function present(ctx: AppContext, rel: string): boolean {
  try { fs.lstatSync(path.join(ctx.files.fx.root, ...rel.split('/'))); return true } catch { return false }
}

/**
 * Add the default skills the team does not have yet, once each (see the top of this file). `userId`: the owner who
 * walks the welcome steps; the first active owner otherwise. null when nothing can run (no owner, a row that does not
 * read). Synchronous, so two runs never interleave.
 */
export function seedDefaultSkills(ctx: AppContext, userId?: string | null): DefaultSkillsResult | null {
  const recorded = recordedSkills(ctx)
  if (!recorded) return null
  const todo = defaultSkillKeys().filter((s) => !recorded[s.key])
  if (!todo.length) return { created: [], recorded: 0, pending: 0 }
  const owner = userId ?? ownerId(ctx)
  if (!owner) return null
  const team = teamDefaultLocale(ctx.db)
  const now = new Date().toISOString()
  // the team skills as the owner sees them (every team folder), personal ones left out; grows as skills are added
  const skills = listTeamSkills(ctx.files, ctx.files.principal(owner)).map((s) => ({ path: s.path, name: s.name }))
  const created: string[] = []
  let count = 0, pending = 0
  for (const s of todo) {
    const pack = SKILL_PACKS[s.id]
    const text = pack.skills[packLocale(pack, team)]?.[s.name] ?? pack.skills.en[s.name]!
    const rel = `skills/${s.id}/${s.name}/SKILL.md`
    // nothing at the path, but it was used before: deleted or moved on purpose, not brought back
    if (!present(ctx, rel) && hadHistory(ctx, rel)) {
      recorded[s.key] = { at: now, status: 'removed' }
      count++
      continue
    }
    const r = placeSkill(ctx, owner, rel, s.name, text, skills)
    if (r.status === 'blocked' && !r.sameNameAs) { pending++; continue }
    recorded[s.key] = { at: now, status: r.status }
    count++
    if (r.status === 'created') { created.push(r.path); skills.push({ path: r.path, name: s.name }) }
  }
  setSetting(ctx.db, DEFAULT_SKILLS_SETTING, recorded)
  if (created.length) audit(ctx.db, { actor: owner, action: 'onboarding.default_skills', target: 'skills', detail: { created: created.length, locale: team } })
  return { created, recorded: count, pending }
}

/** Run now (a little after the start) and every DEFAULT_SKILLS_EVERY_MS; a failure is logged, never thrown. */
export function startDefaultSkills(ctx: AppContext, everyMs = DEFAULT_SKILLS_EVERY_MS): void {
  const run = () => {
    try {
      const r = seedDefaultSkills(ctx)
      if (r?.created.length) ctx.log.info('default skills added', { created: r.created.length, pending: r.pending })
    } catch (e) {
      ctx.log.warn('adding the default skills failed; trying again later', { err: e })
    }
  }
  const first = setTimeout(run, FIRST_RUN_MS)
  const timer = setInterval(run, everyMs)
  first.unref?.()
  timer.unref?.()
  ctx.onClose(() => { clearTimeout(first); clearInterval(timer) })
}
