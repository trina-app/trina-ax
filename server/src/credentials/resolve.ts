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
import type { AllowedKinds } from '../app-config'
import { memberOwnAllowed } from './policy'
export { MEMBER_OWN_KEY, memberOwnAllowed } from './policy'
import { isCreditLimit, ROW_COLS, SUBSCRIPTION, unusable, type CredRow, type Unusable } from './store'

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

/** the candidates of a person and engine in order, with their tier. `groupsOf`: the groups to use instead of the
 * person's own (someone not there yet: a person who will join through the team link with its groups) */
export function candidates(db: Database, userId: string, engine: CredEngine, exclude?: ReadonlySet<string>, groupsOf?: readonly string[]): { row: CredRow; tier: Tier }[] {
  const kinds = KINDS_OF[FAMILY_OF[engine]]
  const memberOwn = memberOwnAllowed(db)
  const groups = new Set(groupsOf ?? (db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: string }[]).map((g) => g.group_id))
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

export function resolveCredential(db: Database, q: { userId: string; engine: CredEngine; now?: Date; exclude?: ReadonlySet<string>; allowedKinds: AllowedKinds }): Resolution {
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
export const hasCredentialFor = (db: Database, userId: string, engine: CredEngine, allowedKinds: AllowedKinds, now?: Date) =>
  resolveCredential(db, { userId, engine, allowedKinds, now }).ok

/** How near the end of a provider's limit (`limited`) must be for the person to "only wait" ("No AI" does not show).
 * An hour: the proxy's own wait for a 429 that names no reset time (proxy/model-proxy.ts, proxy/codex-path.ts), a burst,
 * or the last part of a 5-hour window. Longer (most of a 5-hour window, a weekly cap, a Codex plan limit until its
 * reset days later) leaves the person without AI for a working session, which an admin can fix with another
 * connection, so it shows. */
export const SOON_MS = 60 * 60_000

/** Does this person have a connection for the engine that works now, or soon (a provider's limit, D14, that ends within
 * SOON_MS and is not "out of credit", which no wait fixes)? The same candidates and checks as resolveCredential and the
 * proxy (broker.ts): the person's own connection only while the team allows them, assignments, subscription sharing,
 * the kinds this server allows, switched off, refused, expired, the monthly block limit. Admin › Members "No AI". */
export function hasCredentialSoonFor(db: Database, userId: string, engine: CredEngine, allowedKinds: AllowedKinds, now = new Date(), groupsOf?: readonly string[]): boolean {
  return candidates(db, userId, engine, undefined, groupsOf).some(({ row }) => {
    const b = backAt(db, row, now, allowedKinds)
    return !!b && !b.monthly && b.at - now.getTime() <= SOON_MS
  })
}

/**
 * When a connection works again by waiting alone: now (it works now); the end of a provider's limit (D14 `limited`,
 * not "out of credit"); the start of next month for the monthly block limit (`over_limit`), or the later of the two when
 * both stop it (`monthly`). null when no wait helps: switched off, refused, expired, out of credit, a kind this server
 * does not allow, sharing off.
 */
function backAt(db: Database, row: CredRow, now: Date, allowedKinds: AllowedKinds): { at: number; monthly: boolean } | null {
  const u = unusable(db, row, now, allowedKinds)
  if (!u) return { at: now.getTime(), monthly: false }
  if (u.why === 'over_limit') return { at: Date.parse(u.retryAt!), monthly: true }
  if (u.why !== 'limited' || isCreditLimit(row.status_code)) return null
  // `limited` is checked after every lasting reason; the one after it (the monthly block limit) is checked again
  const after = unusable(db, { ...row, limited_until: null }, now, allowedKinds)
  if (!after) return { at: Date.parse(u.retryAt!), monthly: false }
  return after.why === 'over_limit' ? { at: Math.max(Date.parse(u.retryAt!), Date.parse(after.retryAt!)), monthly: true } : null
}

/** The earliest time a connection of this person for the engine works again by waiting alone (ISO; backAt), or null
 * when no wait brings one back (none, or each switched off, refused, expired, out of credit). The same candidates and
 * checks as resolveCredential and hasCredentialSoonFor. Admin › Members "AI limit until …". */
export function credentialBackAt(db: Database, userId: string, engine: CredEngine, allowedKinds: AllowedKinds, now = new Date()): string | null {
  let best: number | null = null
  for (const { row } of candidates(db, userId, engine)) {
    const b = backAt(db, row, now, allowedKinds)
    if (b && (best === null || b.at < best)) best = b.at
  }
  return best === null ? null : new Date(best).toISOString()
}

/** usable team (not personal) connections of a family: Admin > AI engines and the diagnostics */
export function teamCredentialSummary(db: Database, family: Family, allowedKinds: AllowedKinds, now = new Date()): { total: number; usable: number; expiring: number; reasons: Unusable[] } {
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
