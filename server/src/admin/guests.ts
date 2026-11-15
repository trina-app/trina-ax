// Guests on the admin side (docs/DECISIONS.md "Guests: only what they were invited to"): "convert to member" (the way
// out when someone needs a second place) and switching off a guest who is no longer in their one place.
import type { Context } from 'hono'
import type { GuestAiChoice, GuestPlace, User } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { audit } from './audit'
import { afterAccessChange, captureState } from './folders'
import { assertSeatFree } from '../system/limits'
import { getUser, toUser } from '../auth/users'
import { guestLimit, guestPlace, guestsUsed, inPlace, inPlaceEvenIfOff, isGuest } from '../auth/guests'
import { MY_PROFILE_CHANGED } from '../auth/profiles'
import { disableAccount } from './users'
import { newId } from '../db'
import { placeAlive, teamCredentialOk } from '../auth/guest-invites'
import { stopTurnsOf } from '../chat/runtime'

/**
 * POST /api/admin/users/:id/convert-guest: the guest becomes a team member. They take a seat (409 plan_limit, reason
 * seat_limit, checked in the write), keep their place (group chat membership, project rule), and from now on are judged
 * as any member (the everyone room, team folders by their rules). Their guest AI ends with it (owner, 2026-11-14: the
 * dialog says "Their AI then follows the team's settings, like any member's"): the guests row with its team connection
 * goes, and so does the guest's own monthly limit (their 'user' block budgets), so nothing of the guest's AI stays
 * under a member. A removed guest (switched off) is switched on with it: making someone a team member is bringing
 * them back, whether or not their old place is still there (a member needs no place).
 */
export function convertGuest(c: Context<AppEnv>, ctx: AppContext, id: string): User {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  const before = captureState(ctx.db)
  let enabled = false
  ctx.db.transaction(() => {
    const u = ctx.db.query('SELECT guest, status, deleted_at FROM users WHERE id = ?').get(id) as { guest: number; status: string; deleted_at: string | null } | null
    if (!u || u.deleted_at) fail('not_found')
    if (u!.guest !== 1) fail('conflict', undefined, { params: { reason: 'not_a_guest' } })
    assertSeatFree(ctx.db, locale)
    enabled = u!.status !== 'active'
    ctx.db.query(`UPDATE users SET guest = 0, role = 'member'${enabled ? ", status = 'active'" : ''} WHERE id = ?`).run(id)
    ctx.db.query('DELETE FROM guests WHERE user_id = ?').run(id)
    ctx.db.query("DELETE FROM budgets WHERE subject_type = 'user' AND subject_id = ? AND action = 'block'").run(id)
    audit(ctx.db, { actor: auth.user.id, action: 'user.convert_guest', target: id, ...(enabled ? { detail: { status: 'active' } } : {}) })
  }).immediate()
  afterAccessChange(ctx, before, { actor: auth.user.id, target: id })
  // the guest AI is over: an answer running on it stops (the next one follows the team's settings)
  stopTurnsOf(ctx, id)
  // their windows read the account again (role guest -> member)
  ctx.services.realtime.publish(id, MY_PROFILE_CHANGED)
  return toUser(ctx.db, getUser(ctx.db, id)!)
}

/**
 * A guest removed from their one place (taken out of the group chat, left it, the chat archived, out of the project's
 * people, the project trashed): the account is switched off (owner decision 2026-11-14). Called after every write that
 * can take someone out of a group chat or a project; a no-op for anyone else. When the place itself was closed (the
 * project trashed, the chat archived) and not the guest taken out of it, guests.off_with_place says so: restoring the
 * project switches them on again (returnGuestsWithPlace).
 */
export function disableGuestIfPlaceless(ctx: AppContext, userId: string, actorId: string | null): boolean {
  if (!isGuest(ctx.db, userId)) return false
  const u = ctx.db.query('SELECT status FROM users WHERE id = ? AND deleted_at IS NULL').get(userId) as { status: string } | null
  if (!u || u.status !== 'active' || inPlace(ctx.db, userId)) return false
  const place = guestPlace(ctx.db, userId)
  const closed = !!place && !placeAlive(ctx.db, place)
  const off = disableAccount(ctx, userId, actorId, 'guest_no_place')
  if (off && closed) ctx.db.query('UPDATE guests SET off_with_place = ? WHERE user_id = ?').run(new Date().toISOString(), userId)
  return off
}

/** disableGuestIfPlaceless for every active guest (after an access change, a project trashed, at start). */
export function disablePlacelessGuests(ctx: AppContext, actorId: string | null): string[] {
  const ids = (ctx.db.query("SELECT id FROM users WHERE guest = 1 AND status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)
  return ids.filter((id) => disableGuestIfPlaceless(ctx, id, actorId))
}

/**
 * A place came back (a project restored from the trash, or pointed at a folder again): its guests whom the server
 * switched off because the place was closed (guests.off_with_place) are switched on again, while they are still in it
 * and within the plan's guests. Never a guest an admin switched on or off by hand in between (the mark is cleared by
 * every switch by hand: admin/users.ts updateUser), never a deleted account. Returns the ids switched on. Never throws.
 */
export function returnGuestsWithPlace(ctx: AppContext, places: readonly GuestPlace[], actorId: string | null): string[] {
  const back: string[] = []
  for (const place of places) {
    try {
      const ids = (ctx.db.query(`SELECT g.user_id AS id FROM guests g JOIN users u ON u.id = g.user_id
        WHERE g.place_kind = ? AND g.place_id = ? AND g.off_with_place IS NOT NULL AND u.guest = 1 AND u.status = 'disabled' AND u.deleted_at IS NULL
        ORDER BY g.off_with_place, g.user_id`).all(place.kind, place.id) as { id: string }[]).map((r) => r.id)
      for (const id of ids) {
        let on = false
        ctx.db.transaction(() => {
          if (!ctx.db.query("SELECT 1 FROM guests g JOIN users u ON u.id = g.user_id WHERE g.user_id = ? AND g.off_with_place IS NOT NULL AND u.status = 'disabled' AND u.deleted_at IS NULL").get(id)) return
          if (!inPlaceEvenIfOff(ctx.db, id)) return
          // the plan's guests: one who would go over it stays off (an admin can switch them on after making room)
          const max = guestLimit()
          if (max !== null && guestsUsed(ctx.db) + 1 > max) return
          ctx.db.query("UPDATE users SET status = 'active' WHERE id = ?").run(id)
          ctx.db.query('UPDATE guests SET off_with_place = NULL WHERE user_id = ?').run(id)
          audit(ctx.db, { actor: actorId, action: 'user.update', target: id, detail: { status: 'active', why: 'guest_place_back' } })
          on = true
        }).immediate()
        if (on) back.push(id)
      }
    } catch (e) { ctx.log.warn('guests not switched on with their place', { err: e }) }
  }
  return back
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
