// Team settings (tab 1 `settings`: key -> JSON value). One key per TeamSettings field; internal keys use a dot
// prefix ("engines.enabled"). Other components read settings through getTeamSettings() (read-only for them).
import type { Database } from 'bun:sqlite'
import { DEFAULT_ANSWER_STEP_LIMIT, DEFAULT_LOCALE, DEFAULT_SPEECH_MODEL, Locale, TeamSettings, type EngineId, type TeamSettings as TeamSettingsT, DEFAULT_DECK_TIER } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import { defaultTimeZone, isValidTimeZone } from '../system/time-zone'

export const DEFAULT_SETTINGS: TeamSettingsT = {
  teamName: PRODUCT.displayName,
  defaultLocale: DEFAULT_LOCALE,
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
  /** placeholder: getTeamSettings() puts defaultTimeZone() here (MYCEL_TEAM_TZ, else the process's zone, else UTC) */
  timeZone: 'UTC',
  /** people may turn on "Allow all websites" in the desktop app's in-app browser; each team (the director) decides */
  browserAllowAll: true,
  personalIntegrations: true,
  /** AI reads send images and PDF pages as images (files/vision.ts) */
  aiVision: true,
  /** the AI may split work into sub-tasks (Claude Code's Agent tool; chat/subagents.ts) */
  aiSubagents: true,
  /** tool rounds per answer (Claude Code --max-turns; chat/runtime.ts maxEngineTurns) */
  answerStepLimit: DEFAULT_ANSWER_STEP_LIMIT,
  /** the company intro deck's time budget (intro-deck/tiers.ts): 5 minutes until an owner or admin picks another */
  introDeckTier: DEFAULT_DECK_TIER,
  /** voice input is off until an admin picks OpenRouter (with a key) or this server (docs/DECISIONS.md "Voice input
   * through OpenRouter"); with the hosting service's key or the team's own OpenRouter key and no choice, it reads
   * OpenRouter (getTeamSettings) */
  speechProvider: 'off',
  speechModel: DEFAULT_SPEECH_MODEL,
  /** not chosen: the default follows the speech provider (shared mediaTranscriptsDefault) */
  aiMediaTranscripts: null,
}

const FIELDS = Object.keys(TeamSettings.shape) as (keyof TeamSettingsT)[]

/** The hosting service's speech-to-text key (credentials/speech-key.ts, set only by the control plane through mycel-ctl
 * hosted-speech-key-set). While it is here and no admin chose a speech provider, voice input defaults to OpenRouter. */
export const HOSTED_SPEECH_KEY_SETTING = 'speech.hostedKey'
/** The team's own OpenRouter key for speech-to-text (credentials/speech-key.ts, Admin › Team settings › Voice input).
 * While it is here and no admin chose a speech provider, voice input uses OpenRouter: on a team's own server, saving
 * the key is how voice input is turned on. */
export const SPEECH_KEY_SETTING = 'speech.openrouterKey'
/** this month's seconds of sound sent with that key (credentials/hosted-speech.ts) */
export const HOSTED_SPEECH_USAGE_SETTING = 'speech.hostedUsage'
/** The hosting service's trial AI credit (credentials/hosted-chat.ts, set only by the control plane through mycel-ctl
 * hosted-chat-key-set): an OpenRouter key for the API engine, its dollar cap, end time and switch. */
export const HOSTED_CHAT_KEY_SETTING = 'ai.hostedChatKey'
/** the dollars spent with that key so far (credentials/hosted-chat.ts) */
export const HOSTED_CHAT_USAGE_SETTING = 'ai.hostedChatUsage'

export function getSetting<T>(db: Database, key: string): T | undefined {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null
  if (!row) return undefined
  try { return JSON.parse(row.value) as T } catch { return undefined }
}

export function setSetting(db: Database, key: string, value: unknown): void {
  db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

/** Stored settings over the defaults. Invalid stored values fall back to defaults, except an invalid update window stays closed. */
export function getTeamSettings(db: Database): TeamSettingsT {
  const out = { ...DEFAULT_SETTINGS, timeZone: defaultTimeZone() } as Record<string, unknown>
  const rows = db.query(`SELECT key, value FROM settings WHERE key IN (${FIELDS.map(() => '?').join(',')})`).all(...FIELDS) as { key: string; value: string }[]
  for (const r of rows) {
    let v: unknown
    try { v = JSON.parse(r.value) } catch {}
    const field = TeamSettings.shape[r.key as keyof TeamSettingsT]
    if (field && field.safeParse(v).success) out[r.key] = v
    // Do not turn an invalid old window into null: null permits the default 03:00-05:00 window.
    // Equal endpoints keep updates closed and let the admin read, replace or clear the setting.
    else if (r.key === 'updateWindow') out[r.key] = '00:00-00:00'
  }
  // not chosen: voice input goes through OpenRouter once there is a key for it, the hosting service's (a hosted team, its plan's
  // free hours a month) or the team's own (a team's own server: saving the key turns it on, removing it turns it off).
  // Nothing is stored for it, and an admin's choice, "off" too, always wins
  if (!rows.some((r) => r.key === 'speechProvider') && db.query('SELECT 1 FROM settings WHERE key IN (?, ?)').get(HOSTED_SPEECH_KEY_SETTING, SPEECH_KEY_SETTING)) out.speechProvider = 'openrouter'
  return out as TeamSettingsT
}

export function updateTeamSettings(db: Database, patch: Partial<TeamSettingsT>): TeamSettingsT {
  tzCache.delete(db)
  // "Turn video sound into text" was chosen for one speech provider: another provider starts from its own default again
  // (the admin agreed to sound going to this server, not to OpenRouter)
  if (patch.speechProvider !== undefined && patch.aiMediaTranscripts === undefined && patch.speechProvider !== getTeamSettings(db).speechProvider)
    patch = { ...patch, aiMediaTranscripts: null }
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

/**
 * Realtime notice: the team changed whether people may turn on "Allow all websites" (browserAllowAll). Open windows
 * ask GET /api/me again; inside the desktop app the page also reads Settings > Browser again, which makes the app
 * re-read the policy from the team server itself (the app never takes the value from the page; it also re-reads it
 * every minute). The message carries nothing.
 */
export const BROWSER_POLICY_CHANGED = { type: 'notice', data: { level: 'info', code: 'browser_policy_changed', message: '' } } as const

/**
 * Realtime notice: voice input was turned on or off (speechProvider, the OpenRouter key). Open windows ask GET /api/me
 * again (Me.team.voiceInput) and show or hide the mic. The message carries nothing.
 */
export const SPEECH_CHANGED = { type: 'notice', data: { level: 'info', code: 'speech_changed', message: '' } } as const

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
  return { 'claude-code': v['claude-code'] ?? true, codex: v.codex ?? true, api: v.api ?? true }
}
export function setEnginesEnabled(db: Database, patch: Partial<Record<EngineId, boolean>>) {
  setSetting(db, 'engines.enabled', { ...enginesEnabled(db), ...patch })
}

// ---------------- the team's time zone ----------------
const tzCache = new WeakMap<Database, { at: number; v: string }>()
/** The team's time zone (setting timeZone, else system/time-zone.ts defaultTimeZone()). Cached for 60 s per database;
 * updateTeamSettings() drops the cache, so a change applies at once in this process. */
export function teamTimeZone(db: Database): string {
  const c = tzCache.get(db)
  if (c && Date.now() - c.at < 60_000) return c.v
  let v = getSetting<unknown>(db, 'timeZone')
  if (!isValidTimeZone(v)) v = defaultTimeZone()
  tzCache.set(db, { at: Date.now(), v: v as string })
  return v as string
}

/** The install's id: MYCEL_INSTALL_ID (the hosted cloud: the control plane's tenant id), else a random id made on first
 * use and kept in the settings table. Spreads the nightly backup, update roll-outs and the first search indexing of
 * the teams on one host (system/ops.ts, system/update-job.ts, tools/search.ts). */
export function installId(db: Database, env: Record<string, string | undefined> = process.env): string {
  const have = existingInstallId(db, env)
  if (have) return have
  const id = crypto.randomUUID()
  db.query("INSERT INTO settings (key, value) VALUES ('system.installId', ?) ON CONFLICT(key) DO NOTHING").run(JSON.stringify(id))
  return getSetting<string>(db, 'system.installId') ?? id
}

/** installId without making one (a read-only database: admin.js update-window for the root update timer's staged
 * roll-out, system/rollout.ts); null when the install has none yet. */
export function existingInstallId(db: Database, env: Record<string, string | undefined> = process.env): string | null {
  const e = env.MYCEL_INSTALL_ID
  if (e && /^[A-Za-z0-9._-]{1,128}$/.test(e)) return e
  const v = getSetting<unknown>(db, 'system.installId')
  return typeof v === 'string' && v ? v : null
}
