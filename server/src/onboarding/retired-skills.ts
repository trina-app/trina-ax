// A rollback guard for the removed default skills (docs/DECISIONS.md "DS3 — Only skills with a known origin ship; no
// auto-add"). Builds before DS3 ran a seeder (onboarding/default-skills.ts, removed) at their start and every 10
// minutes: it wrote every key of its default packs that the settings row `onboarding.defaultSkills` did not record yet
// into the team's skills/ folder. A team made on this build never got that row, so an older build run again (the dev
// server installs every dev build; a customer may downgrade) would add all of them with nobody pressing anything.
//
// So this build records every key the old seeder knew as `retired`, once each: only keys that are missing (as the old
// seeder reads the row: no entry, or an empty one), never an entry that is there (its status stays what the old seeder
// wrote), and never a row that does not read as an object (the old seeder does nothing with such a row, and it is
// never replaced). A settings write only: no file is touched.
// Runs at the server's start and in the welcome steps (setupWelcomeTeam). Nothing on this build reads the row.
import type { Database } from 'bun:sqlite'
import { setSetting } from '../admin/settings'

export const LEGACY_DEFAULT_SKILLS_SETTING = 'onboarding.defaultSkills'

/** Every `<pack>/<name>` key the old seeder added (DS: general 5 and marketing 7; DS2: work 7, natural writing the
 * last), the four skills that still ship included: an old seeder adds whatever is missing here. Frozen on purpose: it
 * is what older builds would install, not what this build ships, so it never changes with the packs. */
export const LEGACY_DEFAULT_SKILL_KEYS: readonly string[] = Object.freeze([
  'general/meeting-tasks', 'general/doc-brief', 'general/card-news', 'general/promo-video', 'general/intro-deck',
  'marketing/ad-copy', 'marketing/content-draft', 'marketing/campaign-plan', 'marketing/seo-brief', 'marketing/competitor-brief', 'marketing/brand-review', 'marketing/weekly-report',
  'work/meeting-summary', 'work/weekly-team-report', 'work/sales-follow-up', 'work/brand-brief', 'work/expense-review', 'work/new-hire-guide', 'work/humanizer',
])

/** Every skill name a pack shipped before DS3 (the old seeder's keys and the optional hr pack's three). Frozen like the
 * keys: a team's copy installed by an older release keeps these names, and an install from before the install mark is
 * still told apart from a person's own skill by them (skills/author.ts). */
export const LEGACY_PACK_SKILL_NAMES: readonly string[] = Object.freeze([
  ...new Set([...LEGACY_DEFAULT_SKILL_KEYS.map((k) => k.slice(k.indexOf('/') + 1)), 'labor-contract', 'employment-certificate', 'annual-leave']),
])

/**
 * Record the old seeder's keys that the row is missing as `retired` (see the top of this file). Returns how many were
 * added (0: nothing written). Synchronous: the read and the write never interleave with another request's.
 */
export function retireLegacyDefaultSkills(db: Database, now = new Date()): number {
  const r = db.query('SELECT value FROM settings WHERE key = ?').get(LEGACY_DEFAULT_SKILLS_SETTING) as { value: string } | null
  let recorded: Record<string, unknown> = {}
  if (r) {
    let v: unknown
    try { v = JSON.parse(r.value) } catch { return 0 }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 0
    recorded = v as Record<string, unknown>
  }
  const at = now.toISOString()
  const missing = LEGACY_DEFAULT_SKILL_KEYS.filter((k) => !recorded[k])
  if (!missing.length) return 0
  setSetting(db, LEGACY_DEFAULT_SKILLS_SETTING, { ...recorded, ...Object.fromEntries(missing.map((k) => [k, { at, status: 'retired' }])) })
  return missing.length
}
