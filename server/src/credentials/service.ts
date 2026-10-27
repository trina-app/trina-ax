// Making, changing and removing AI connections (Admin > AI connections, Settings > AI connections). Owner: A.
// Rules (docs/DECISIONS.md "AI 연결"): only the owner adds, replaces, renames, orders, assigns, limits and removes team
// connections (adding and replacing ask for the password again); admins see and re-check; a member manages only
// their own connections, and only while the team allows them. Secrets arrive sealed (seal.ts) and are checked
// without spending tokens (validate.ts). Audit details hold kinds, labels, hints (last 4) and plans, never a secret.
import type { Credential, CredentialAssignment, CredentialKind, Locale, SpendLimit } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { setSetting } from '../admin/settings'
import { newId } from '../db'
import { fail } from '../http/errors'
import { ct } from './i18n'
import { MEMBER_OWN_KEY, memberOwnAllowed } from './resolve'
import { SHARED_SUBSCRIPTIONS_KEY, sharedSubscriptionsAllowed } from './policy'
import { SealError } from './seal'
import {
  CLAUDE_TOKEN_LIFETIME_MS, fingerprintOf, getRow, listRows, mainSecret, metaOf, secretOf, SUBSCRIPTION, toCredential, writeSecret,
  type CredCtx, type CredMeta, type CredRow, type Secrets,
} from './store'
import { formatProblem, verifySecret } from './validate'
import { ensureFresh } from './chatgpt-tokens'

type ApiKind = Exclude<CredentialKind, 'chatgpt'>
const secretOfKind = (kind: ApiKind, s: string): Secrets[ApiKind] => (kind === 'anthropic-oauth' ? { token: s } : { key: s })
const hintOf = (kind: CredentialKind, s: string) => (kind === 'anthropic-api-key' || kind === 'openai-api-key' ? s.slice(-4) : null)

/** open a sealed secret for this purpose, or answer 400 (never says what it was) */
export async function unsealOrFail(cc: CredCtx, sealed: Parameters<CredCtx['sealer']['unseal']>[0], purpose: 'credential.create' | 'credential.replace', locale: Locale): Promise<string> {
  try { return await cc.sealer.unseal(sealed, purpose) } catch (e) {
    if (e instanceof SealError) return fail('validation', ct('sealed', locale), { fields: { 'body.sealed': e.reason === 'kid' ? 'sealed with another key' : e.reason === 'purpose' ? 'sealed for another request' : e.reason === 'replay' ? 'already used' : 'cannot be opened' } })
    throw e
  }
}

function checkAssignments(cc: CredCtx, a: CredentialAssignment[], locale: Locale) {
  for (const x of a) {
    const ok = x.subjectType === 'group' ? cc.db.query('SELECT 1 FROM groups WHERE id = ?').get(x.subjectId) : cc.db.query('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(x.subjectId)
    if (!ok) fail('validation', ct('unknownAssignee', locale), { fields: { 'body.assignments': 'unknown group or person' } })
  }
}
const uniq = (a: CredentialAssignment[]) => [...new Map(a.map((x) => [`${x.subjectType}|${x.subjectId}`, x])).values()]
function setAssignments(cc: CredCtx, id: string, a: CredentialAssignment[]) {
  cc.db.query('DELETE FROM engine_credential_assignments WHERE credential_id = ?').run(id)
  for (const x of uniq(a)) cc.db.query('INSERT INTO engine_credential_assignments (credential_id, subject_type, subject_id) VALUES (?, ?, ?)').run(id, x.subjectType, x.subjectId)
}
const assignmentsOf = (cc: CredCtx, id: string) => cc.db.query('SELECT subject_type AS subjectType, subject_id AS subjectId FROM engine_credential_assignments WHERE credential_id = ? ORDER BY subject_type, subject_id').all(id) as CredentialAssignment[]

/** a connection with the same token / key (or the same ChatGPT account) already exists */
export function duplicateOf(cc: CredCtx, kind: CredentialKind, fp: string, except?: string): CredRow | null {
  const r = cc.db.query('SELECT id FROM engine_credentials WHERE kind = ? AND fingerprint = ? AND id != ?').get(kind, fp, except ?? '') as { id: string } | null
  return r ? getRow(cc.db, r.id) : null
}

export interface NewRow {
  kind: CredentialKind; label: string; secret: Secrets[CredentialKind]; ownerUserId: string | null; priority: number; assignments: CredentialAssignment[]
  createdBy: string | null; meta?: CredMeta; expiresAt?: string | null; checkedAt?: string | null; status?: CredRow['status']; statusCode?: string | null; id?: string
}
/** Insert a row with its encrypted secret and assignments (one transaction). Returns the id. */
export function insertRow(cc: CredCtx, n: NewRow): string {
  const id = n.id ?? newId()
  const main = mainSecret(n.kind, n.secret)
  const { enc, keyVersion } = cc.vault.encrypt(id, n.kind, n.secret)
  const now = new Date(cc.now()).toISOString()
  cc.db.transaction(() => {
    cc.db.query(`INSERT INTO engine_credentials (id, kind, label, owner_user_id, priority, disabled, status, status_code, secret_enc, key_version, fingerprint, hint, meta, expires_at, checked_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, n.kind, n.label, n.ownerUserId, n.priority, n.status ?? 'ok', n.statusCode ?? null, enc, keyVersion, fingerprintOf(main),
        n.kind === 'chatgpt' ? null : hintOf(n.kind, main), JSON.stringify(n.meta ?? {}), n.expiresAt ?? null, n.checkedAt ?? null, n.createdBy, now, now)
    setAssignments(cc, id, n.ownerUserId ? [] : n.assignments)
  })()
  cc.cache.set(id, { updatedAt: now, value: n.secret })
  return id
}

export interface CreateInput {
  kind: ApiKind; label: string; secret: string; assignments: CredentialAssignment[]; priority: number
  ownerUserId: string | null; actor: string; acknowledgedPlanNotice?: boolean
}

function checkCreatePolicy(cc: CredCtx, i: CreateInput, locale: Locale) {
  if (!i.ownerUserId && SUBSCRIPTION.has(i.kind) && !sharedSubscriptionsAllowed(cc.db)) fail('forbidden', ct('sharedSubscriptionsOff', locale))
  if (i.ownerUserId && (!memberOwnAllowed(cc.db) || i.ownerUserId !== i.actor)) fail('forbidden', ct('memberOwnOff', locale))
}

/** POST /api/admin/credentials, POST /api/me/credentials (the secret already unsealed) */
export async function createCredential(cc: CredCtx, i: CreateInput, locale: Locale): Promise<Credential> {
  if (!cc.allowedKinds.has(i.kind)) fail('validation', ct('kindNotAllowed', locale), { fields: { 'body.kind': 'not allowed on this server' } })
  const bad = formatProblem(i.kind, i.secret)
  if (bad) fail('validation', ct(bad, locale), { fields: { 'body.sealed': bad === 'badClaudeToken' ? 'not a Claude subscription token' : 'not an API key of this kind' } })
  if (SUBSCRIPTION.has(i.kind) && i.acknowledgedPlanNotice !== true) fail('validation', ct('planNotice', locale), { fields: { 'body.acknowledgedPlanNotice': 'required for a subscription' } })
  checkCreatePolicy(cc, i, locale)
  if (duplicateOf(cc, i.kind, fingerprintOf(i.secret))) fail('conflict', ct('duplicate', locale))
  if (!i.ownerUserId) checkAssignments(cc, i.assignments, locale)
  const check = await verifySecret(cc, i.kind, i.secret)
  checkCreatePolicy(cc, i, locale)
  if (check.result === 'refused') fail('validation', ct(i.kind === 'anthropic-oauth' ? 'refusedClaude' : 'refusedKey', locale), { fields: { 'body.sealed': 'refused by the provider' } })
  const now = cc.now()
  const id = insertRow(cc, {
    kind: i.kind, label: i.label, secret: secretOfKind(i.kind, i.secret), ownerUserId: i.ownerUserId, priority: i.priority, assignments: i.assignments,
    createdBy: i.actor, meta: i.kind === 'anthropic-oauth' ? { issuedAt: new Date(now).toISOString() } : {},
    expiresAt: i.kind === 'anthropic-oauth' ? new Date(now + CLAUDE_TOKEN_LIFETIME_MS).toISOString() : null,
    checkedAt: check.result === 'ok' ? new Date(now).toISOString() : null,
  })
  const row = getRow(cc.db, id)!
  audit(cc.db, { actor: i.actor, action: 'credential.create', target: id, detail: {
    kind: i.kind, label: i.label, scope: i.ownerUserId ? 'personal' : 'team', assignments: i.ownerUserId ? [] : uniq(i.assignments), priority: i.priority,
    ...(row.hint ? { hint: row.hint } : {}), verified: check.result === 'ok' } })
  return toCredential(cc, row, locale)
}

/** POST /api/admin/credentials/:id/secret: a new token / key on the same connection (same kind). */
export async function replaceSecret(cc: CredCtx, id: string, secret: string, actor: string, locale: Locale): Promise<Credential> {
  const row = getRow(cc.db, id)
  if (!row) return fail('not_found')
  if (row.kind === 'chatgpt') return fail('conflict', ct('sameKind', locale))
  const kind = row.kind as ApiKind
  const bad = formatProblem(kind, secret)
  if (bad) fail('validation', ct(bad, locale), { fields: { 'body.sealed': 'not a token or key of this kind' } })
  if (duplicateOf(cc, kind, fingerprintOf(secret), id)) fail('conflict', ct('duplicate', locale))
  const check = await verifySecret(cc, kind, secret)
  if (check.result === 'refused') fail('validation', ct(kind === 'anthropic-oauth' ? 'refusedClaude' : 'refusedKey', locale), { fields: { 'body.sealed': 'refused by the provider' } })
  const now = cc.now()
  const meta = metaOf(row)
  cc.db.transaction(() => writeSecret(cc, id, kind, secretOfKind(kind, secret), {
    fingerprint: fingerprintOf(secret), hint: hintOf(kind, secret), status: 'ok', status_code: null, limited_until: null,
    checked_at: check.result === 'ok' ? new Date(now).toISOString() : null,
    ...(kind === 'anthropic-oauth' ? { expires_at: new Date(now + CLAUDE_TOKEN_LIFETIME_MS).toISOString(), meta: JSON.stringify({ ...meta, issuedAt: new Date(now).toISOString() }) } : {}),
  }))()
  const r = getRow(cc.db, id)!
  audit(cc.db, { actor, action: 'credential.secret_replaced', target: id, detail: { kind, ...(r.hint ? { hint: r.hint } : {}), verified: check.result === 'ok' } })
  return toCredential(cc, r, locale)
}

export interface UpdateInput { label?: string; priority?: number; disabled?: boolean; assignments?: CredentialAssignment[]; spendLimit?: SpendLimit }

/** PATCH /api/admin/credentials/:id */
export function updateCredential(cc: CredCtx, id: string, b: UpdateInput, actor: string, locale: Locale): Credential {
  const row = getRow(cc.db, id)
  if (!row) return fail('not_found')
  if (b.assignments && row.owner_user_id && b.assignments.length) fail('validation', undefined, { fields: { 'body.assignments': 'a personal connection is only its owner\'s' } })
  if (b.assignments) checkAssignments(cc, b.assignments, locale)
  const changed: string[] = []
  const before = assignmentsOf(cc, id)
  cc.db.transaction(() => {
    const sets: string[] = []
    const args: (string | number | null)[] = []
    if (b.label !== undefined && b.label !== row.label) { sets.push('label = ?'); args.push(b.label); changed.push('label') }
    if (b.priority !== undefined && b.priority !== row.priority) { sets.push('priority = ?'); args.push(b.priority); changed.push('priority') }
    if (b.disabled !== undefined && (b.disabled ? 1 : 0) !== row.disabled) { sets.push('disabled = ?'); args.push(b.disabled ? 1 : 0); changed.push('disabled') }
    if (b.spendLimit) {
      sets.push('spend_limit_usd = ?', 'spend_limit_tokens = ?', 'spend_limit_action = ?'); args.push(b.spendLimit.usd, b.spendLimit.tokens, b.spendLimit.action); changed.push('spendLimit')
    }
    if (sets.length) cc.db.query(`UPDATE engine_credentials SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, new Date(cc.now()).toISOString(), id)
    if (b.assignments) { setAssignments(cc, id, b.assignments); changed.push('assignments') }
  })()
  if (changed.length) audit(cc.db, { actor, action: 'credential.update', target: id, detail: {
    changed, ...(b.assignments ? { assignmentsBefore: before, assignmentsAfter: assignmentsOf(cc, id) } : {}), ...(b.spendLimit ? { spendLimit: b.spendLimit } : {}) } })
  return toCredential(cc, getRow(cc.db, id)!, locale)
}

/** DELETE: the row goes (assignments, per-day use and notices with it); turns keep their credential_id. */
export function deleteCredential(cc: CredCtx, id: string, actor: string, onlyOwnerId?: string): void {
  const row = getRow(cc.db, id)
  if (!row || (onlyOwnerId !== undefined && row.owner_user_id !== onlyOwnerId)) return fail('not_found')
  cc.db.query('DELETE FROM engine_credentials WHERE id = ?').run(id)
  cc.cache.delete(id)
  audit(cc.db, { actor, action: 'credential.delete', target: id, detail: { kind: row.kind, label: row.label, scope: row.owner_user_id ? 'personal' : 'team' } })
}

/** POST /api/admin/credentials/:id/check: ask the provider again (no tokens spent). */
export async function checkCredential(cc: CredCtx, id: string, actor: string, locale: Locale): Promise<Credential> {
  const row = getRow(cc.db, id)
  if (!row) return fail('not_found')
  let result: 'ok' | 'unverified' | 'invalid' = 'unverified'
  let upstreamStatus: number | null = null
  const now = new Date(cc.now()).toISOString()
  if (row.kind === 'chatgpt') {
    // a ChatGPT sign-in is checked by refreshing it: a refresh token the provider still takes
    const f = await ensureFresh(cc, id, { force: true })
    result = f.ok ? 'ok' : f.permanent ? 'invalid' : 'unverified'
    if (f.ok) cc.db.query('UPDATE engine_credentials SET checked_at = ? WHERE id = ?').run(now, id)
  } else {
    const s = secretOf(cc, row as CredRow & { kind: ApiKind })
    if (s) {
      const v = await verifySecret(cc, row.kind as ApiKind, mainSecret(row.kind, s))
      upstreamStatus = v.upstreamStatus
      result = v.result === 'refused' ? 'invalid' : v.result
      if (v.result === 'ok') cc.db.query("UPDATE engine_credentials SET status = 'ok', status_code = NULL, checked_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
      else if (v.result === 'refused') cc.db.query("UPDATE engine_credentials SET status = 'invalid', status_code = 'upstream_' || ?, updated_at = ? WHERE id = ?").run(String(v.upstreamStatus), now, id)
    }
  }
  audit(cc.db, { actor, action: 'credential.check', target: id, detail: { result, upstreamStatus } })
  return toCredential(cc, getRow(cc.db, id)!, locale)
}

export function setMemberOwn(cc: CredCtx, on: boolean, actor: string) {
  setSetting(cc.db, MEMBER_OWN_KEY, on)
  audit(cc.db, { actor, action: 'credential.settings', target: null, detail: { memberOwn: on } })
}

/** Validate consent before changing either setting, so a rejected combined patch is atomic. */
export function setCredentialSettings(cc: CredCtx, b: { memberOwn?: boolean; sharedSubscriptions?: boolean; acknowledgedSharedSubscriptionRisk?: boolean }, actor: string, locale: Locale) {
  if (b.sharedSubscriptions === true && !sharedSubscriptionsAllowed(cc.db) && b.acknowledgedSharedSubscriptionRisk !== true) {
    fail('validation', ct('sharedRiskAcknowledgement', locale), { fields: { 'body.acknowledgedSharedSubscriptionRisk': 'required to enable shared subscriptions' } })
  }
  cc.db.transaction(() => {
    if (b.memberOwn !== undefined) setMemberOwn(cc, b.memberOwn, actor)
    if (b.sharedSubscriptions !== undefined) {
      setSetting(cc.db, SHARED_SUBSCRIPTIONS_KEY, b.sharedSubscriptions)
      audit(cc.db, { actor, action: 'credential.settings', target: null, detail: { sharedSubscriptions: b.sharedSubscriptions, acknowledgedSharedSubscriptionRisk: b.sharedSubscriptions && b.acknowledgedSharedSubscriptionRisk === true } })
    }
  })()
  return { memberOwn: memberOwnAllowed(cc.db), sharedSubscriptions: sharedSubscriptionsAllowed(cc.db) }
}

export function listCredentials(cc: CredCtx, locale: Locale): Credential[] {
  return listRows(cc.db).map((r) => toCredential(cc, r, locale))
}
export function myCredentials(cc: CredCtx, userId: string, locale: Locale): Credential[] {
  return listRows(cc.db).filter((r) => r.owner_user_id === userId).map((r) => toCredential(cc, r, locale))
}
export { memberOwnAllowed }
