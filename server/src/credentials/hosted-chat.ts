// The hosting service's trial AI credit (docs/DECISIONS.md "Z — trial credit on the API engine", which replaces the
// Claude Code parts of "B — Hosted trial AI credit"): during a hosted trial the team's chats are answered before anyone
// connects an AI. The control plane makes one OpenRouter API key per trial team (like the hosted speech key) and hands
// it over with mycel-ctl hosted-chat-key-set (admin.js hosted-chat-key) together with a dollar cap, an end time and a
// switch. It is stored like the hosting speech key (credentials/speech-key.ts): encrypted with the credentials vault in
// one settings row (AAD "mycel-cred-v1|ai.hostedChat|openrouter-api-key"), never in a response, log line or audit row,
// not even its last characters; credentials-rekey encrypts it again; a server that is not hosted drops it at start; the
// team's export leaves it out and a restore keeps the current one (system/backup.ts).
//
// It never runs Claude Code. Anthropic's terms for products that run Claude Code ("Customers may not pay for, resell,
// or intermediate Claude usage on their end users' behalf") rule out a key the hosting service pays for in a Claude
// Code launch, so trial answers come from the app's own agent loop (engine/api-agent.ts, the API engine) on one fixed
// model through OpenRouter's OpenAI-compatible API. It is not a row of engine_credentials and no resolver offers it
// (credentials/resolve.ts knows nothing of it): chat/turn.ts runs a Claude Code or Codex turn on it only when no AI
// connection of the person works on either engine (credentials/access.ts connectionRoute), so any connection the team
// or the person adds always comes first.
//
// Metering: the team server counts what the key spent itself, in dollars (OpenRouter's own `usage.cost` of each answer,
// else the list price in credentials/prices.ts), in one settings row (no text, no key). Before each completion is sent
// (createTrialMeter) the credit must be active, and the most that completion can cost (its body as input, max_tokens as
// output) is held until its answer is counted (then it costs what it cost) or did not come (given back): a completion is
// admitted only while what was spent and what is held stay under the cap, so all the turns together pass the cap by at
// most the last completion admitted (as long as its input has at most one token per TRIAL_BYTES_PER_TOKEN bytes). An answer that started and broke off counts its whole reservation. OpenRouter's
// own limit on the key is the backstop: its refusal reads as a used credit.
import type { Database } from 'bun:sqlite'
import { TRIAL_CREDENTIAL_ID, type TrialCredit } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { getSetting, HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_USAGE_SETTING, setSetting } from '../admin/settings'
import { openRouterUpstream, type AppConfig } from '../app-config'
import type { ApiEngineConf, ApiMeter } from '../engine/api-agent'
import { claudeCost } from './prices'
import { VaultError, type Vault } from './vault'
import type { CredCtx } from './store'

export { HOSTED_CHAT_KEY_SETTING, HOSTED_CHAT_USAGE_SETTING }
/** the credential id of a trial answer (turns.credential_id; Admin › Usage by connection): not a UUID, so no row of
 * engine_credentials ever has it, and the model proxy refuses it like any id without a row */
export const HOSTED_CHAT_ID = TRIAL_CREDENTIAL_ID
/** The one model trial answers run on: OpenRouter's id of Claude Haiku 5.5 (listed by GET
 * https://openrouter.ai/api/v1/models on 2026-11-04 at $0.10 / $0.50 per million tokens). Chosen for cost (DECISIONS B). */
export const HOSTED_CHAT_MODEL = 'anthropic/claude-haiku-5.5'
/** how the answer names it */
export const HOSTED_CHAT_LABEL = 'Claude Haiku 5.5'
/** the same model in the price table (credentials/prices.ts), for the reservation */
const PRICE_MODEL = 'claude-haiku-5-5'
/** max_tokens of every trial completion (thinking included): bounds what one completion can cost (about $0.04 of
 * output at the long-context price) and is far above a long answer */
export const HOSTED_CHAT_MAX_TOKENS = 16_000
const VAULT_ID = 'ai.hostedChat'
const KIND = 'openrouter-api-key'

interface Stored {
  enc: string; keyVersion: number; capUsd: number; endsAt: string; enabled: boolean; updatedAt: string
  /** what the key is for; a row without it holds a key of the never-released first version (a direct Anthropic key for
   * Claude Code) and counts as none */
  kind: typeof KIND
  /** OpenRouter refused the key (401): no request goes out with it until the hosting service sends a key again */
  refusedAt?: string | null
}
export type HostedChatState = TrialCredit['state']
export interface HostedChatGrant { key: string; capUsd: number; endsAt: string; enabled: boolean }

function stored(db: Database): Stored | null {
  const v = getSetting<Stored>(db, HOSTED_CHAT_KEY_SETTING)
  return v && v.kind === KIND && typeof v.enc === 'string' && typeof v.keyVersion === 'number' && typeof v.capUsd === 'number' && Number.isFinite(v.capUsd)
    && typeof v.endsAt === 'string' && !Number.isNaN(Date.parse(v.endsAt)) && typeof v.enabled === 'boolean' ? v : null
}

/** Dollars spent with the hosting key so far (a broken row counts as nothing). */
export function hostedChatUsedUsd(db: Database): number {
  const v = getSetting<{ usd?: unknown }>(db, HOSTED_CHAT_USAGE_SETTING)
  return v && typeof v.usd === 'number' && Number.isFinite(v.usd) && v.usd > 0 ? v.usd : 0
}

/** The trial credit now; null without a key. */
export function hostedChatState(db: Database, now: Date): HostedChatState | null {
  const s = stored(db)
  if (!s) return null
  if (!s.enabled || s.refusedAt || Date.parse(s.endsAt) <= now.getTime()) return 'ended'
  return hostedChatUsedUsd(db) >= s.capUsd ? 'used' : 'active'
}

/** The API engine's setup for a trial answer (engine/api-agent.ts): OpenRouter (engine.modelUpstreams.openrouter in
 * tests), the trial model. No key: the meter gives it for each completion (read again, so a rotated key is used at once). */
export function hostedChatConf(config: Pick<AppConfig, 'engine'>): ApiEngineConf {
  return { baseUrl: openRouterUpstream(config), model: HOSTED_CHAT_MODEL, label: HOSTED_CHAT_LABEL, key: null }
}

// ---------------- requests in flight ----------------

/** Bytes of a request body counted as one input token in the reservation. English JSON is about 4 bytes a token and a
 * Hangul syllable 3 bytes (UTF-8) for about one token, so 2 leaves room for text that tokenizes worse; it also decides
 * the long-context price (above 100,000 input tokens), which Korean text could otherwise reach unseen. */
export const TRIAL_BYTES_PER_TOKEN = 2
/** What a trial completion may cost at most: its body's bytes as input tokens (TRIAL_BYTES_PER_TOKEN) and its max_tokens
 * as output (thinking included). */
export interface TrialEstimate { inputTokens: number; maxTokens: number }
export function trialEstimate(bodyBytes: number, maxTokens: number): TrialEstimate {
  return { inputTokens: Math.ceil(Math.max(0, bodyBytes) / TRIAL_BYTES_PER_TOKEN), maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(Math.ceil(maxTokens), 1_000_000) : 64_000 }
}
/** that estimate in dollars: all input at the 1-hour cache-write price (the dearest input column), the trial model's
 * long-context price above 100,000 input tokens */
export const trialEstimateUsd = (e: TrialEstimate): number =>
  claudeCost(PRICE_MODEL, { cache_creation: { ephemeral_1h_input_tokens: e.inputTokens }, output_tokens: e.maxTokens })

/** dollars held by trial completions in flight, per database (one server process; a restart drops them with the
 * requests) */
const held = new WeakMap<Database, { usd: number; n: number }>()
const heldOf = (db: Database) => { let h = held.get(db); if (!h) held.set(db, h = { usd: 0, n: 0 }); return h }
export const hostedChatHeldUsd = (db: Database): number => held.get(db)?.usd ?? 0
/** one completion's hold, settled once (record or release) */
export interface TrialHold { usd: number; estimate: TrialEstimate; done: boolean }

/** Just before a trial completion is sent: null (refuse it as used) when what was spent and what is held already reach
 * the cap, else its estimate is held. One synchronous step, so completions sent at the same moment cannot all pass the
 * last dollars. */
export function holdHostedChat(db: Database, est: TrialEstimate): TrialHold | null {
  const s = stored(db)
  const h = heldOf(db)
  if (!s || hostedChatUsedUsd(db) + h.usd >= s.capUsd) return null
  const usd = trialEstimateUsd(est)
  h.usd += usd
  h.n++
  return { usd, estimate: est, done: false }
}
/** the answer was counted: the hold goes, what it cost is charged */
export function settleHostedChat(db: Database, hold: TrialHold | null | undefined, costUsd: number): void {
  releaseHostedChat(db, hold)
  chargeHostedChat(db, costUsd)
}
/** no answer to count (refused, failed, nothing came): the hold goes back */
export function releaseHostedChat(db: Database, hold: TrialHold | null | undefined): void {
  if (!hold || hold.done) return
  hold.done = true
  const h = heldOf(db)
  h.n = Math.max(0, h.n - 1)
  // the last one back: exactly nothing held (sums of fractions of a cent leave a rounding rest)
  h.usd = h.n ? Math.max(0, h.usd - hold.usd) : 0
}

/** Dollars left of the cap (0 when used up or there is no key). */
export function hostedChatLeftUsd(db: Database): number {
  const s = stored(db)
  return s ? Math.max(0, s.capUsd - hostedChatUsedUsd(db)) : 0
}

/** OpenRouter's refusal of a request over a limit, i.e. the hosting service's backstop on the key tripped: 402
 * (insufficient credits on the account or the key), or a 403 for the key's own limit (error.metadata.limit_source
 * `openrouter_key_limit`, "…$X of $Y used; resets …"). `body` is the error answer, or the `error` object of a stream. */
export function isOpenRouterLimitError(status: number, body: string): boolean {
  if (status === 402) return true
  if (status !== 403 && status !== 429 && status !== 0) return false
  let e: { message?: unknown; code?: unknown; metadata?: { limit_source?: unknown } } | undefined
  try {
    const j = JSON.parse(body) as { error?: typeof e } & NonNullable<typeof e>
    e = j && typeof j === 'object' ? j.error ?? j : undefined
  } catch { return /insufficient credits|key limit/i.test(body) }
  if (status === 0 && e?.code === 402) return true
  if (typeof e?.metadata?.limit_source === 'string' && /key_limit/i.test(e.metadata.limit_source)) return true
  return typeof e?.message === 'string' && /insufficient credits|key limit|credit limit|of \$[\d.,]+ used/i.test(e.message)
}

/**
 * Spend control of one trial answer (engine/api-agent.ts runApiAgent's meter): before each completion the credit must
 * be active and the completion's reservation fit under the cap; after it, what it cost is counted. `onStop` hears why
 * the answer stops on the credit ('used': the cap, the holds of other answers or OpenRouter's limit on the key;
 * 'ended': past its end, switched off, taken away or the key refused); the turn turns that into its error.
 */
export function createTrialMeter(cc: Pick<CredCtx, 'db' | 'vault' | 'now' | 'log'>, onStop: (reason: 'used' | 'ended') => void): ApiMeter {
  let hold: TrialHold | null = null
  return {
    start({ bodyBytes, maxTokens }) {
      const state = hostedChatState(cc.db, new Date(cc.now()))
      if (state !== 'active') { onStop(state === 'used' ? 'used' : 'ended'); return null }
      const key = readHostedChatKey(cc)
      if (!key) { onStop('ended'); return null }
      hold = holdHostedChat(cc.db, trialEstimate(bodyBytes, maxTokens))
      if (!hold) { onStop('used'); return null }
      return { key }
    },
    end(cost) {
      const h = hold
      hold = null
      if (cost === 'none') releaseHostedChat(cc.db, h)
      // an answer that started but whose usage never came (stopped, broken off): what it generated is not known
      else settleHostedChat(cc.db, h, cost === 'unfinished' ? h?.usd ?? 0 : cost)
    },
    refused(status, body, sentKey) {
      if (status === 401) {
        // OpenRouter refused the hosting service's key (deleted, disabled): no completion goes out with it until a new
        // one comes. A late 401 for a key the hosting service has replaced since (rotation) leaves the new one alone.
        if (markHostedChatRefused(cc, sentKey, new Date(cc.now()))) {
          audit(cc.db, { actor: null, action: 'credential.rejected', target: HOSTED_CHAT_ID, detail: { kind: KIND, upstreamStatus: 401, newStatus: 'invalid' } })
          cc.log.warn('the hosting service\'s trial AI key was refused by its provider', { credential: HOSTED_CHAT_ID })
        }
        onStop('ended')
        return true
      }
      if (isOpenRouterLimitError(status, body)) { onStop('used'); return true }
      return false
    },
  }
}

const usd4 = (n: number) => Math.round(n * 1e4) / 1e4
/** What the owner and admins see (GET /api/admin/trial-credit, Admin › AI connections); null without a key. */
export function trialCredit(db: Database, now: Date): TrialCredit | null {
  const s = stored(db)
  const state = hostedChatState(db, now)
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
      updatedAt: new Date(cc.now()).toISOString(), kind: KIND, refusedAt: null,
    } satisfies Stored)
  }
  return { set: stored(cc.db) !== null, usedUsd: usd4(hostedChatUsedUsd(cc.db)) }
}

/** A server that is not hosted keeps no hosting key (main.ts at start). Returns whether one was removed. */
export function dropHostedChatKey(db: Database): boolean {
  return db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_CHAT_KEY_SETTING).changes > 0
}

/** OpenRouter refused `sentKey` (401: deleted or disabled by the hosting service): when it is still the stored key, the
 * trial is over on this server until the hosting service sends a key again. One statement on that very row, so a key
 * set in the meantime is never marked. Returns whether this changed anything. */
export function markHostedChatRefused(cc: Pick<CredCtx, 'db' | 'vault'>, sentKey: string, now: Date): boolean {
  const s = stored(cc.db)
  if (!s || s.refusedAt || readHostedChatKey(cc) !== sentKey) return false
  return cc.db.query(`UPDATE settings SET value = json_set(value, '$.refusedAt', ?1)
    WHERE key = ?2 AND json_valid(value) AND json_extract(value, '$.enc') = ?3 AND json_extract(value, '$.refusedAt') IS NULL`)
    .run(now.toISOString(), HOSTED_CHAT_KEY_SETTING, s.enc).changes > 0
}

/** The key in clear for one completion; null without one or when it no longer decrypts (key file lost). */
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
