// The AI connection pool (engine_credentials, migration 106): rows, their secrets through the vault, what the screen
// shows (state, this month's use), and the notices to the owner and admins. Owner: A. Every function here keeps
// secrets out of return values that leave the server, out of logs and out of audit details (security T5).
import crypto from 'node:crypto'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Credential, CredentialKind, CredentialState, Locale, ServerEventInput } from '@mycel/shared/api'
import { sharedSubscriptionsAllowed } from './policy'
import { allowedCredentialKinds, modelUpstreams, type AllowedKinds, type AppConfig, type ModelUpstreams } from '../app-config'
import { audit } from '../admin/audit'
import type { AppContext } from '../context'
import type { Logger } from '../log'
import { resolveLayout } from '../system/layout'
import { ct, ctAll, fmtDate, fmtTime, type CT } from './i18n'
import { Sealer } from './seal'
import { Vault, VaultError } from './vault'

export interface CredRow {
  id: string; kind: CredentialKind; label: string; owner_user_id: string | null; priority: number; disabled: number
  status: 'ok' | 'invalid' | 'needs_reconnect'; status_code: string | null; secret_enc: string; key_version: number
  fingerprint: string; hint: string | null; meta: string; expires_at: string | null; limited_until: string | null
  spend_limit_usd: number | null; spend_limit_tokens: number | null; spend_limit_action: 'warn' | 'block'
  last_used_at: string | null; checked_at: string | null; created_by: string | null; created_at: string; updated_at: string
}
export const ROW_COLS = 'id, kind, label, owner_user_id, priority, disabled, status, status_code, secret_enc, key_version, fingerprint, hint, meta, expires_at, limited_until, spend_limit_usd, spend_limit_tokens, spend_limit_action, last_used_at, checked_at, created_by, created_at, updated_at'

export interface CredMeta {
  issuedAt?: string; planType?: string | null; accountRef?: string; emailMasked?: string | null; accessExpiresAt?: string | null; lastRefreshAt?: string | null; fedramp?: boolean; from?: string
  /** anthropic-api-key: the host of the Anthropic-compatible gateway (engine.anthropicGateway) the key was made for;
   * absent = an Anthropic key. A key is only ever sent where it was made for (unusable: kind_off elsewhere). */
  gateway?: string
}

/** the secret JSON of each kind (never leaves the server) */
export interface Secrets {
  'anthropic-oauth': { token: string }
  'anthropic-api-key': { key: string }
  'openai-api-key': { key: string }
  chatgpt: { idToken: string; accessToken: string; refreshToken: string; accountId: string; lastRefresh: string | null }
}

export const SUBSCRIPTION = new Set<CredentialKind>(['anthropic-oauth', 'chatgpt'])
/** 429 codes (proxy/codex-path.ts, kept as the connection's status_code with its limited_until) that mean the account is
 * out of credit or over its own spend limit: waiting does not help, someone has to add credit or raise the limit */
const CREDIT_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_usage_limit_exceeded'])
export const isCreditLimit = (code: string | null | undefined) => !!code && (CREDIT_CODES.has(code) || /_spend_limit_exceeded$/.test(code))
export const EXPIRING_MS = 14 * 24 * 3600_000
export const CLAUDE_TOKEN_LIFETIME_MS = 365 * 24 * 3600_000

export interface Notice { level: 'info' | 'warn' | 'error'; code: string; message: Record<Locale, string>; link?: string }

/** What the credential code needs from the server (a narrow piece of AppContext, so tests can build one). */
export interface CredCtx {
  db: Database
  vault: Vault
  sealer: Sealer
  config: Pick<AppConfig, 'engine' | 'mode' | 'dataDir'>
  /** the kinds this server allows, and its Anthropic-compatible gateway (app-config allowedCredentialKinds) */
  allowedKinds: Set<CredentialKind> & { gateway: string | null }
  upstreams: ModelUpstreams
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** send a notice to these people (default: the active owner and admins) */
  notify(n: Notice, to?: string[]): void
  /** one realtime event to one person (ChatGPT sign-in progress) */
  publish(userId: string, ev: ServerEventInput): void
  fetch: typeof fetch
  now(): number
  /** decrypted secrets, re-read when the row's updated_at changes (never logged) */
  cache: Map<string, { updatedAt: string; value: unknown }>
  /** notices sent: `${credentialId}|${code}` -> time (at most one an hour per connection and code) */
  noticed: Map<string, number>
  /** helpers the proxy, the turn and the login share (filled by their modules) */
  extra: Record<string, unknown>
}

export function makeCredCtx(o: {
  db: Database; secretsDir: string; config: CredCtx['config']; log: CredCtx['log']
  notify?: CredCtx['notify']; publish?: CredCtx['publish']; fetch?: typeof fetch; now?: () => number
}): CredCtx {
  return {
    db: o.db, vault: new Vault(o.secretsDir), sealer: new Sealer(o.secretsDir, o.now), config: o.config,
    allowedKinds: allowedCredentialKinds(o.config), upstreams: modelUpstreams(o.config), log: o.log,
    notify: o.notify ?? (() => {}), publish: o.publish ?? (() => {}), fetch: o.fetch ?? fetch, now: o.now ?? Date.now,
    cache: new Map(), noticed: new Map(), extra: {},
  }
}

const ctxs = new WeakMap<AppContext, CredCtx>()
/** The credential context if this server already made one (nothing is created: no keys, no folders). */
export const existingCredentialsOf = (ctx: AppContext): CredCtx | undefined => ctxs.get(ctx)
/** The credential context of a running server (one per AppContext). */
export function credentialsOf(ctx: AppContext): CredCtx {
  let c = ctxs.get(ctx)
  if (!c) {
    c = makeCredCtx({
      db: ctx.db, secretsDir: resolveLayout(ctx.config).secretsDir, config: ctx.config, log: ctx.log.child({ c: 'credentials' }),
      publish: (userId, ev) => { try { ctx.services.realtime.publish(userId, ev) } catch {} },
    })
    c.notify = (n, to) => {
      try {
        const people = to ?? admins(ctx.db)
        const loc = new Map((ctx.db.query(`SELECT id, locale FROM users WHERE id IN (${people.map(() => '?').join(',') || "''"})`).all(...people) as { id: string; locale: Locale | null }[]).map((u) => [u.id, u.locale]))
        for (const id of people) ctx.services.realtime.publish(id, { type: 'notice', data: { level: n.level, code: n.code, message: n.message[loc.get(id) ?? 'en'] ?? n.message.en, ...(n.link ? { link: n.link } : {}) } })
      } catch (e) { ctx.log.warn('could not notify about an AI connection', { err: e }) }
    }
    ctxs.set(ctx, c)
  }
  return c
}

export function admins(db: Database): string[] {
  return (db.query("SELECT id FROM users WHERE role IN ('owner','admin') AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)
}

/** What changed, for the notice (the inbox row's `action`, and the text that goes with it) */
export type ChangeAction = 'added' | 'replaced' | 'removed' | 'disabled' | 'reassigned' | 'zero_limit' | 'shared_on' | 'engine' | 'personal_disabled' | 'personal_removed' | 'personal_login_stopped'
const CHANGE_TEXT: Record<ChangeAction, keyof typeof CT> = {
  added: 'nAdminAdded', replaced: 'nAdminReplaced', removed: 'nAdminRemoved', disabled: 'nAdminDisabled', reassigned: 'nAdminReassigned',
  zero_limit: 'nAdminZeroLimit', shared_on: 'nAdminSharedOn', engine: 'nAdminEngine', personal_disabled: 'nPersonalDisabled', personal_removed: 'nPersonalRemoved', personal_login_stopped: 'nPersonalLoginStopped',
}
/** One change, told to `to`: a live notice now (cc.notify, the channel the connection notices use) and a row in their
 * inbox for when they are away (credential_change_notices). Who and what only; `subject` is a connection's name or the
 * engine's address and model, never a token or key. Never throws. */
function tellChange(cc: CredCtx, to: string[], who: string, action: ChangeAction, subject: string, vars: Record<string, string>, link: string | null) {
  try {
    const at = new Date(cc.now()).toISOString()
    for (const id of to) {
      cc.db.query("INSERT INTO credential_change_notices(id,user_id,event_type,source_id,actor_name,action,subject,created_at,suppressed) VALUES(?,?,?,?,?,?,?,?,0)")
        .run(crypto.randomUUID(), id, 'credential.change', crypto.randomUUID(), who, action, subject.slice(0, 200), at)
      cc.publish(id, { type: 'notice', data: { level: 'info', code: 'notifications.changed', message: '' } })
    }
    cc.notify({ level: 'info', code: 'credential_admin_change', message: ctAll(CHANGE_TEXT[action], { who, label: subject, ...vars }), ...(link ? { link } : {}) }, to)
  } catch (e) { cc.log.warn('could not tell about a change to the AI connections', { err: e }) }
}
/**
 * Someone who is not the owner changed the team's AI (a connection added, replaced, removed, switched off, given to
 * other people or a zero limit; shared subscriptions turned on; the API engine settings): every active owner is told,
 * live and in their inbox. The owner's own changes send nothing. A person who was an admin a moment ago (demoted while
 * a sign-in ran) is not the owner either, so they are told too.
 */
export function noticeOwners(cc: CredCtx, actor: string | null, action: ChangeAction, subject: string, vars: Record<string, string> = {}) {
  try {
    if (!actor) return
    const who = cc.db.query('SELECT name, role FROM users WHERE id = ?').get(actor) as { name: string; role: string } | null
    if (!who || who.role === 'owner') return
    const owners = (cc.db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)
    if (owners.length) tellChange(cc, owners, who.name, action, subject, vars, '/admin/credentials')
  } catch (e) { cc.log.warn('could not tell the owner about a change to the AI connections', { err: e }) }
}
/** The owner or an admin switched off or removed a member's own connection: that member is told (live and in the inbox). */
export function noticeMember(cc: CredCtx, member: string, actor: string, action: 'personal_disabled' | 'personal_removed' | 'personal_login_stopped', label: string) {
  try {
    if (member === actor) return
    const who = (cc.db.query('SELECT name FROM users WHERE id = ?').get(actor) as { name: string } | null)?.name
    if (who) tellChange(cc, [member], who, action, label, {}, '/settings/credentials')
  } catch (e) { cc.log.warn('could not tell a member about a change to their AI connection', { err: e }) }
}

/** notice for one connection and code at most once an hour */
export function notifyOnce(cc: CredCtx, credentialId: string, n: Notice, to?: string[], everyMs = 3600_000) {
  const k = `${credentialId}|${n.code}`
  const last = cc.noticed.get(k) ?? 0
  if (cc.now() - last < everyMs) return
  cc.noticed.set(k, cc.now())
  cc.notify(n, to)
}

export const fingerprintOf = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
/** the value the fingerprint is taken of (the one that identifies the connection) */
export function mainSecret(kind: CredentialKind, v: Secrets[CredentialKind]): string {
  if (kind === 'anthropic-oauth') return (v as Secrets['anthropic-oauth']).token
  if (kind === 'chatgpt') return 'chatgpt-account:' + (v as Secrets['chatgpt']).accountId
  return (v as Secrets['anthropic-api-key']).key
}

export function getRow(db: Database, id: string): CredRow | null {
  return db.query(`SELECT ${ROW_COLS} FROM engine_credentials WHERE id = ?`).get(id) as CredRow | null
}
export function listRows(db: Database): CredRow[] {
  return db.query(`SELECT ${ROW_COLS} FROM engine_credentials ORDER BY owner_user_id IS NOT NULL, priority, created_at, id`).all() as CredRow[]
}
export function metaOf(r: Pick<CredRow, 'meta'>): CredMeta {
  try { const m = JSON.parse(r.meta); return m && typeof m === 'object' ? m : {} } catch { return {} }
}

/** The decrypted secret of a row; null (and the row marked needs_reconnect, audited, admins told) when it does not
 * decrypt: another key, a missing key file, a changed row. */
export function secretOf<K extends CredentialKind>(cc: CredCtx, row: CredRow & { kind: K }): Secrets[K] | null {
  const c = cc.cache.get(row.id)
  if (c && c.updatedAt === row.updated_at) return c.value as Secrets[K]
  try {
    const v = cc.vault.decrypt(row.id, row.kind, row.secret_enc, row.key_version) as Secrets[K]
    cc.cache.set(row.id, { updatedAt: row.updated_at, value: v })
    return v
  } catch (e) {
    if (!(e instanceof VaultError)) throw e
    cc.cache.delete(row.id)
    if (row.status !== 'needs_reconnect' || row.status_code !== 'decrypt_failed') {
      cc.db.query("UPDATE engine_credentials SET status = 'needs_reconnect', status_code = 'decrypt_failed', updated_at = ? WHERE id = ?").run(new Date(cc.now()).toISOString(), row.id)
      audit(cc.db, { actor: null, action: 'credential.decrypt_failed', target: row.id, detail: { keyVersion: row.key_version } })
      cc.log.warn('an AI connection could not be decrypted', { credential: row.id, keyVersion: row.key_version })
      notifyOnce(cc, row.id, { level: 'error', code: 'credential_needs_reconnect', message: ctAll('nNeedsReconnect', { label: row.label }), link: '/admin/credentials' })
    }
    return null
  }
}

/** Encrypt and store a new secret on a row (same transaction as the caller's other changes). */
export function writeSecret(cc: CredCtx, id: string, kind: CredentialKind, value: Secrets[CredentialKind], extra: Partial<Pick<CredRow, 'meta' | 'fingerprint' | 'hint' | 'status' | 'status_code' | 'expires_at' | 'limited_until' | 'checked_at'>> = {}) {
  const { enc, keyVersion } = cc.vault.encrypt(id, kind, value)
  const now = new Date(cc.now()).toISOString()
  const sets = ['secret_enc = ?', 'key_version = ?', 'updated_at = ?']
  const args: (string | number | null)[] = [enc, keyVersion, now]
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); args.push(v as string | null) }
  cc.db.query(`UPDATE engine_credentials SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  cc.cache.set(id, { updatedAt: now, value })
}

// ---------------- time: the server's own time zone (like budgets and usage) ----------------
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export function monthStart(now: Date): Date { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(1); return d }
export function nextMonthStart(now: Date): Date { const d = monthStart(now); d.setMonth(d.getMonth() + 1); return d }

/** this month's use of one connection (server time zone), from the per-request counts */
export function monthUsage(db: Database, id: string, now: Date): { usd: number; tokens: number; requests: number } {
  const r = db.query('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(requests), 0) AS requests FROM credential_usage_daily WHERE credential_id = ? AND day >= ?')
    .get(id, localDay(monthStart(now))) as { usd: number; tokens: number; requests: number }
  return { usd: r.usd, tokens: r.tokens, requests: r.requests }
}

/** the block monthly limit is used up */
export function overMonthLimit(db: Database, r: CredRow, now: Date): boolean {
  if (r.spend_limit_action !== 'block' || (r.spend_limit_usd === null && r.spend_limit_tokens === null)) return false
  const m = monthUsage(db, r.id, now)
  return (r.spend_limit_usd !== null && m.usd >= r.spend_limit_usd) || (r.spend_limit_tokens !== null && m.tokens >= r.spend_limit_tokens)
}

/** Why a connection cannot be used now, or null. (Order: the reason the owner can do something about first.) */
export type Unusable = 'disabled' | 'invalid' | 'needs_reconnect' | 'expired' | 'limited' | 'over_limit' | 'kind_off' | 'sharing_off'
export function unusable(db: Database, r: CredRow, now: Date, allowed: AllowedKinds): { why: Unusable; retryAt: string | null } | null {
  if (!allowed.has(r.kind) || otherGateway(r, allowed)) return { why: 'kind_off', retryAt: null }
  if (r.disabled) return { why: 'disabled', retryAt: null }
  if (r.owner_user_id === null && SUBSCRIPTION.has(r.kind) && !sharedSubscriptionsAllowed(db)) return { why: 'sharing_off', retryAt: null }
  if (r.status === 'needs_reconnect') return { why: 'needs_reconnect', retryAt: null }
  if (r.status === 'invalid') return { why: 'invalid', retryAt: null }
  if (r.expires_at && Date.parse(r.expires_at) <= now.getTime()) return { why: 'expired', retryAt: null }
  if (r.limited_until && Date.parse(r.limited_until) > now.getTime()) return { why: 'limited', retryAt: new Date(r.limited_until).toISOString() }
  if (overMonthLimit(db, r, now)) return { why: 'over_limit', retryAt: nextMonthStart(now).toISOString() }
  return null
}

/** An Anthropic API key connection made for another address than the one Claude requests go to now (an Anthropic key
 * while engine.anthropicGateway is on, a gateway's key without it or for another gateway): never sent there. */
export function otherGateway(r: Pick<CredRow, 'kind' | 'meta'>, allowed: AllowedKinds): boolean {
  return r.kind === 'anthropic-api-key' && (metaOf(r).gateway ?? null) !== (allowed.gateway ?? null)
}

export function stateOf(db: Database, r: CredRow, now: Date, allowed: AllowedKinds): CredentialState {
  const u = unusable(db, r, now, allowed)
  if (u) return u.why
  if (r.kind === 'anthropic-oauth' && r.expires_at && Date.parse(r.expires_at) - now.getTime() <= EXPIRING_MS) return 'expiring'
  if (!r.checked_at) return 'unverified'
  return 'ok'
}

function detailOf(r: CredRow, state: CredentialState, locale: Locale, allowed: AllowedKinds): string | null {
  const key: Partial<Record<CredentialState, keyof typeof CT>> = {
    unverified: 'unverified', expired: 'expired', invalid: r.status_code === 'usage_not_included' ? 'invalidPlan' : 'invalid',
    needs_reconnect: r.status_code === 'decrypt_failed' ? 'decryptFailed' : 'needsReconnect', over_limit: 'overLimit', disabled: 'disabled', kind_off: 'kindOff', sharing_off: 'sharedSubscriptionsOff',
  }
  if (state === 'kind_off' && allowed.has(r.kind) && otherGateway(r, allowed)) return ct('otherGateway', locale)
  if (state === 'expiring' && r.expires_at) return ct('expiring', locale, { date: fmtDate(r.expires_at, locale) })
  if (state === 'limited' && r.limited_until) return ct('limited', locale, { time: fmtTime(r.limited_until, locale) })
  const k = key[state]
  return k ? ct(k, locale) : null
}

/** A row as the API shows it (never a secret). */
export function toCredential(cc: CredCtx, r: CredRow, locale: Locale): Credential {
  const now = new Date(cc.now())
  const state = stateOf(cc.db, r, now, cc.allowedKinds)
  const meta = metaOf(r)
  const owner = r.owner_user_id ? (cc.db.query('SELECT id, name FROM users WHERE id = ?').get(r.owner_user_id) as { id: string; name: string } | null) ?? { id: r.owner_user_id, name: r.owner_user_id } : null
  const asg = cc.db.query(`SELECT a.subject_type AS subjectType, a.subject_id AS subjectId, COALESCE(g.name, u.name, a.subject_id) AS name
    FROM engine_credential_assignments a LEFT JOIN groups g ON a.subject_type = 'group' AND g.id = a.subject_id LEFT JOIN users u ON a.subject_type = 'user' AND u.id = a.subject_id
    WHERE a.credential_id = ? ORDER BY a.subject_type, name`).all(r.id) as { subjectType: 'group' | 'user'; subjectId: string; name: string }[]
  const m = monthUsage(cc.db, r.id, now)
  return {
    id: r.id, kind: r.kind, label: r.label, scope: r.owner_user_id ? 'personal' : 'team', owner, assignments: asg,
    priority: r.priority, disabled: !!r.disabled, state, detail: detailOf(r, state, locale, cc.allowedKinds), hint: r.hint, planType: meta.planType ?? null,
    expiresAt: r.expires_at, limitedUntil: r.limited_until && Date.parse(r.limited_until) > now.getTime() ? r.limited_until : null,
    checkedAt: r.checked_at, lastUsedAt: r.last_used_at,
    spendLimit: { usd: r.spend_limit_usd, tokens: r.spend_limit_tokens, action: r.spend_limit_action },
    month: { usd: Math.round(m.usd * 1e6) / 1e6, tokens: m.tokens, requests: m.requests }, createdAt: r.created_at,
  }
}

/** mark a connection refused by its provider (401) and tell the admins (once an hour) */
export function markInvalid(cc: CredCtx, id: string, code: string, upstreamStatus: number | null) {
  const r = getRow(cc.db, id)
  if (!r) return
  cc.db.query("UPDATE engine_credentials SET status = 'invalid', status_code = ?, updated_at = ? WHERE id = ?").run(code, new Date(cc.now()).toISOString(), id)
  if (r.status !== 'invalid' || r.status_code !== code) audit(cc.db, { actor: null, action: 'credential.rejected', target: id, detail: { kind: r.kind, upstreamStatus, newStatus: 'invalid' } })
  cc.log.warn('an AI connection was refused by its provider', { credential: id, kind: r.kind, upstreamStatus })
  notifyOnce(cc, id, { level: 'error', code: 'credential_rejected', message: ctAll('nRejected', { label: r.label }), link: '/admin/credentials' }, ownerAndAdminsPlusOwnerOf(cc, r))
}
export function markNeedsReconnect(cc: CredCtx, id: string, code: string) {
  const r = getRow(cc.db, id)
  if (!r) return
  cc.db.query("UPDATE engine_credentials SET status = 'needs_reconnect', status_code = ?, updated_at = ? WHERE id = ?").run(code, new Date(cc.now()).toISOString(), id)
  notifyOnce(cc, id, { level: 'error', code: 'credential_needs_reconnect', message: ctAll('nNeedsReconnect', { label: r.label }), link: '/admin/credentials' }, ownerAndAdminsPlusOwnerOf(cc, r))
}
/** who hears about a connection: the owner and admins, and the member whose own connection it is */
export function ownerAndAdminsPlusOwnerOf(cc: CredCtx, r: Pick<CredRow, 'owner_user_id'>): string[] {
  const a = admins(cc.db)
  return r.owner_user_id && !a.includes(r.owner_user_id) ? [...a, r.owner_user_id] : a
}

export const secretsDirOf = (cc: CredCtx) => path.dirname(cc.vault.keyPath())
