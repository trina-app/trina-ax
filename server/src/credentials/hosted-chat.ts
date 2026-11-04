// The hosting service's trial AI credit (docs/DECISIONS.md "B — Hosted trial AI credit"): during a hosted trial the
// team's chats are answered before anyone connects an AI. The control plane makes one direct Anthropic API key per
// trial team and hands it over with mycel-ctl hosted-chat-key-set (admin.js hosted-chat-key) together with a dollar cap,
// an end time and a switch. It is stored like the hosting speech key (credentials/speech-key.ts): encrypted with the
// credentials vault in one settings row (AAD "mycel-cred-v1|ai.hostedChat|anthropic-api-key"), never in a response,
// log line or audit row, not even its last characters; credentials-rekey encrypts it again; a server that is not hosted
// drops it at start; the team's export leaves it out and a restore keeps the current one (system/backup.ts).
//
// It is not a row of engine_credentials: it never shows as a connection and nobody on the team can change it. The
// resolver offers it LAST (credentials/resolve.ts): any connection the team or the person adds always comes first. A
// turn that gets it runs on the same path as an Anthropic API key connection (proxy token bound to HOSTED_CHAT_ID, the
// broker puts the key on the request as x-api-key), on one fixed model (HOSTED_CHAT_MODEL, the proxy forwards no other).
//
// Metering: the team server counts what the key spent itself, in dollars at list price (credentials/prices.ts), in one
// settings row (no text, no key). The broker refuses a request before it is sent once the cap is used, the end time
// passed or the switch is off, and each attempt's proxy token carries the dollars left as its budget (proxy_tokens.
// budget_usd), so a turn cannot spend past the cap by more than its requests in flight (an answer is counted when it
// ends; sub-agents of one turn may have a few out at once).
import type { Database } from 'bun:sqlite'
import { TRIAL_CREDENTIAL_ID, type TrialCredit } from '@mycel/shared/api'
import { getSetting, HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_USAGE_SETTING, setSetting } from '../admin/settings'
import type { AllowedKinds } from '../app-config'
import { VaultError, type Vault } from './vault'
import type { CredCtx } from './store'

export { HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_USAGE_SETTING }
/** the credential id of a trial attempt (proxy_tokens.credential_id, turns.credential_id): not a UUID, so no row of
 * engine_credentials ever has it */
export const HOSTED_CHAT_ID = TRIAL_CREDENTIAL_ID
/** The one model trial answers run on (the engine's aliases and side requests too; the proxy forwards no other).
 * Chosen for cost: Claude Haiku 5.5 is $0.10 / $0.50 per million tokens, a twentieth of Sonnet 5.5 (DECISIONS). */
export const HOSTED_CHAT_MODEL = 'claude-haiku-5-5'
const VAULT_ID = 'ai.hostedChat'
const KIND = 'anthropic-api-key'

interface Stored {
  enc: string; keyVersion: number; capUsd: number; endsAt: string; enabled: boolean; updatedAt: string
  /** Anthropic refused the key (401): no request goes out with it until the hosting service sends a key again */
  refusedAt?: string | null
}
export type HostedChatState = TrialCredit['state']
export interface HostedChatGrant { key: string; capUsd: number; endsAt: string; enabled: boolean }

function stored(db: Database): Stored | null {
  const v = getSetting<Stored>(db, HOSTED_CHAT_KEY_SETTING)
  return v && typeof v.enc === 'string' && typeof v.keyVersion === 'number' && typeof v.capUsd === 'number' && Number.isFinite(v.capUsd)
    && typeof v.endsAt === 'string' && !Number.isNaN(Date.parse(v.endsAt)) && typeof v.enabled === 'boolean' ? v : null
}

/** Dollars spent with the hosting key so far (a broken row counts as nothing). */
export function hostedChatUsedUsd(db: Database): number {
  const v = getSetting<{ usd?: unknown }>(db, HOSTED_CHAT_USAGE_SETTING)
  return v && typeof v.usd === 'number' && Number.isFinite(v.usd) && v.usd > 0 ? v.usd : 0
}

/** The trial credit now: null without a key, or while Claude requests go to an Anthropic-compatible gateway (a direct
 * Anthropic key is never sent there; `allowed` is the server's allowedCredentialKinds, which names the gateway). */
export function hostedChatState(db: Database, now: Date, allowed?: AllowedKinds): HostedChatState | null {
  const s = stored(db)
  if (!s || allowed?.gateway) return null
  if (!s.enabled || s.refusedAt || Date.parse(s.endsAt) <= now.getTime()) return 'ended'
  return hostedChatUsedUsd(db) >= s.capUsd ? 'used' : 'active'
}

/** Dollars left of the cap (0 when used up or there is no key). */
export function hostedChatLeftUsd(db: Database): number {
  const s = stored(db)
  return s ? Math.max(0, s.capUsd - hostedChatUsedUsd(db)) : 0
}

const usd4 = (n: number) => Math.round(n * 1e4) / 1e4
/** What the owner and admins see (GET /api/admin/trial-credit, Admin › AI connections); null without a key. */
export function trialCredit(db: Database, now: Date, allowed?: AllowedKinds): TrialCredit | null {
  const s = stored(db)
  const state = hostedChatState(db, now, allowed)
  if (!s || !state) return null
  return { active: state === 'active', state, usedUsd: usd4(hostedChatUsedUsd(db)), capUsd: s.capUsd, endsAt: new Date(s.endsAt).toISOString(), model: HOSTED_CHAT_MODEL }
}

/** Count `usd` spent with the hosting key, in one statement (answers of several turns end at once). */
export function chargeHostedChat(db: Database, usd: number): void {
  const add = Number.isFinite(usd) && usd > 0 ? usd : 0
  if (!add) return
  db.query(`INSERT INTO settings (key, value) VALUES (?1, json_object('usd', ?2))
    ON CONFLICT(key) DO UPDATE SET value = json_object('usd', CASE
      WHEN json_valid(value) AND typeof(json_extract(value, '$.usd')) IN ('integer', 'real') AND json_extract(value, '$.usd') > 0
      THEN json_extract(value, '$.usd') + ?2 ELSE ?2 END)`).run(HOSTED_CHAT_USAGE_SETTING, add)
}

/** Store (encrypted) or remove (null) the hosting service's trial key with its cap, end and switch. A new grant clears
 * an earlier refusal (the hosting service says this key works). The dollars spent stay: the cap is for the whole trial,
 * across key rotations. Returns whether a key is stored now and what was spent. */
export function writeHostedChatKey(cc: Pick<CredCtx, 'db' | 'vault' | 'now'>, grant: HostedChatGrant | null): { set: boolean; usedUsd: number } {
  if (grant === null) cc.db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_CHAT_KEY_SETTING)
  else {
    const { enc, keyVersion } = cc.vault.encrypt(VAULT_ID, KIND, { key: grant.key })
    setSetting(cc.db, HOSTED_CHAT_KEY_SETTING, {
      enc, keyVersion, capUsd: grant.capUsd, endsAt: new Date(grant.endsAt).toISOString(), enabled: grant.enabled,
      updatedAt: new Date(cc.now()).toISOString(), refusedAt: null,
    } satisfies Stored)
  }
  return { set: stored(cc.db) !== null, usedUsd: usd4(hostedChatUsedUsd(cc.db)) }
}

/** A server that is not hosted keeps no hosting key (main.ts at start). Returns whether one was removed. */
export function dropHostedChatKey(db: Database): boolean {
  return db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_CHAT_KEY_SETTING).changes > 0
}

/** Anthropic refused `sentKey` (401: taken away at Anthropic, the trial's workspace switched off): when it is still the
 * stored key, the trial is over on this server until the hosting service sends a key again. One statement on that very
 * row, so a key set in the meantime is never marked. Returns whether this changed anything. */
export function markHostedChatRefused(cc: Pick<CredCtx, 'db' | 'vault'>, sentKey: string, now: Date): boolean {
  const s = stored(cc.db)
  if (!s || s.refusedAt || readHostedChatKey(cc) !== sentKey) return false
  return cc.db.query(`UPDATE settings SET value = json_set(value, '$.refusedAt', ?1)
    WHERE key = ?2 AND json_valid(value) AND json_extract(value, '$.enc') = ?3 AND json_extract(value, '$.refusedAt') IS NULL`)
    .run(now.toISOString(), HOSTED_CHAT_KEY_SETTING, s.enc).changes > 0
}

/** The key in clear for one request; null without one or when it no longer decrypts (key file lost). */
export function readHostedChatKey(cc: Pick<CredCtx, 'db' | 'vault'>): string | null {
  const s = stored(cc.db)
  if (!s) return null
  try {
    const v = cc.vault.decrypt(VAULT_ID, KIND, s.enc, s.keyVersion) as { key?: unknown }
    return typeof v?.key === 'string' && v.key ? v.key : null
  } catch (e) {
    if (e instanceof VaultError) return null
    throw e
  }
}

/** credentials-rekey: encrypt the key again under `next`. Returns the key version the stored value needs afterwards
 * (none stored: empty), so the rekey keeps that key file. */
export function rekeyHostedChatKey(db: Database, from: Vault, next: Vault): { versions: number[]; write: () => void } {
  const s = stored(db)
  if (!s) return { versions: [], write: () => {} }
  let value: unknown
  try { value = from.decrypt(VAULT_ID, KIND, s.enc, s.keyVersion) } catch { return { versions: [s.keyVersion], write: () => {} } }
  const { enc, keyVersion } = next.encrypt(VAULT_ID, KIND, value)
  return { versions: [keyVersion], write: () => setSetting(db, HOSTED_CHAT_KEY_SETTING, { ...s, enc, keyVersion }) }
}
