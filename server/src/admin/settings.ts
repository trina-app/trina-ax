// Team settings (tab 1 `settings`: key -> JSON value). One key per TeamSettings field; internal keys use a dot
// prefix ("engines.enabled"). Other components read settings through getTeamSettings() (read-only for them).
import type { Database } from 'bun:sqlite'
import { DEFAULT_LOCALE, Locale, TeamSettings, type EngineId, type TeamSettings as TeamSettingsT } from '@mycel/shared/api'

export const DEFAULT_SETTINGS: TeamSettingsT = {
  teamName: 'Team AX',
  defaultLocale: DEFAULT_LOCALE,
  defaultEngine: 'claude-code',
  defaultModel: null,
  concurrency: 3,
  updateChannel: 'stable',
  updateWindow: null,
  auditRetentionDays: 90,
  fileHistoryRetentionDays: 30,
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
    if (patch.defaultLocale !== undefined) syncFollowingLocales(db)
  })()
  return getTeamSettings(db)
}

/**
 * Realtime notice: the language someone sees may have changed (team default, an admin's edit, the person in another
 * window). Open windows ask GET /api/me again and switch without a reload; the message carries nothing.
 */
export const LOCALE_CHANGED = { type: 'notice', data: { level: 'info', code: 'locale_changed', message: '' } } as const

/** The team default language alone (cheap: read for every request without a session). */
export function teamDefaultLocale(db: Database): Locale {
  const v = Locale.safeParse(getSetting(db, 'defaultLocale'))
  return v.success ? v.data : DEFAULT_LOCALE
}

/**
 * People without their own language (users.locale_follows_team = 1) see the team default: users.locale is kept equal
 * to it, so every reader of users.locale (sessions, turns, jobs, notices) gets the right language without knowing
 * about the flag. Runs when the default changes and at server start (a restored DB or an older build may have left
 * it behind). Rows of people with their own choice are never touched.
 */
export function syncFollowingLocales(db: Database): void {
  db.query('UPDATE users SET locale = ? WHERE locale_follows_team = 1 AND locale <> ?').run(teamDefaultLocale(db), teamDefaultLocale(db))
}

/** Which engines the admin turned on (default: both). */
export function enginesEnabled(db: Database): Record<EngineId, boolean> {
  const v = getSetting<Partial<Record<EngineId, boolean>>>(db, 'engines.enabled') ?? {}
  return { 'claude-code': v['claude-code'] ?? true, codex: v.codex ?? true }
}
export function setEnginesEnabled(db: Database, patch: Partial<Record<EngineId, boolean>>) {
  setSetting(db, 'engines.enabled', { ...enginesEnabled(db), ...patch })
}
