// The onboarding part of the hosting status (TenantStatus.onboarding, shared/src/cloud-protocol/tenant-commands.ts):
// admin.js cloud-status adds it (system/cloud-tenant.ts) for the hosting operator's activation mails and its list of
// teams to contact. Counts and yes/no only: never a name, mail, skill name or path (docs/DECISIONS.md "G — The 7-day
// team goal"). Reads the database and two places in the team folder; no file service, no access checks (it runs as
// the server account in admin.js and says only whether something is there).
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { TenantOnboarding } from '@mycel/shared/cloud-protocol'
import { goalProgress } from './goal'
import { cleanProfile, PROFILE_PATH, profileEmpty } from './profile'

const DAY_MS = 86_400_000
/** a profile file larger than this is not read (as onboarding/profile.ts) */
const PROFILE_MAX_BYTES = 64 * 1024
/** where the marketing pack puts its skills (onboarding/skill-packs.ts: skills/<pack>/<name>/SKILL.md) */
const PACK_DIR = 'skills/marketing'

const regularFile = (p: string) => { try { return fs.lstatSync(p).isFile() } catch { return false } }

/** skills/marketing/ holds a skill (a plain SKILL.md one folder down): the pack, or part of it, is installed. */
export function packInstalled(teamRoot: string): boolean {
  const dir = path.join(teamRoot, PACK_DIR)
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && regularFile(path.join(dir, e.name, 'SKILL.md')))
  } catch { return false }
}

/** A company profile is saved: the file is there, small, JSON, and has a field filled in (as the AI would get it). */
export function profileSaved(teamRoot: string): boolean {
  const p = path.join(teamRoot, PROFILE_PATH)
  try {
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > PROFILE_MAX_BYTES) return false
    const profile = cleanProfile(JSON.parse(fs.readFileSync(p, 'utf8')))
    return !!profile && !profileEmpty(profile)
  } catch { return false }
}

/** The block, or undefined while the team has no account (setup not done). */
export function tenantOnboarding(db: Database, teamRoot: string, now = Date.now()): TenantOnboarding | undefined {
  const p = goalProgress(db)
  if (!p) return undefined
  const n = (sql: string) => (db.query(sql).get() as { n: number }).n
  const accounts = n('SELECT COUNT(*) AS n FROM users')
  const membersJoined = Math.max(0, accounts - 1)
  const has = (table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  const inviteMade = membersJoined > 0 || n('SELECT COUNT(*) AS n FROM invites') > 0 || (has('team_links') && n('SELECT COUNT(*) AS n FROM team_links') > 0)
  const best = p.best?.people.length ?? 0
  return {
    day: Math.min(100_000, Math.max(0, Math.floor((now - Date.parse(p.startedAt)) / DAY_MS))),
    packInstalled: packInstalled(teamRoot),
    profileSaved: profileSaved(teamRoot),
    inviteMade,
    membersJoined,
    peopleAnswered: p.peopleAnswered,
    membersWithFirstRun: p.peopleWithRun,
    bestSkillRunners: best,
    goalReached: p.reachedAt !== null,
  }
}
