// The Inbox rows of 팀장 넘기기 (handover_notices, migration 270; admin/handover.ts makes them, notifications/service.ts
// lists them): what each row says, read at the time of the read, so a row never offers what no longer holds. Metadata
// only: names and usernames from the accounts, the owner's own words for the lead link, counts of what was ended.
import type { Database } from 'bun:sqlite'
import type { AppConfig } from '../app-config'
import { plainLabel, type InboxNotification } from '@mycel/shared/api'
import { isHosted } from '../system/deployment'
import { welcomeUnfinishedFor } from '../onboarding/welcome'

export type HandoverEvent = 'owner.lead_joined' | 'owner.transferred' | 'owner.reauth_locked'
export const HANDOVER_EVENTS: readonly HandoverEvent[] = ['owner.lead_joined', 'owner.transferred', 'owner.reauth_locked']
export const isHandoverEvent = (e: string): e is HandoverEvent => (HANDOVER_EVENTS as readonly string[]).includes(e)

/** The current owner (one by the transfer's rule), active. */
export function currentOwnerId(db: Database): string | null {
  return (db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1").get() as { id: string } | null)?.id ?? null
}

/** Is the lead hint of this invite still one the card may show to `ownerId`: still flagged, flagged by them, they are
 * still the owner, and the person who joined with it is active and not the owner. */
export function leadHolds(db: Database, inviteId: string, ownerId: string): boolean {
  if (currentOwnerId(db) !== ownerId) return false
  return !!db.query(`SELECT 1 FROM invites i JOIN users u ON u.id = i.used_by
    WHERE i.id = ? AND i.lead_hint = 1 AND i.lead_hint_by = ? AND i.used_at IS NOT NULL
    AND u.status = 'active' AND u.deleted_at IS NULL AND u.role != 'owner'`).get(inviteId, ownerId)
}

type Kind = 'team_ai' | 'drive_share' | 'team_connection'
export interface EndedRow { kind: Kind; id: string; result: 'ended' | 'gone' | 'failed' }
const rowsOf = <T>(json: string | null | undefined): T[] => { try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v as T[] : [] } catch { return [] } }
export function endedCounts(json: string | null | undefined): { teamAi: number; driveShares: number; failed: number; connections: number } {
  const rows = rowsOf<EndedRow>(json)
  const ended = (k: Kind) => rows.filter((r) => r.kind === k && r.result === 'ended').length
  return { teamAi: ended('team_ai'), driveShares: ended('drive_share'), connections: ended('team_connection'), failed: rows.filter((r) => r.result === 'failed').length }
}
/** What the transfer planned to end that is not ended or gone yet (admin/handover.ts pendingOf, read here for the row). */
function pendingList(t: { to_end: string; ended: string }): { kind: Kind; id: string; label: string }[] {
  const done = new Set(rowsOf<EndedRow>(t.ended).filter((e) => e.result === 'ended' || e.result === 'gone').map((e) => `${e.kind}:${e.id}`))
  return rowsOf<{ kind: Kind; id: string; label: string }>(t.to_end).filter((p) => !done.has(`${p.kind}:${p.id}`)).map((p) => ({ kind: p.kind, id: p.id, label: plainLabel(String(p.label ?? ''), 80) }))
}

type Row = { id: string; user_id: string; event_type: string; source_id: string; created_at: string; read_at: string | null }
/** A person's display name as the handover rows show it: one plain line (no control, format or direction characters):
 * the joiner chose it and may change it at any time, so it must not scramble the facts beside it. */
export const shownName = (name: string, username?: string) => plainLabel(name, 80) || username || ''
const nameOf = (db: Database, id: string | null) => {
  const r = id ? (db.query('SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { id: string; name: string } | null) : null
  return r ? { id: r.id, name: shownName(r.name) } : null
}
const flagOffered = (config: AppConfig) => !isHosted(config) || config.handoverSafe === true

/** One row as the Inbox shows it. */
export function handoverNoticeOut(ctx: { db: Database; config: AppConfig }, row: Row): InboxNotification {
  const db = ctx.db
  const base = { id: row.id, eventType: row.event_type, sourceId: row.source_id, code: row.event_type, createdAt: row.created_at, readAt: row.read_at, chatId: null, link: null, outcome: null } as InboxNotification
  if (row.event_type === 'owner.lead_joined') {
    const i = db.query('SELECT id, lead_for, used_by, used_at FROM invites WHERE id = ?').get(row.source_id) as { id: string; lead_for: string | null; used_by: string | null; used_at: string | null } | null
    if (!i || !i.used_at) return base
    const u = i.used_by ? db.query('SELECT id, name, username FROM users WHERE id = ? AND deleted_at IS NULL').get(i.used_by) as { id: string; name: string; username: string } | null : null
    return { ...base, handover: { kind: 'lead_joined', leadFor: i.lead_for ?? '', user: u ? { ...u, name: shownName(u.name, u.username) } : null, joinedAt: i.used_at, open: !!u && flagOffered(ctx.config) && leadHolds(db, i.id, row.user_id) } }
  }
  if (row.event_type === 'owner.transferred') {
    const t = db.query('SELECT from_user, to_user, to_end, ended FROM owner_transfers WHERE id = ?').get(row.source_id) as { from_user: string; to_user: string; to_end: string; ended: string } | null
    if (!t) return base
    const me = row.user_id === t.from_user ? 'from' as const : row.user_id === t.to_user ? 'to' as const : 'other' as const
    const owner = currentOwnerId(db)
    // [내보내기]: the new owner, while still the owner, may disable the old owner, while that one is an active admin
    const fromRow = db.query("SELECT role, status FROM users WHERE id = ? AND deleted_at IS NULL").get(t.from_user) as { role: string; status: string } | null
    const removable = me === 'to' && owner === row.user_id && fromRow?.role === 'admin' && fromRow.status === 'active'
    const hosted = isHosted(ctx.config) && !ctx.config.handoverSafe
    return { ...base, handover: {
      kind: 'transferred', me, from: nameOf(db, t.from_user), to: nameOf(db, t.to_user), removable,
      setupUnfinished: me === 'to' && owner === row.user_id && welcomeUnfinishedFor(ctx, row.user_id),
      recovery: hosted && me !== 'other' ? 'hosted' : null,
      ended: endedCounts(t.ended),
      ...(me === 'to' && owner === row.user_id ? { pending: pendingList(t) } : {}),
    } }
  }
  if (row.event_type === 'owner.reauth_locked') return { ...base, handover: { kind: 'reauth_locked' } }
  return base
}

/** The server's config for the push check (set by admin/handover.ts at start): a lead join is not pushed where the
 * flag is not offered any more (a hosted team whose handoverSafe was turned off). */
const pushConfigs = new WeakMap<Database, AppConfig>()
export function setHandoverPushConfig(db: Database, config: AppConfig): void { pushConfigs.set(db, config) }
/** The phone and browser push of a handover notice (push-service.ts SOURCES): a lead join only while its card still
 * holds; a locked password check while the person is still the owner. */
export function handoverPushWanted(db: Database, notificationId: string, _now?: number): boolean {
  const n = db.query("SELECT user_id, event_type, source_id FROM handover_notices WHERE id = ?").get(notificationId) as { user_id: string; event_type: string; source_id: string } | null
  if (!n) return false
  const config = pushConfigs.get(db)
  if (n.event_type === 'owner.lead_joined') return (!config || flagOffered(config)) && leadHolds(db, n.source_id, n.user_id)
  if (n.event_type === 'owner.reauth_locked') return currentOwnerId(db) === n.user_id
  return false
}

