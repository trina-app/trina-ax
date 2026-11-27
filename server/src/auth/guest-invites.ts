// Guest invites (docs/DECISIONS.md "Guests: only what they were invited to"). An invite with role 'guest' opens ONE
// place (a group chat or a project) and carries the guest's AI choice. Who may make one:
//   - a group chat (rooms.kind 'group', not archived): anyone in it who is not a guest (the owner and admins too, only
//     when they are in it: a group chat is its people's conversation);
//   - a project (live, not trashed): its creator while they still read its folder, or the owner or an admin;
//   - AI 'team' (a team connection under a limit): the owner or an admin only, and the connection must be a team one.
// The same rule is checked again when the invite is accepted (inviteMakerOk): an inviter who left the room, lost the
// project or was demoted cannot still let a guest in. The plan's guest cap (auth/guests.ts assertGuestFree) is checked
// at create (counting the open links too: assertGuestLinkFree) and inside the accept's write.
import type { Context } from 'hono'
import type { Database } from 'bun:sqlite'
import type { CreateGuestInviteBody, GuestAiChoice, GuestPlace, Invite, Locale } from '@mycel/shared/api'
import type { z } from 'zod'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { newId } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { RuleSet, atLeast, loadPrincipal } from '../policy/access'
import { assertGuestFree, guestLimit, guestsUsed, projectFolder } from './guests'
import { AUTH_MESSAGES } from './messages'
import { planManageUrl } from '../system/limits'
import { relayLinkedProjectAt } from '../integrations/slack/relay-store'
import { hashToken, newToken } from './passwords'
import { authOf } from './service'

type In<T extends z.ZodType> = z.output<T>

/** The AI choice as stored in invites.guest_ai (null on member invites): Team AI with its token limit, or, on a link
 * made before 2026-11-15 and not used yet, its US dollar limit (accepting it then gives the guest that limit, like the
 * guests who had joined already: docs/DECISIONS.md "Guest Team AI: a token limit"). */
export function parseGuestAi(s: string | null): GuestAiChoice {
  if (!s) return { mode: 'none' }
  try {
    const v = JSON.parse(s) as GuestAiChoice
    if (v.mode === 'own') return { mode: 'own' }
    if (v.mode === 'team' && typeof v.credentialId === 'string') {
      if (Number.isInteger(v.limitTokens) && v.limitTokens! > 0) return { mode: 'team', credentialId: v.credentialId, limitTokens: v.limitTokens }
      if (typeof v.limitUsd === 'number' && v.limitUsd > 0) return { mode: 'team', credentialId: v.credentialId, limitUsd: v.limitUsd }
    }
  } catch { /* fail closed */ }
  return { mode: 'none' }
}

/** A team connection (not anyone's personal one) that exists. */
export function teamCredentialOk(db: Database, credentialId: string): boolean {
  return !!db.query('SELECT 1 FROM engine_credentials WHERE id = ? AND owner_user_id IS NULL').get(credentialId)
}

/** The place exists and is open: a live group chat, or a live project. A project's chat room is never a guest's place
 * (rooms/project-room.ts: its people are the project's; a guest gets into it through the project), also for an invite
 * made before its channel became one: create, accept and the pending count all read this. */
export function placeAlive(db: Database, place: GuestPlace): boolean {
  if (place.kind === 'room') return !!db.query("SELECT 1 FROM rooms r WHERE r.id = ? AND r.kind = 'group' AND r.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM room_project_links pl WHERE pl.room_id = r.id AND pl.mode = 'room')").get(place.id)
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
  // a personal project (its folder in users/<id>/): nobody else ever reads a personal folder, whatever rule names them
  // (policy/access.ts), so a guest let in there would land in nothing. The invite picker shares it first, as the
  // project's own "Add people" does (POST /api/projects/:id/share: it becomes a team project in projects/<name>), and
  // makes the invite after that (docs/DECISIONS.md "Guests into a personal project")
  const folder = projectFolder(db, place.id)!
  if (folder === 'users' || folder.startsWith('users/')) return false
  if (staff) return true
  const p = db.query('SELECT created_by FROM projects WHERE id = ?').get(place.id) as { created_by: string | null } | null
  if (!p || p.created_by !== makerId) return false
  const me = loadPrincipal(db, makerId)
  return !!me && atLeast(RuleSet.fromDb(db).access(me, folder.split('/')), 'read')
}

export interface GuestInviteFields { guest_place_kind: 'room' | 'project' | null; guest_place_id: string | null; guest_ai: string | null }
export const guestPlaceOf = (r: GuestInviteFields): GuestPlace | null =>
  r.guest_place_kind && r.guest_place_id ? { kind: r.guest_place_kind, id: r.guest_place_id } : null

/**
 * Guest links nobody has used yet that still work now (not turned off, not run out, their maker may still invite into
 * a place that is still open: the rule an accept checks). Each holds one of the plan's guest places (guest walkthrough
 * M4, owner decision 2026-11-15): a team can't hand out more open links than free places, so a link is refused when it
 * is made, not after its guest filled in the form. Accepting one frees its hold as the guest takes the place.
 */
export function openGuestLinks(db: Database, now: number): number {
  const rows = db.query("SELECT created_by, guest_place_kind, guest_place_id, guest_ai FROM invites WHERE role = 'guest' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
    .all(new Date(now).toISOString()) as (GuestInviteFields & { created_by: string | null })[]
  let n = 0
  for (const r of rows) {
    const place = guestPlaceOf(r)
    const ai = parseGuestAi(r.guest_ai)
    if (place && placeAlive(db, place) && !(ai.mode === 'team' && !teamCredentialOk(db, ai.credentialId)) && inviteMakerOk(db, r.created_by, place, ai)) n++
  }
  return n
}

/** Room for one more guest link: the active guests and the open links, plus this one, within the plan (409 plan_limit,
 * reason guest_limit; `pending` = the open links when they are what fills it). No plan: always. */
export function assertGuestLinkFree(db: Database, locale: Locale, now: number): void {
  assertGuestFree(db, locale)
  const max = guestLimit()
  if (max === null) return
  const pending = openGuestLinks(db, now)
  if (guestsUsed(db) + pending + 1 <= max) return
  const url = planManageUrl()
  fail('plan_limit', (AUTH_MESSAGES.guestLimitLinks[locale] ?? AUTH_MESSAGES.guestLimitLinks.en).replace('{n}', String(max)), { params: { reason: 'guest_limit', limit: max, pending, changePlan: true, ...(url ? { manageUrl: url } : {}) } })
}

/** A project whose conversation is linked to a Slack channel takes no guest (admin/folders.ts guestRulesInPlace holds
 * the same line when the rule is written): an invite to it is refused when it is made, and one made before the link
 * stops while it lasts (accounts.ts makerReason). */
export function relayBlocksGuestPlace(db: Database, place: GuestPlace): boolean {
  if (place.kind !== 'project') return false
  const folder = projectFolder(db, place.id)
  return !!folder && !!relayLinkedProjectAt(db, folder)
}
const refuseRelayGuest = () => fail('conflict', 'Disconnect Slack first to invite a guest.', { params: { reason: 'slack_relay_guest' } })

/** Make a guest invite (POST /api/guest-invites, and POST /api/admin/invites with role guest). */
export function createGuestInvite(c: Context<AppEnv>, ctx: AppContext, b: In<typeof CreateGuestInviteBody>, linkBase: string, toInvite: (id: string) => Invite) {
  const auth = c.get('auth')!
  const locale = c.get('locale')
  const ai: GuestAiChoice = b.ai
  const place = b.place
  // one answer for a place that does not exist and one the caller may not open a guest into: 403 (no probing)
  if (!inviteMakerOk(ctx.db, auth.user.id, place, ai)) fail('forbidden')
  if (relayBlocksGuestPlace(ctx.db, place)) refuseRelayGuest()
  const now = authOf(ctx).now()
  assertGuestLinkFree(ctx.db, locale, now)
  const token = newToken()
  const id = newId()
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + b.expiresInHours * 3600_000).toISOString()
  ctx.db.transaction(() => {
    if (!inviteMakerOk(ctx.db, auth.user.id, place, ai)) fail('forbidden')
    if (relayBlocksGuestPlace(ctx.db, place)) refuseRelayGuest()
    assertGuestLinkFree(ctx.db, locale, now)
    ctx.db.query(`INSERT INTO invites (id, role, group_ids, token_hash, created_by, created_at, expires_at, guest_place_kind, guest_place_id, guest_ai, guest_name)
      VALUES (?, 'guest', '[]', ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, hashToken(token), auth.user.id, createdAt, expiresAt, place.kind, place.id, JSON.stringify(ai), b.name ?? null)
    audit(ctx.db, { actor: auth.user.id, action: 'invite.create', target: id, detail: { role: 'guest', place, ai: ai.mode, expiresAt } })
  }).immediate()
  return { invite: toInvite(id), token, url: `${linkBase}/invite/${token}` }
}

