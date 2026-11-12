// The dev environment's setting (docs/DECISIONS.md "Dev environment on srt, behind a flag" and "Dev environment: box
// runner removed, srt only"): one setting for the team, and who may use it. Off unless the server runs with
// MYCEL_DEV_ENV=1. What a person may read and write in a run is decided per run from the folder rules (srt/access.ts).
import { DEV_ENV_SRT_WARNING_VERSION, DevEnvTeamSetting, type DevEnvConsent, type DevEnvScope } from '@mycel/shared/api'
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import { getSetting, setSetting } from '../admin/settings'

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
