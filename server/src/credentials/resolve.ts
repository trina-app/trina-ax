// Which AI connection answers a turn (docs/DECISIONS.md "AI 연결" D4/D5). Read only, deterministic: the same person,
// engine and database state always give the same connection, so it can be tested as a table
// (tests/unit/a-credentials-resolve.test.ts).
//   tiers: own (the person's personal connection, only while the team allows them) -> assigned to the person ->
//          assigned to one of their groups (as they are now) -> team-wide (no assignment)
//   within a tier: priority ascending, subscriptions first (no price per request), created_at, id
// A connection that cannot be used now (switched off, refused, expired, at its limit, kind off on this server) is
// skipped; an assigned connection that cannot be used falls through to the team-wide ones (D5). Another member's
// personal connection is never a candidate, whatever the settings say.
import type { Database } from 'bun:sqlite'
import type { CredentialKind } from '@mycel/shared/api'
import { memberOwnAllowed } from './policy'
export { MEMBER_OWN_KEY, memberOwnAllowed } from './policy'
import { ROW_COLS, SUBSCRIPTION, unusable, type CredRow, type Unusable } from './store'

export type Family = 'anthropic' | 'openai'
export type CredEngine = 'claude-code' | 'codex'
export const FAMILY_OF: Record<CredEngine, Family> = { 'claude-code': 'anthropic', codex: 'openai' }
export const KINDS_OF: Record<Family, CredentialKind[]> = { anthropic: ['anthropic-oauth', 'anthropic-api-key'], openai: ['chatgpt', 'openai-api-key'] }
export const familyOfKind = (k: CredentialKind): Family => (k === 'anthropic-oauth' || k === 'anthropic-api-key' ? 'anthropic' : 'openai')

export type Tier = 'own' | 'user' | 'group' | 'team'
const TIER_RANK: Record<Tier, number> = { own: 0, user: 1, group: 2, team: 3 }

export type Resolution =
  | { ok: true; credentialId: string; kind: CredentialKind; tier: Tier }
  | { ok: false; reason: 'none' | 'all_unusable'; retryAt: string | null; skipped: { id: string; why: Unusable }[] }

/** the candidates of a person and engine in order, with their tier */
export function candidates(db: Database, userId: string, engine: CredEngine, exclude?: ReadonlySet<string>): { row: CredRow; tier: Tier }[] {
  const kinds = KINDS_OF[FAMILY_OF[engine]]
  const memberOwn = memberOwnAllowed(db)
  const groups = new Set((db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: string }[]).map((g) => g.group_id))
  const rows = db.query(`SELECT ${ROW_COLS} FROM engine_credentials WHERE kind IN (${kinds.map(() => '?').join(',')})`).all(...kinds) as CredRow[]
  const asg = new Map<string, { t: string; s: string }[]>()
  for (const a of db.query('SELECT credential_id, subject_type, subject_id FROM engine_credential_assignments').all() as { credential_id: string; subject_type: string; subject_id: string }[]) {
    const l = asg.get(a.credential_id) ?? []
    l.push({ t: a.subject_type, s: a.subject_id })
    asg.set(a.credential_id, l)
  }
  const out: { row: CredRow; tier: Tier }[] = []
  for (const row of rows) {
    if (exclude?.has(row.id)) continue
    let tier: Tier | null = null
    if (row.owner_user_id !== null) {
      // a personal connection: its owner's, and only while the team allows them; nobody else's ever
      if (row.owner_user_id === userId && memberOwn) tier = 'own'
    } else {
      const a = asg.get(row.id)
      if (!a?.length) tier = 'team'
      else if (a.some((x) => x.t === 'user' && x.s === userId)) tier = 'user'
      else if (a.some((x) => x.t === 'group' && groups.has(x.s))) tier = 'group'
    }
    if (tier) out.push({ row, tier })
  }
  return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.row.priority - b.row.priority
    || (SUBSCRIPTION.has(a.row.kind) ? 0 : 1) - (SUBSCRIPTION.has(b.row.kind) ? 0 : 1)
    || a.row.created_at.localeCompare(b.row.created_at) || a.row.id.localeCompare(b.row.id))
}

export function resolveCredential(db: Database, q: { userId: string; engine: CredEngine; now?: Date; exclude?: ReadonlySet<string>; allowedKinds: ReadonlySet<CredentialKind> }): Resolution {
  const now = q.now ?? new Date()
  const list = candidates(db, q.userId, q.engine, q.exclude)
  const skipped: { id: string; why: Unusable }[] = []
  let retryAt: string | null = null
  for (const { row, tier } of list) {
    const u = unusable(db, row, now, q.allowedKinds)
    if (!u) return { ok: true, credentialId: row.id, kind: row.kind, tier }
    skipped.push({ id: row.id, why: u.why })
    if (u.retryAt && (!retryAt || u.retryAt < retryAt)) retryAt = u.retryAt
  }
  // connections the owner switched off (or this server does not allow) count as none: "no AI connection" is what the
  // person can act on (ask an admin), not "the connection was refused"
  const real = skipped.some((s) => s.why !== 'disabled' && s.why !== 'kind_off' && s.why !== 'sharing_off')
  return { ok: false, reason: real ? 'all_unusable' : 'none', retryAt, skipped }
}

/** Does this person have a usable connection for the engine now? (composer engine list, Admin > AI engines) */
export const hasCredentialFor = (db: Database, userId: string, engine: CredEngine, allowedKinds: ReadonlySet<CredentialKind>, now?: Date) =>
  resolveCredential(db, { userId, engine, allowedKinds, now }).ok

/** usable team (not personal) connections of a family: Admin > AI engines and the diagnostics */
export function teamCredentialSummary(db: Database, family: Family, allowedKinds: ReadonlySet<CredentialKind>, now = new Date()): { total: number; usable: number; expiring: number; reasons: Unusable[] } {
  const kinds = KINDS_OF[family]
  const rows = db.query(`SELECT ${ROW_COLS} FROM engine_credentials WHERE owner_user_id IS NULL AND kind IN (${kinds.map(() => '?').join(',')})`).all(...kinds) as CredRow[]
  let usable = 0, expiring = 0
  const reasons: Unusable[] = []
  for (const r of rows) {
    const u = unusable(db, r, now, allowedKinds)
    if (u) { reasons.push(u.why); continue }
    usable++
    if (r.kind === 'anthropic-oauth' && r.expires_at && Date.parse(r.expires_at) - now.getTime() <= 14 * 24 * 3600_000) expiring++
  }
  return { total: rows.length, usable, expiring, reasons }
}
