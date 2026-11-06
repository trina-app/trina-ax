// The team's OpenRouter API key for voice input (docs/DECISIONS.md "Voice input through OpenRouter"). Stored like the
// AI connections' secrets: encrypted with the credentials vault (AES-256-GCM, AAD "mycel-cred-v1|speech.openrouter|
// openrouter-api-key", vault.ts), in the settings table under an internal dot key that GET /api/admin/settings never
// returns. It arrives sealed in the browser (purpose 'speech.key', seal.ts) and no response, log line or audit entry
// holds it: only "set" and the last 4 characters. credentials-rekey (rekey.ts) encrypts it again with the new key.
//
// A hosted server may also hold the hosting service's key (docs/DECISIONS.md "Hosted speech-to-text"): the control
// plane makes one OpenRouter key per team and hands it over with mycel-ctl hosted-speech-key-set (admin.js
// hosted-speech-key). It is stored the same way under its own id (AAD "...|speech.hosted|openrouter-api-key") and is
// never shown, not even its last characters. A key the team entered itself always comes first; the hosting key is used
// only without one, and only for the free hours (credentials/hosted-speech.ts). A server that is not hosted drops it at
// start (a hosted team's backup restored on the team's own server must not keep using the hosting service's key).
import type { Database } from 'bun:sqlite'
import type { SpeechKeyStatus } from '@mycel/shared/api'
import { getSetting, getTeamSettings, HOSTED_SPEECH_KEY_SETTING, setSetting } from '../admin/settings'
import { VaultError, type Vault } from './vault'
import type { CredCtx } from './store'
import { hostedSpeechUsage } from './hosted-speech'

export const SPEECH_KEY_SETTING = 'speech.openrouterKey'
export { HOSTED_SPEECH_KEY_SETTING }
const ID = 'speech.openrouter'
const HOSTED_ID = 'speech.hosted'
const KIND = 'openrouter-api-key'

interface Stored { enc: string; keyVersion: number; hint: string; updatedAt: string }
interface StoredHosted { enc: string; keyVersion: number; updatedAt: string }

const stored = (db: Database): Stored | null => {
  const v = getSetting<Stored>(db, SPEECH_KEY_SETTING)
  return v && typeof v.enc === 'string' && typeof v.keyVersion === 'number' ? v : null
}
const storedHosted = (db: Database): StoredHosted | null => {
  const v = getSetting<StoredHosted>(db, HOSTED_SPEECH_KEY_SETTING)
  return v && typeof v.enc === 'string' && typeof v.keyVersion === 'number' ? v : null
}

/** The team's own key (last 4 characters only) and, on a hosted server with the hosting key, this month's free hours. */
export function speechKeyStatus(db: Database, now = Date.now()): SpeechKeyStatus {
  const s = stored(db)
  const hosted = storedHosted(db) ? hostedSpeechUsage(db, now) : null
  return s ? { set: true, hint: s.hint, updatedAt: s.updatedAt, hosted } : { set: false, hint: null, updatedAt: null, hosted }
}

/** Store (encrypted) or remove (null) the key. */
export function writeSpeechKey(cc: Pick<CredCtx, 'db' | 'vault' | 'now'>, key: string | null): SpeechKeyStatus {
  if (key === null) cc.db.query('DELETE FROM settings WHERE key = ?').run(SPEECH_KEY_SETTING)
  else {
    const { enc, keyVersion } = cc.vault.encrypt(ID, KIND, { key })
    setSetting(cc.db, SPEECH_KEY_SETTING, { enc, keyVersion, hint: key.slice(-4), updatedAt: new Date(cc.now()).toISOString() } satisfies Stored)
  }
  return speechKeyStatus(cc.db, cc.now())
}

/** Store (encrypted) or remove (null) the hosting service's key. Returns whether one is stored now. */
export function writeHostedSpeechKey(cc: Pick<CredCtx, 'db' | 'vault' | 'now'>, key: string | null): boolean {
  if (key === null) cc.db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_SPEECH_KEY_SETTING)
  else {
    const { enc, keyVersion } = cc.vault.encrypt(HOSTED_ID, KIND, { key })
    setSetting(cc.db, HOSTED_SPEECH_KEY_SETTING, { enc, keyVersion, updatedAt: new Date(cc.now()).toISOString() } satisfies StoredHosted)
  }
  return storedHosted(cc.db) !== null
}

/** A server that is not hosted keeps no hosting key (main.ts at start). Returns whether one was removed. */
export function dropHostedSpeechKey(db: Database): boolean {
  return db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_SPEECH_KEY_SETTING).changes > 0
}

const open = (cc: Pick<CredCtx, 'vault'>, id: string, s: { enc: string; keyVersion: number } | null): string | null => {
  if (!s) return null
  try {
    const v = cc.vault.decrypt(id, KIND, s.enc, s.keyVersion) as { key?: unknown }
    return typeof v?.key === 'string' && v.key ? v.key : null
  } catch (e) {
    if (e instanceof VaultError) return null
    throw e
  }
}

/** Whose key a speech request uses now: the team's own (no limit), else the hosting service's (the free hours). A team
 * key that no longer decrypts still counts as the team's (enter it again), so the free hours are never used silently. */
export function speechKeySource(db: Database): 'team' | 'hosted' | null {
  return stored(db) ? 'team' : storedHosted(db) ? 'hosted' : null
}

/** The key in clear for one request: the team's own, else the hosting service's; null when none is set or it no longer
 * decrypts (key file lost: enter it again). */
export function readSpeechKey(cc: Pick<CredCtx, 'db' | 'vault'>): string | null {
  const source = speechKeySource(cc.db)
  return source === 'team' ? open(cc, ID, stored(cc.db)) : source === 'hosted' ? open(cc, HOSTED_ID, storedHosted(cc.db)) : null
}

/** The hosting service's key in clear (the free-hours meter compares a request's key with it); null without one. */
export function readHostedSpeechKey(cc: Pick<CredCtx, 'db' | 'vault'>): string | null {
  return open(cc, HOSTED_ID, storedHosted(cc.db))
}

/** credentials-rekey: encrypt both keys again under `next`. Returns the key versions the stored values need afterwards
 * (none stored: empty), so the rekey keeps those key files. */
export function rekeySpeechKey(db: Database, from: Vault, next: Vault): { versions: number[]; write: () => void } {
  const versions: number[] = []
  const writes: (() => void)[] = []
  for (const [setting, id, s] of [[SPEECH_KEY_SETTING, ID, stored(db)], [HOSTED_SPEECH_KEY_SETTING, HOSTED_ID, storedHosted(db)]] as const) {
    if (!s) continue
    let value: unknown
    try { value = from.decrypt(id, KIND, s.enc, s.keyVersion) } catch { versions.push(s.keyVersion); continue }
    const { enc, keyVersion } = next.encrypt(id, KIND, value)
    versions.push(keyVersion)
    writes.push(() => setSetting(db, setting, { ...s, enc, keyVersion }))
  }
  return { versions, write: () => { for (const w of writes) w() } }
}

/** Voice input goes to an outside service now (OpenRouter with a key): the composer says at once that it is not used
 * in a confidential chat (Me.team.voiceInputOutside; the server refuses it there either way). */
export function voiceInputOutside(db: Database): boolean {
  return getTeamSettings(db).speechProvider === 'openrouter' && speechKeySource(db) !== null
}
/** Voice input works now: on this server, or OpenRouter with the team's key or the hosting service's. */
export function voiceInputOn(db: Database): boolean {
  const p = getTeamSettings(db).speechProvider
  return p === 'local' || (p === 'openrouter' && speechKeySource(db) !== null)
}
