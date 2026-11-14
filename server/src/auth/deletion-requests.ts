// A person deletes their own account (contract: shared/src/api/account-deletion.ts; tables:
// server/migrations/244_b_account_deletion_requests.sql, 297_b_account_deletion_due.sql; App Store review 5.1.1(v),
// Google Play; docs/DECISIONS.md "Self-service account deletion"):
//   - asking needs the person's password (sessions.verifyPassword: 5 wrong tries per 15 minutes, like every re-check)
//     and sets the date ACCOUNT_DELETION_GRACE_DAYS later; one row per person (one open request at most); asking while
//     one is open changes nothing
//   - on that date the hourly sweep (auth/sweeper.ts) deletes the account itself (deleteDueAccounts: admin/users.ts
//     removeAccount with no actor; the personal folder goes to the owner's archive). A failure stays open and is tried
//     again at the next sweep
//   - it is told to the owner(s) and, when a member asks, to the admins too, in their inbox only, with the date
//     (notifications/service.ts deletionRequest: the person's id, the name is read when the inbox is shown; never an
//     OS push), with a link to the person in Admin › Members, where they can delete it sooner (closeDeletionRequest,
//     called by removeAccount). They cannot stop it
//   - opening a request is limited per person and day (asking and cancelling over and over), and audited, like the
//     cancel
//   - the owner cannot ask (409 with a message to make someone else the owner first); becoming the owner cancels an
//     open request (cancelForNewOwner, admin/users.ts transferOwnership)
import type { Context } from 'hono'
import { ACCOUNT_DELETION_GRACE_DAYS, type AccountDeletionRequest } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { removeAccount } from '../admin/users'
import { deletionHandlers, notificationsOf, notifyDeletionRequest, settleDeletionRequestNotices } from '../notifications/service'
import { msg } from './messages'
import { authOf } from './service'

/** requests a person may open in DAY_MS (a cancel and a new request count again) */
export const DELETION_REQUESTS_PER_DAY = 5
const DAY_MS = 86_400_000
const GRACE_MS = ACCOUNT_DELETION_GRACE_DAYS * DAY_MS

const isOpen = 'cancelled_at IS NULL AND handled_at IS NULL'
/** a date this build set: there, and not from before the request (an older build re-opened the row after a rollback) */
const dated = 'due_at IS NOT NULL AND due_at >= requested_at'

function stateOf(ctx: AppContext, user: { id: string; role: string }): AccountDeletionRequest {
  const auditDays = getTeamSettings(ctx.db).auditRetentionDays
  if (user.role === 'owner') return { state: 'owner', requestedAt: null, dueAt: null, auditDays }
  const r = ctx.db.query(`SELECT requested_at, CASE WHEN ${dated} THEN due_at END AS due_at FROM account_deletion_requests WHERE user_id = ? AND ${isOpen}`).get(user.id) as { requested_at: string; due_at: string | null } | null
  return r ? { state: 'pending', requestedAt: r.requested_at, dueAt: r.due_at, auditDays } : { state: 'none', requestedAt: null, dueAt: null, auditDays }
}

export function myDeletionRequest(c: Context<AppEnv>, ctx: AppContext): AccountDeletionRequest {
  return stateOf(ctx, c.get('auth')!.user)
}

export async function requestAccountDeletion(c: Context<AppEnv>, ctx: AppContext, password: string): Promise<AccountDeletionRequest> {
  const { user } = c.get('auth')!
  const locale = c.get('locale')
  // the owner's account is deleted only after someone else became the owner (Admin › Members › ··· › 팀장 넘기기): a state to
  // change first, not a permission the caller lacks
  if (user.role === 'owner') fail('conflict', msg('deletionOwner', locale))
  if (stateOf(ctx, user).state === 'pending') return stateOf(ctx, user)
  // the password, every time: whoever holds an open session must not delete the account (rate-limited per person)
  if (!(await ctx.services.sessions.verifyPassword(user.id, password, c.get('info')))) {
    fail('forbidden', msg('wrongPassword', locale), { fields: { 'body.password': 'wrong password' } })
  }
  const nowMs = authOf(ctx).now()
  const now = new Date(nowMs).toISOString()
  const due = new Date(nowMs + GRACE_MS).toISOString()
  const opened = ctx.db.transaction(() => {
    // read again after the (slow) password check: an owner by now cannot ask
    const row = ctx.db.query('SELECT role FROM users WHERE id = ? AND deleted_at IS NULL').get(user.id) as { role: string } | null
    if (!row) return fail('forbidden')
    if (row.role === 'owner') fail('conflict', msg('deletionOwner', locale))
    if (stateOf(ctx, user).state === 'pending') return false
    const { n } = ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'account.deletion_request' AND at > ?")
      .get(user.id, new Date(nowMs - DAY_MS).toISOString()) as { n: number }
    if (n >= DELETION_REQUESTS_PER_DAY) fail('rate_limited', msg('deletionTooOften', locale))
    ctx.db.query(`INSERT INTO account_deletion_requests (user_id, requested_at, due_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET requested_at = excluded.requested_at, due_at = excluded.due_at, cancelled_at = NULL, handled_at = NULL, handled_by = NULL`).run(user.id, now, due)
    audit(ctx.db, { actor: user.id, action: 'account.deletion_request', target: user.id, detail: { dueAt: due } })
    return true
  })()
  if (opened) {
    notifyDeletionRequest(ctx, deletionHandlers(ctx, row(ctx, user.id)), user.id)
  }
  return stateOf(ctx, user)
}

const row = (ctx: AppContext, id: string) => (ctx.db.query('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | null)?.role ?? 'member'

export function cancelAccountDeletion(c: Context<AppEnv>, ctx: AppContext): AccountDeletionRequest {
  const { user } = c.get('auth')!
  cancelDeletion(ctx, user.id, 'self')
  return stateOf(ctx, user)
}

/** Close an open request without deleting: the person kept their account ('self'), or became the owner
 * ('ownership', admin/users.ts transferOwnership: the owner's account is never deleted this way). */
export function cancelDeletion(ctx: AppContext, userId: string, by: 'self' | 'ownership', actor: string | null = null): boolean {
  const now = new Date(authOf(ctx).now()).toISOString()
  const cancelled = ctx.db.transaction(() => {
    const r = ctx.db.query(`UPDATE account_deletion_requests SET cancelled_at = ? WHERE user_id = ? AND ${isOpen}`).run(now, userId)
    if (r.changes) audit(ctx.db, { actor: by === 'self' ? userId : actor, action: 'account.deletion_cancel', target: userId, detail: { by } })
    return r.changes > 0
  })()
  if (cancelled) settleDeletionRequestNotices(ctx, userId)
  return cancelled
}

/** The people with an open request whose account is still there, with the date (Admin › Members, for the owner and
 * the admins; an admin passes 'member': only members' requests are theirs). */
export function openDeletionRequests(ctx: AppContext, onlyRole?: 'member'): { userId: string; dueAt: string | null }[] {
  return (ctx.db.query(`SELECT r.user_id, CASE WHEN ${dated.replaceAll('due_at', 'r.due_at').replaceAll('requested_at', 'r.requested_at')} THEN r.due_at END AS due_at FROM account_deletion_requests r JOIN users u ON u.id = r.user_id
    WHERE r.cancelled_at IS NULL AND r.handled_at IS NULL AND u.deleted_at IS NULL${onlyRole ? " AND u.role = 'member'" : ''} ORDER BY r.requested_at`).all() as { user_id: string; due_at: string | null }[])
    .map((r) => ({ userId: r.user_id, dueAt: r.due_at }))
}

/** When this person's open request deletes the account (null: none open, or no date yet). */
export function deletionDueOf(ctx: AppContext, userId: string): string | null {
  const r = ctx.db.query(`SELECT CASE WHEN ${dated} THEN due_at END AS due_at FROM account_deletion_requests WHERE user_id = ? AND ${isOpen}`).get(userId) as { due_at: string | null } | null
  return r?.due_at ?? null
}

/** The owner or an admin deleted the account, or the date came (inside removeAccount's transaction): an open request
 * is handled. `by` null: the server. Returns whether there was one; the caller settles the owners' entries after the
 * transaction (settleDeletionRequestNotices). */
export function closeDeletionRequest(ctx: AppContext, userId: string, by: string | null, at: string): boolean {
  return ctx.db.query(`UPDATE account_deletion_requests SET handled_at = ?, handled_by = ? WHERE user_id = ? AND ${isOpen}`).run(at, by, userId).changes > 0
}

/**
 * The sweep's part (auth/sweeper.ts, hourly): open requests with no date of this build get one, 7 days from now, and
 * the person is told (requests open when migration 297 ran, or re-opened by an older build); then each account whose
 * date has passed is deleted, one at a time. The owner is never deleted (their request was cancelled when they became
 * the owner; one left over is cancelled here). A failure leaves the request open for the next sweep.
 */
export async function deleteDueAccounts(ctx: AppContext): Promise<{ dated: number; deleted: number; failed: number }> {
  // one run at a time per server (a slow run and the next hour's)
  if (sweeping.has(ctx)) return { dated: 0, deleted: 0, failed: 0 }
  sweeping.add(ctx)
  try { return await dueRun(ctx) } finally { sweeping.delete(ctx) }
}
const sweeping = new WeakSet<AppContext>()

async function dueRun(ctx: AppContext): Promise<{ dated: number; deleted: number; failed: number }> {
  const nowMs = authOf(ctx).now()
  const now = new Date(nowMs).toISOString()
  const due = new Date(nowMs + GRACE_MS).toISOString()
  const undated = ctx.db.query(`SELECT r.user_id FROM account_deletion_requests r JOIN users u ON u.id = r.user_id
    WHERE r.${isOpen.replace(' AND ', ' AND r.')} AND u.deleted_at IS NULL AND NOT (r.due_at IS NOT NULL AND r.due_at >= r.requested_at)`).all() as { user_id: string }[]
  for (const u of undated) {
    if (ctx.db.query(`UPDATE account_deletion_requests SET due_at = ? WHERE user_id = ? AND ${isOpen} AND NOT (${dated})`).run(due, u.user_id).changes < 1) continue
    audit(ctx.db, { actor: null, action: 'account.deletion_dated', target: u.user_id, detail: { dueAt: due } })
    try { notificationsOf(ctx).deletionDue(u.user_id) } catch { ctx.log.warn('account deletion date notice not recorded') }
  }
  const ready = ctx.db.query(`SELECT r.user_id, u.role FROM account_deletion_requests r JOIN users u ON u.id = r.user_id
    WHERE r.cancelled_at IS NULL AND r.handled_at IS NULL AND u.deleted_at IS NULL AND r.due_at IS NOT NULL AND r.due_at >= r.requested_at AND r.due_at <= ?
    ORDER BY r.due_at`).all(now) as { user_id: string; role: string }[]
  let deleted = 0, failed = 0
  for (const r of ready) {
    if (r.role === 'owner') { cancelDeletion(ctx, r.user_id, 'ownership'); continue }
    try {
      await removeAccount(ctx, {
        targetId: r.user_id, actorId: null, personalFolder: 'transfer', why: 'self_request',
        // read again inside the write: cancelled, or made the owner, since the list was read: not now
        check: () => {
          const q = ctx.db.query(`SELECT 1 FROM account_deletion_requests WHERE user_id = ? AND ${isOpen} AND ${dated} AND due_at <= ?`).get(r.user_id, now)
          if (!q) throw new NotDue()
        },
      })
      deleted++
    } catch (err) {
      if (err instanceof NotDue) continue
      failed++
      ctx.log.error('an account whose deletion date passed was not deleted; tried again at the next sweep', { err, userId: r.user_id })
    }
  }
  return { dated: undated.length, deleted, failed }
}

class NotDue extends Error {}
