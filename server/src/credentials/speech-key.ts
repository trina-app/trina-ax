// The team's OpenRouter API key for voice input (docs/DECISIONS.md "Voice input through OpenRouter"). Stored like the
// AI connections' secrets: encrypted with the credentials vault (AES-256-GCM, AAD "mycel-cred-v1|speech.openrouter|
// openrouter-api-key", vault.ts), in the settings table under an internal dot key that GET /api/admin/settings never
// returns. It arrives sealed in the browser (purpose 'speech.key', seal.ts) and no response, log line or audit entry
// holds it: only "set" and the last 4 characters. credentials-rekey (rekey.ts) encrypts it again with the new key.
import type { Database } from 'bun:sqlite'
import type { SpeechKeyStatus } from '@mycel/shared/api'
import { getSetting, getTeamSettings, setSetting } from '../admin/settings'
import { VaultError, type Vault } from './vault'
import type { CredCtx } from './store'

export const SPEECH_KEY_SETTING = 'speech.openrouterKey'
const ID = 'speech.openrouter'
const KIND = 'openrouter-api-key'

interface Stored { enc: string; keyVersion: number; hint: string; updatedAt: string }

const stored = (db: Database): Stored | null => {
  const v = getSetting<Stored>(db, SPEECH_KEY_SETTING)
  return v && typeof v.enc === 'string' && typeof v.keyVersion === 'number' ? v : null
}

export function speechKeyStatus(db: Database): SpeechKeyStatus {
  const s = stored(db)
  return s ? { set: true, hint: s.hint, updatedAt: s.updatedAt } : { set: false, hint: null, updatedAt: null }
}

/** Store (encrypted) or remove (null) the key. */
export function writeSpeechKey(cc: Pick<CredCtx, 'db' | 'vault' | 'now'>, key: string | null): SpeechKeyStatus {
  if (key === null) cc.db.query('DELETE FROM settings WHERE key = ?').run(SPEECH_KEY_SETTING)
  else {
    const { enc, keyVersion } = cc.vault.encrypt(ID, KIND, { key })
    setSetting(cc.db, SPEECH_KEY_SETTING, { enc, keyVersion, hint: key.slice(-4), updatedAt: new Date(cc.now()).toISOString() } satisfies Stored)
  }
  return speechKeyStatus(cc.db)
}

/** The key in clear for one request; null when none is set or it no longer decrypts (key file lost: enter it again). */
export function readSpeechKey(cc: Pick<CredCtx, 'db' | 'vault'>): string | null {
  const s = stored(cc.db)
  if (!s) return null
  try {
    const v = cc.vault.decrypt(ID, KIND, s.enc, s.keyVersion) as { key?: unknown }
    return typeof v?.key === 'string' && v.key ? v.key : null
  } catch (e) {
    if (e instanceof VaultError) return null
    throw e
  }
}

/** credentials-rekey: encrypt the key again under `next`. Returns the key version the stored value needs afterwards
 * (null = nothing stored), so the rekey keeps that key file. */
export function rekeySpeechKey(db: Database, from: Vault, next: Vault): { version: number | null; write: () => void } {
  const s = stored(db)
  if (!s) return { version: null, write: () => {} }
  let value: unknown
  try { value = from.decrypt(ID, KIND, s.enc, s.keyVersion) } catch { return { version: s.keyVersion, write: () => {} } }
  const { enc, keyVersion } = next.encrypt(ID, KIND, value)
  return { version: keyVersion, write: () => setSetting(db, SPEECH_KEY_SETTING, { ...s, enc, keyVersion }) }
}

/** Voice input works now: on this server, or OpenRouter with a key. */
export function voiceInputOn(db: Database): boolean {
  const p = getTeamSettings(db).speechProvider
  return p === 'local' || (p === 'openrouter' && stored(db) !== null)
}
