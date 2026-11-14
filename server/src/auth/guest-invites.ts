// Guest invites (docs/DECISIONS.md "Guests: only what they were invited to"). An invite with role 'guest' opens ONE
// place (a group chat or a project) and carries the guest's AI choice. Who may make one:
//   - a group chat (rooms.kind 'group', not archived): anyone in it who is not a guest (the owner and admins too, only
//     when they are in it: a group chat is its people's conversation);
//   - a project (live, not trashed): its creator while they still read its folder, or the owner or an admin;
//   - AI 'team' (a team connection under a limit): the owner or an admin only, and the connection must be a team one.
// The same rule is checked again when the invite is accepted (inviteMakerOk): an inviter who left the room, lost the
// project or was demoted cannot still let a guest in. The plan's guest cap (auth/guests.ts assertGuestFree) is checked
// at create and inside the accept's write.
import type { Context } from 'hono'
import type { Database } from 'bun:sqlite'
import type { CreateGuestInviteBody, GuestAiChoice, GuestPlace, Invite } from '@mycel/shared/api'
import type { z } from 'zod'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { newId } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { RuleSet, atLeast, loadPrincipal } from '../policy/access'
import { assertGuestFree, projectFolder } from './guests'
import { hashToken, newToken } from './passwords'
import { authOf } from './service'

type In<T extends z.ZodType> = z.output<T>

/** The AI choice as stored in invites.guest_ai (null on member invites). */
export function parseGuestAi(s: string | null): GuestAiChoice {
  if (!s) return { mode: 'none' }
  try {
    const v = JSON.parse(s) as GuestAiChoice
    if (v.mode === 'own') return { mode: 'own' }
    if (v.mode === 'team' && typeof v.credentialId === 'string' && typeof v.limitUsd === 'number' && v.limitUsd > 0) return { mode: 'team', credentialId: v.credentialId, limitUsd: v.limitUsd }
  } catch { /* fail closed */ }
  return { mode: 'none' }
}

/** A team connection (not anyone's personal one) that exists. */
export function teamCredentialOk(db: Database, credentialId: string): boolean {
  return !!db.query('SELECT 1 FROM engine_credentials WHERE id = ? AND owner_user_id IS NULL').get(credentialId)
}

/** The place exists and is open: a live group chat, or a live project. */
export function placeAlive(db: Database, place: GuestPlace): boolean {
  if (place.kind === 'room') return !!db.query("SELECT 1 FROM rooms WHERE id = ? AND kind = 'group' AND archived_at IS NULL").get(place.id)
  return projectFolder(db, place.id) !== null
}

/**
 * May `makerId` (as they are now) let a guest into `place` with `ai`? The one rule for create and accept. A guest never
 * invites; nor does a disabled or deleted account.
 */
export function inviteMakerOk(db: Database, makerId: string | null, place: GuestPlace, ai: GuestAiChoice): boolean {
  if (!makerId) return false
  const maker = db.query("SELECT CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role, status, deleted_at FROM users WHERE id = ?").get(makerId) as { role: string; status: string; deleted_at: string | null } | null
  if (!maker || maker.status !== 'active' || maker.deleted_at || maker.role === 'guest') return false
  const staff = maker.role === 'owner' || maker.role === 'admin'
  if (!placeAlive(db, place)) return false
  if (ai.mode === 'team' && (!staff || !teamCredentialOk(db, ai.credentialId))) return false
  if (place.kind === 'room') return !!db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(place.id, makerId)
  if (staff) return true
  const p = db.query('SELECT created_by FROM projects WHERE id = ?').get(place.id) as { created_by: string | null } | null
  if (!p || p.created_by !== makerId) return false
  const me = loadPrincipal(db, makerId)
  const folder = projectFolder(db, place.id)!
  return !!me && atLeast(RuleSet.fromDb(db).access(me, folder.split('/')), 'read')
}

export interface GuestInviteFields { guest_place_kind: 'room' | 'project' | null; guest_place_id: string | null; guest_ai: string | null }
export const guestPlaceOf = (r: GuestInviteFields): GuestPlace | null =>
  r.guest_place_kind && r.guest_place_id ? { kind: r.guest_place_kind, id: r.guest_place_id } : null

/** Make a guest invite (POST /api/guest-invites, and POST /api/admin/invites with role guest). */
export function createGuestInvite(c: Context<AppEnv>, ctx: AppContext, b: In<typeof CreateGuestInviteBody>, linkBase: string, toInvite: (id: string) => Invite) {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  const ai: GuestAiChoice = b.ai
  const place = b.place
  // one answer for a place that does not exist and one the caller may not open a guest into: 403 (no probing)
  if (!inviteMakerOk(ctx.db, auth.user.id, place, ai)) fail('forbidden')
  assertGuestFree(ctx.db, locale)
  const token = newToken()
  const now = authOf(ctx).now()
  const id = newId()
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + b.expiresInHours * 3600_000).toISOString()
  ctx.db.transaction(() => {
    if (!inviteMakerOk(ctx.db, auth.user.id, place, ai)) fail('forbidden')
    assertGuestFree(ctx.db, locale)
    ctx.db.query(`INSERT INTO invites (id, role, group_ids, token_hash, created_by, created_at, expires_at, guest_place_kind, guest_place_id, guest_ai)
      VALUES (?, 'guest', '[]', ?, ?, ?, ?, ?, ?, ?)`).run(id, hashToken(token), auth.user.id, createdAt, expiresAt, place.kind, place.id, JSON.stringify(ai))
    audit(ctx.db, { actor: auth.user.id, action: 'invite.create', target: id, detail: { role: 'guest', place, ai: ai.mode, expiresAt } })
  }).immediate()
  return { invite: toInvite(id), token, url: `${linkBase}/invite/${token}` }
}

