// Team settings (tab 1 `settings`: key -> JSON value). One key per TeamSettings field; internal keys use a dot
// prefix ("engines.enabled"). Other components read settings through getTeamSettings() (read-only for them).
import type { Database } from 'bun:sqlite'
import { TeamSettings, type EngineId, type TeamSettings as TeamSettingsT } from '@mycel/shared/api'

export const DEFAULT_SETTINGS: TeamSettingsT = {
  teamName: 'Team AX',
  defaultLocale: 'ko',
  defaultEngine: 'claude-code',
  defaultModel: null,
  concurrency: 3,
  updateChannel: 'stable',
  updateWindow: null,
  auditRetentionDays: 90,
  /** tab 1 file_versions: "기본 최근 7일 유지" (the sweep in team-files/service.ts reads this same value) */
  fileHistoryRetentionDays: 7,
  trashRetentionDays: 30,
  chatTrashRetentionDays: 7,
}

const FIELDS = Object.keys(TeamSettings.shape) as (keyof TeamSettingsT)[]

export function getSetting<T>(db: Database, key: string): T | undefined {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null
  if (!row) return undefined
  try { return JSON.parse(row.value) as T } catch { return undefined }
}

export function setSetting(db: Database, key: string, value: unknown): void {
  db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

/** Stored settings over the defaults. A stored value that no longer fits the schema falls back to the default. */
export function getTeamSettings(db: Database): TeamSettingsT {
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>
  const rows = db.query(`SELECT key, value FROM settings WHERE key IN (${FIELDS.map(() => '?').join(',')})`).all(...FIELDS) as { key: string; value: string }[]
  for (const r of rows) {
    let v: unknown
    try { v = JSON.parse(r.value) } catch { continue }
    const field = TeamSettings.shape[r.key as keyof TeamSettingsT]
    if (field && field.safeParse(v).success) out[r.key] = v
  }
  return out as TeamSettingsT
}

export function updateTeamSettings(db: Database, patch: Partial<TeamSettingsT>): TeamSettingsT {
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && (FIELDS as string[]).includes(k)) setSetting(db, k, v)
  })()
  return getTeamSettings(db)
}

/** Which engines the admin turned on (default: both). */
export function enginesEnabled(db: Database): Record<EngineId, boolean> {
  const v = getSetting<Partial<Record<EngineId, boolean>>>(db, 'engines.enabled') ?? {}
  return { 'claude-code': v['claude-code'] ?? true, codex: v.codex ?? true }
}
export function setEnginesEnabled(db: Database, patch: Partial<Record<EngineId, boolean>>) {
  setSetting(db, 'engines.enabled', { ...enginesEnabled(db), ...patch })
}
