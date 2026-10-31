// Dev environment EXPERIMENT (docs/DECISIONS.md "Dev environment (experiment)"): the per-project setting and who may
// use the box. Off unless the server runs with MYCEL_DEV_ENV=1 AND an owner or admin turned it on for the project
// after accepting the current warning. Folder permissions stay the only permission model: in every scope a person
// needs write access to the project folder (the box writes the folder), checked again on every command.
import { DEV_ENV_DEFAULT_LIMITS, DEV_ENV_WARNING_VERSION, DevEnvProjectSetting, type DevEnvConsent, type DevEnvScope } from '@mycel/shared/api'
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import { canWrite } from '../chat/projects'
import { getSetting, setSetting } from '../admin/settings'

/** the experiment's feature flag (environment of the server process); off by default */
export const devEnvFlag = (env: Record<string, string | undefined> = process.env) => env.MYCEL_DEV_ENV === '1'

export const settingKey = (projectId: string) => `devEnv.project.${projectId}`
export const OFF_SETTING: DevEnvProjectSetting = { enabled: false, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, consent: null }

export function devEnvSetting(db: Database, projectId: string): DevEnvProjectSetting {
  const v = DevEnvProjectSetting.safeParse(getSetting(db, settingKey(projectId)))
  return v.success ? v.data : OFF_SETTING
}

export function saveDevEnvSetting(db: Database, projectId: string, s: DevEnvProjectSetting) {
  setSetting(db, settingKey(projectId), { ...s, scope: { mode: s.scope.mode, groupIds: [...new Set(s.scope.groupIds)], userIds: [...new Set(s.scope.userIds)] } })
}

/** on, and with a consent to the current warning (a newer warning turns every project off until accepted again) */
export function devEnvInForce(s: DevEnvProjectSetting, flag = devEnvFlag()): boolean {
  return flag && s.enabled && s.consent?.warningVersion === DEV_ENV_WARNING_VERSION
}

function inScope(db: Database, scope: DevEnvScope, userId: string): boolean {
  if (scope.mode === 'writers') return true
  if (scope.userIds.includes(userId)) return true
  if (!scope.groupIds.length) return false
  return !!db.query(`SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (${scope.groupIds.map(() => '?').join(',')}) LIMIT 1`).get(userId, ...scope.groupIds)
}

export interface ProjectRef { id: string; folderPath: string }

/** May this person run commands in the project's box now? Active account, setting in force, in scope, write access
 * to the folder as the rules are now. */
export function mayUseBox(db: Database, files: FileService, project: ProjectRef, userId: string, flag = devEnvFlag()): boolean {
  const s = devEnvSetting(db, project.id)
  if (!devEnvInForce(s, flag)) return false
  let p
  try { p = files.principal(userId) } catch { return false }
  if (!p) return false
  if (!inScope(db, s.scope, userId)) return false
  return canWrite(files, p, project.folderPath)
}

export function newConsent(by: { id: string; name: string }): DevEnvConsent {
  return { by, at: new Date().toISOString(), warningVersion: DEV_ENV_WARNING_VERSION }
}
