// The dev environment's setting (docs/DECISIONS.md "Dev environment on srt, behind a flag" and "Dev environment: box
// runner removed, srt only"): one setting for the team, and who may use it. Off unless the server runs with
// MYCEL_DEV_ENV=1. What a person may read and write in a run is decided per run from the folder rules (srt/access.ts).
import { DEV_ENV_SRT_WARNING_VERSION, DevEnvTeamSetting, type DevEnvConsent, type DevEnvScope } from '@mycel/shared/api'
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import { getSetting, setSetting } from '../admin/settings'
import { isGuestUser } from '../credentials/guest-ai'

/** the feature flag (environment of the server process); off by default */
export const devEnvFlag = (env: Record<string, string | undefined> = process.env) => env.MYCEL_DEV_ENV === '1'

function inScope(db: Database, scope: DevEnvScope, userId: string): boolean {
  if (scope.mode === 'writers') return true
  if (scope.userIds.includes(userId)) return true
  if (!scope.groupIds.length) return false
  return !!db.query(`SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (${scope.groupIds.map(() => '?').join(',')}) LIMIT 1`).get(userId, ...scope.groupIds)
}

export interface ProjectRef { id: string; folderPath: string }

// ---------------- one setting for the team ----------------
// The dev environment is not locked to a project (owner, 2026-11-04): an admin turns it on for the team, any chat of a
// person in scope can run commands, and each run gets that person's folder access (srt/access.ts). The settings rows
// devEnv.project.<id> of the removed box runner stay in the database, and nothing reads them.

export const TEAM_SETTING_KEY = 'devEnv.team'

/** The default of a new team (owner, 2026-11-06): on, network "Allowed sites only" (open = the allowlist on srt),
 * with a consent of the product (by null) to the current srt warning. A team that had people before migration 236 got
 * an explicit off row there, so the default does not turn an existing team on. Admins turn it off as before. */
export const TEAM_DEFAULT_ON: DevEnvTeamSetting = DevEnvTeamSetting.parse({
  enabled: true, network: 'open', consent: { by: null, at: '2026-11-06T00:00:00.000Z', warningVersion: DEV_ENV_SRT_WARNING_VERSION },
})

/** the team setting (admins); no row = the default of a new team (on); a bad row is off */
export function teamSetting(db: Database): DevEnvTeamSetting {
  if (!db.query('SELECT 1 FROM settings WHERE key = ?').get(TEAM_SETTING_KEY)) return TEAM_DEFAULT_ON
  const v = DevEnvTeamSetting.safeParse(getSetting(db, TEAM_SETTING_KEY))
  return v.success ? v.data : DevEnvTeamSetting.parse({})
}

/** The team is off only because it had people before the dev environment came (QA TC-4911): its row is still the one
 * migration 236 wrote (`{"enabled":false}`, no other field), which no admin save writes (saveTeamSetting writes the
 * whole setting). Admins then get a one-time notice with the switch; nothing turns on by itself. */
export function oldTeamOffer(db: Database): boolean {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(TEAM_SETTING_KEY) as { value: string } | null
  if (!row) return false
  try {
    const v = JSON.parse(row.value) as unknown
    return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && (v as { enabled?: unknown }).enabled === false
  } catch { return false }
}

export function saveTeamSetting(db: Database, s: DevEnvTeamSetting) {
  setSetting(db, TEAM_SETTING_KEY, { ...s, scope: { mode: s.scope.mode, groupIds: [...new Set(s.scope.groupIds)], userIds: [...new Set(s.scope.userIds)] } })
}

/** on for the team, with a consent to the srt warning */
export function teamInForce(s: DevEnvTeamSetting, flag = devEnvFlag()): boolean {
  return flag && s.enabled && s.consent?.warningVersion === DEV_ENV_SRT_WARNING_VERSION
}

/** may this person run commands now, in any chat? Active account, the team setting in force, in scope. What the
 * person may read and write is decided per run from the folder rules (srt/access.ts), not here. */
export function mayUseDevEnv(db: Database, files: FileService, userId: string, flag = devEnvFlag()): boolean {
  const s = teamSetting(db)
  if (!teamInForce(s, flag)) return false
  try { if (!files.principal(userId)) return false } catch { return false }
  return inScope(db, s.scope, userId)
}


/** a consent of this person to the current warning */
export function newConsent(by: { id: string; name: string }): DevEnvConsent {
  return { by, at: new Date().toISOString(), warningVersion: DEV_ENV_SRT_WARNING_VERSION }
}

// ---------------- documents mode ----------------
// docs/decisions/20261124-documents-mode.md (owner, 2026-11-24): Word, PowerPoint and Excel files are built with the
// document skills on every install, so where the dev environment is installed (the flag) and the team never chose it
// (no saved setting, or the row an older team got from migration 236: oldTeamOffer) box_shell still runs in documents mode:
// no network, no team folders, only the chat's work folder (the AI copies a file in with copy_files, which checks the
// person's access). This one capability turns on without an admin step for teams that never chose; it reverses
// "nothing turns on by itself" for it alone. An admin's explicit choice is respected (security review of #508): a team
// whose admin saved the dev environment off, or a person left out of its scope, gets no documents mode either. Not for
// guests (deferred). MYCEL_DOCUMENTS_MODE=0 turns it off on a server.

/** documents mode on this server (on unless MYCEL_DOCUMENTS_MODE=0) */
export const documentsModeFlag = (env: Record<string, string | undefined> = process.env) => env.MYCEL_DOCUMENTS_MODE !== '0'

/** How this person's commands run now: 'full' (the dev environment), 'documents' (offline, work folder only) or null. */
export type CommandMode = 'full' | 'documents'
export function commandMode(db: Database, files: FileService, userId: string, flag = devEnvFlag()): CommandMode | null {
  if (mayUseDevEnv(db, files, userId, flag)) return 'full'
  if (!flag || !documentsModeFlag() || !teamNeverChose(db)) return null
  try { const p = files.principal(userId); if (!p || p.role === 'guest' || isGuestUser(db, userId)) return null } catch { return null }
  return 'documents'
}

/** may this person run commands now, in either mode? */
export const mayRunCommands = (db: Database, files: FileService, userId: string, flag = devEnvFlag()) => commandMode(db, files, userId, flag) !== null

/** The team never chose the dev environment: no saved setting, or still the row migration 236 wrote for an older team.
 * An admin's save (on or off, any scope) is a choice. */
export function teamNeverChose(db: Database): boolean {
  return !db.query('SELECT 1 FROM settings WHERE key = ?').get(TEAM_SETTING_KEY) || oldTeamOffer(db)
}
