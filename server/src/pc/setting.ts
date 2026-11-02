// PC runner (docs/DECISIONS.md "PC runner"): the per-project setting and who may use it. Off unless the server runs with
// MYCEL_PC_RUNNER=1 AND an owner or admin turned it on for the project after accepting the current warning. Folder
// permissions stay the only permission model: in every scope a person needs write access to the project folder, checked
// at the start of the turn and on every call.
import { PC_RUNNER_WARNING_VERSION, PcRunnerProjectSetting, type DevEnvConsent, type DevEnvScope } from '@mycel/shared/api'
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import { canWrite } from '../chat/projects'
import { getSetting, setSetting } from '../admin/settings'

/** the feature flag (environment of the server process); off by default */
export const pcRunnerFlag = (env: Record<string, string | undefined> = process.env) => env.MYCEL_PC_RUNNER === '1'

export const settingKey = (projectId: string) => `pcRunner.project.${projectId}`
export const OFF_SETTING: PcRunnerProjectSetting = { enabled: false, scope: { mode: 'writers', groupIds: [], userIds: [] }, consent: null }

export function pcSetting(db: Database, projectId: string): PcRunnerProjectSetting {
  const v = PcRunnerProjectSetting.safeParse(getSetting(db, settingKey(projectId)))
  return v.success ? v.data : OFF_SETTING
}

export function savePcSetting(db: Database, projectId: string, s: PcRunnerProjectSetting) {
  setSetting(db, settingKey(projectId), { ...s, scope: { mode: s.scope.mode, groupIds: [...new Set(s.scope.groupIds)], userIds: [...new Set(s.scope.userIds)] } })
}

/** on, and with a consent to the current warning (a newer warning turns every project off until accepted again) */
export function pcInForce(s: PcRunnerProjectSetting, flag = pcRunnerFlag()): boolean {
  return flag && s.enabled && s.consent?.warningVersion === PC_RUNNER_WARNING_VERSION
}

function inScope(db: Database, scope: DevEnvScope, userId: string): boolean {
  if (scope.mode === 'writers') return true
  if (scope.userIds.includes(userId)) return true
  if (!scope.groupIds.length) return false
  return !!db.query(`SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (${scope.groupIds.map(() => '?').join(',')}) LIMIT 1`).get(userId, ...scope.groupIds)
}

export interface PcProjectRef { id: string; folderPath: string }

/** May this person's desktop app work on the project now? Active account, setting in force, in scope, write access to
 * the folder as the rules are now. */
export function mayUsePc(db: Database, files: FileService, project: PcProjectRef, userId: string, flag = pcRunnerFlag()): boolean {
  const s = pcSetting(db, project.id)
  if (!pcInForce(s, flag)) return false
  let p
  try { p = files.principal(userId) } catch { return false }
  if (!p) return false
  if (!inScope(db, s.scope, userId)) return false
  return canWrite(files, p, project.folderPath)
}

export function newPcConsent(by: { id: string; name: string }): DevEnvConsent {
  return { by, at: new Date().toISOString(), warningVersion: PC_RUNNER_WARNING_VERSION }
}
