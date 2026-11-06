// A person asks the team owner to delete their own account (contract: shared/src/api/account-deletion.ts; tables:
// server/migrations/244_b_account_deletion_requests.sql; App Store review 5.1.1(v)). The account is deleted in
// Admin › Members (admin/users.ts deleteUser: the owner, or since 2026-11-06 an admin for a member), so this deletes
// nothing itself:
//   - the request is one row per person (one open request at most); asking while one is open changes nothing
//   - it is told to the owner(s) in their inbox only (notifications/service.ts deletionRequest: the person's id, the
//     name is read when the inbox is shown; never an OS push), with a link to the person in Admin › Members. Admins
//     are not told: the request is the person's business with the owner (an admin who deletes that member anyway
//     closes it, as the owner would)
//   - opening a request is limited per person and day (asking and cancelling over and over), and audited, like the
//     cancel; deleting the account marks the request handled (closeDeletionRequest, called by deleteUser)
//   - the owner cannot ask (409 with a message to make someone else the owner first)
import type { Context } from 'hono'
import type { AccountDeletionRequest } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { notifyDeletionRequest, settleDeletionRequestNotices } from '../notifications/service'
import { msg } from './messages'
import { authOf } from './service'

/** requests a person may open in DAY_MS (a cancel and a new request count again) */
export const DELETION_REQUESTS_PER_DAY = 5
const DAY_MS = 86_400_000

const isOpen = 'cancelled_at IS NULL AND handled_at IS NULL'

function stateOf(ctx: AppContext, user: { id: string; role: string }): AccountDeletionRequest {
  if (user.role === 'owner') return { state: 'owner', requestedAt: null }
  const r = ctx.db.query(`SELECT requested_at FROM account_deletion_requests WHERE user_id = ? AND ${isOpen}`).get(user.id) as { requested_at: string } | null
  return r ? { state: 'pending', requestedAt: r.requested_at } : { state: 'none', requestedAt: null }
}

export function myDeletionRequest(c: Context<AppEnv>, ctx: AppContext): AccountDeletionRequest {
  return stateOf(ctx, c.get('auth')!.user)
}

export function requestAccountDeletion(c: Context<AppEnv>, ctx: AppContext): AccountDeletionRequest {
  const { user } = c.get('auth')!
  const locale = c.get('locale')
  // the owner's account is deleted only after someone else became the owner (Admin › Team settings): a state to
  // change first, not a permission the caller lacks
  if (user.role === 'owner') fail('conflict', msg('deletionOwner', locale))
  const nowMs = authOf(ctx).now()
  const now = new Date(nowMs).toISOString()
  const opened = ctx.db.transaction(() => {
    if (stateOf(ctx, user).state === 'pending') return false
    const { n } = ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'account.deletion_request' AND at > ?")
      .get(user.id, new Date(nowMs - DAY_MS).toISOString()) as { n: number }
    if (n >= DELETION_REQUESTS_PER_DAY) fail('rate_limited', msg('deletionTooOften', locale))
    ctx.db.query(`INSERT INTO account_deletion_requests (user_id, requested_at) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET requested_at = excluded.requested_at, cancelled_at = NULL, handled_at = NULL, handled_by = NULL`).run(user.id, now)
    audit(ctx.db, { actor: user.id, action: 'account.deletion_request', target: user.id })
    return true
  })()
  if (opened) {
    const owners = (ctx.db.query("SELECT id FROM users WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((u) => u.id)
    notifyDeletionRequest(ctx, owners, user.id)
  }
  return stateOf(ctx, user)
}

export function cancelAccountDeletion(c: Context<AppEnv>, ctx: AppContext): AccountDeletionRequest {
  const { user } = c.get('auth')!
  const now = new Date(authOf(ctx).now()).toISOString()
  const cancelled = ctx.db.transaction(() => {
    const r = ctx.db.query(`UPDATE account_deletion_requests SET cancelled_at = ? WHERE user_id = ? AND ${isOpen}`).run(now, user.id)
    if (r.changes) audit(ctx.db, { actor: user.id, action: 'account.deletion_cancel', target: user.id })
    return r.changes > 0
  })()
  if (cancelled) settleDeletionRequestNotices(ctx, user.id)
  return stateOf(ctx, user)
}

/** The people with an open request whose account is still there (Admin › Members, for the owner). */
export function openDeletionRequests(ctx: AppContext): string[] {
  return (ctx.db.query(`SELECT r.user_id FROM account_deletion_requests r JOIN users u ON u.id = r.user_id
    WHERE r.cancelled_at IS NULL AND r.handled_at IS NULL AND u.deleted_at IS NULL ORDER BY r.requested_at`).all() as { user_id: string }[]).map((r) => r.user_id)
}

/** The account was deleted (inside deleteUser's transaction): an open request is handled. Returns whether there
 * was one; the caller settles the owners' entries after the transaction (settleDeletionRequestNotices). */
export function closeDeletionRequest(ctx: AppContext, userId: string, by: string, at: string): boolean {
  return ctx.db.query(`UPDATE account_deletion_requests SET handled_at = ?, handled_by = ? WHERE user_id = ? AND ${isOpen}`).run(at, by, userId).changes > 0
}
