// Guests on the admin side (docs/DECISIONS.md "Guests: only what they were invited to"): "convert to member" (the way
// out when someone needs a second place) and switching off a guest who is no longer in their one place.
import type { Context } from 'hono'
import type { GuestAiChoice, User } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { audit } from './audit'
import { afterAccessChange, captureState } from './folders'
import { assertSeatFree } from '../system/limits'
import { getUser, toUser } from '../auth/users'
import { inPlace, isGuest } from '../auth/guests'
import { MY_PROFILE_CHANGED } from '../auth/profiles'
import { disableAccount } from './users'
import { newId } from '../db'
import { teamCredentialOk } from '../auth/guest-invites'
import { stopTurnsOf } from '../chat/runtime'

/**
 * POST /api/admin/users/:id/convert-guest: the guest becomes a team member. They take a seat (409 plan_limit, reason
 * seat_limit, checked in the write when they are active), keep their place (group chat membership, project rule), and
 * from now on are judged as any member (the everyone room, team folders by their rules). Their guest AI choice ends: AI
 * follows the team's rules for members. The guest's own 'block' budget stays (an admin may remove it).
 */
export function convertGuest(c: Context<AppEnv>, ctx: AppContext, id: string): User {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  const before = captureState(ctx.db)
  ctx.db.transaction(() => {
    const u = ctx.db.query('SELECT guest, status, deleted_at FROM users WHERE id = ?').get(id) as { guest: number; status: string; deleted_at: string | null } | null
    if (!u || u.deleted_at) fail('not_found')
    if (u!.guest !== 1) fail('conflict', undefined, { params: { reason: 'not_a_guest' } })
    if (u!.status === 'active') assertSeatFree(ctx.db, locale)
    ctx.db.query("UPDATE users SET guest = 0, role = 'member' WHERE id = ?").run(id)
    ctx.db.query('DELETE FROM guests WHERE user_id = ?').run(id)
    audit(ctx.db, { actor: auth.user.id, action: 'user.convert_guest', target: id })
  }).immediate()
  afterAccessChange(ctx, before, { actor: auth.user.id, target: id })
  // their windows read the account again (role guest -> member)
  ctx.services.realtime.publish(id, MY_PROFILE_CHANGED)
  return toUser(ctx.db, getUser(ctx.db, id)!)
}

/**
 * A guest removed from their one place (taken out of the group chat, left it, the chat archived, out of the project's
 * people, the project trashed): the account is switched off (owner decision 2026-11-14). Called after every write that
 * can take someone out of a group chat or a project; a no-op for anyone else.
 */
export function disableGuestIfPlaceless(ctx: AppContext, userId: string, actorId: string | null): boolean {
  if (!isGuest(ctx.db, userId)) return false
  const u = ctx.db.query('SELECT status FROM users WHERE id = ? AND deleted_at IS NULL').get(userId) as { status: string } | null
  if (!u || u.status !== 'active' || inPlace(ctx.db, userId)) return false
  return disableAccount(ctx, userId, actorId, 'guest_no_place')
}

/** disableGuestIfPlaceless for every active guest (after an access change, a project trashed, at start). */
export function disablePlacelessGuests(ctx: AppContext, actorId: string | null): string[] {
  const ids = (ctx.db.query("SELECT id FROM users WHERE guest = 1 AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)
  return ids.filter((id) => disableGuestIfPlaceless(ctx, id, actorId))
}

/**
 * PATCH /api/admin/users/:id/guest-ai (the owner or an admin): a guest's AI, with the invite's checks. 'team' needs a
 * team connection (not anyone's personal one) and a monthly limit: guests.team_credential_id and the guest's own
 * 'block' budget (the earlier 'block' budgets of the guest are replaced); never an engine_credential_assignments row.
 * Turned to 'none' or 'own': the connection is cleared and the guest's running answers stop.
 */
export function updateGuestAi(c: Context<AppEnv>, ctx: AppContext, id: string, ai: GuestAiChoice): User {
  const auth = c.get('auth')!
  ctx.db.transaction(() => {
    const u = ctx.db.query('SELECT guest, deleted_at FROM users WHERE id = ?').get(id) as { guest: number; deleted_at: string | null } | null
    if (!u || u.deleted_at) fail('not_found')
    if (u!.guest !== 1) fail('conflict', undefined, { params: { reason: 'not_a_guest' } })
    if (ai.mode === 'team' && !teamCredentialOk(ctx.db, ai.credentialId)) fail('validation', undefined, { fields: { 'body.credentialId': 'not a team connection' } })
    ctx.db.query('UPDATE guests SET ai = ?, team_credential_id = ? WHERE user_id = ?').run(ai.mode, ai.mode === 'team' ? ai.credentialId : null, id)
    if (ai.mode === 'team') {
      ctx.db.query("DELETE FROM budgets WHERE subject_type = 'user' AND subject_id = ? AND action = 'block'").run(id)
      ctx.db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, limit_tokens, action) VALUES (?, 'user', ?, 'month', ?, NULL, 'block')").run(newId(), id, ai.limitUsd)
    }
    audit(ctx.db, { actor: auth.user.id, action: 'user.guest_ai', target: id, detail: { ai: ai.mode, ...(ai.mode === 'team' ? { credentialId: ai.credentialId, limitUsd: ai.limitUsd } : {}) } })
  }).immediate()
  if (ai.mode !== 'team') stopTurnsOf(ctx, id)
  ctx.services.realtime.publish(id, MY_PROFILE_CHANGED)
  return toUser(ctx.db, getUser(ctx.db, id)!)
}
