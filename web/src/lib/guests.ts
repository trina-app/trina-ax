// Guests (docs/DECISIONS.md "Guests: only what they were invited to"): an outside person in exactly one group chat or
// one project. The server decides everything a guest may reach (server/src/auth/guests.ts, the endpoint allow-list);
// the screens only label guests and leave out what a guest cannot use. The contract's guest fields are read here:
// Person.guest (the tag), Me.guest and User.guest (the place by name and the AI), InviteInfo.guestPlace (the invite
// page) and Invite.guestName (who a link is for, in the invite list).
import type { GuestAi, GuestAiChoice, GuestPlace, Invite, InviteInfo, Me, Person, User } from '@mycel/shared/api'

export type PlaceKind = GuestPlace['kind']
/** A guest's one place as the screens name it (the invite page knows no id). */
export interface GuestPlaceView { kind: PlaceKind; id?: string; name?: string }

/** The signed-in person is a guest (Me.user.role). */
export const isGuestMe = (me: Me | null | undefined): boolean => me?.user.role === 'guest'

/** A person of the directory (GET /api/people) is a guest. */
export const personIsGuest = (p: Pick<Person, 'guest'> | null | undefined): boolean => p?.guest === true

/** The signed-in guest's place and AI mode (Me.guest); null for anyone else. */
export function meGuest(me: Me | null | undefined): { place: GuestPlaceView | null; ai: GuestAi | undefined } | null {
  if (!isGuestMe(me)) return null
  return { place: me!.guest?.place ?? null, ai: me!.guest?.ai.mode }
}

/** A guest invite's place (InviteInfo.guestPlace); null for a member invite. */
export function inviteGuest(info: InviteInfo): { place: GuestPlaceView | null } | null {
  return info.role === 'guest' ? { place: info.guestPlace ?? null } : null
}

/** A guest's place and AI choice as Admin › Members shows them (User.guest). */
export function userGuest(u: User): { place: GuestPlaceView | null; ai: GuestAiChoice | null } | null {
  return u.role === 'guest' ? { place: u.guest?.place ?? null, ai: u.guest?.ai ?? null } : null
}

/** Who a guest invite link is for, in the inviter's words (Invite.guestName); null without one. */
export const inviteGuestName = (i: Invite): string | null => i.guestName?.trim() || null

/** A project as a guest's screens show it: nothing to change (its name, instructions, members, deleting or leaving it
 * are the team's; the server refuses them to a guest), only their chats and its files. */
export function guestProject<P extends { canEdit: boolean; membersEditable?: boolean; canManage?: boolean; canDelete?: boolean; leave?: 'yes' | 'last' }>(p: P): P {
  const { leave: _leave, ...rest } = p
  return { ...rest, canEdit: false, membersEditable: false, canManage: false, canDelete: false } as P
}

/** The 409 reasons of server/src/auth/guests.ts. */
export const GUEST_ONE_PLACE = 'guest_one_place'
export const GUEST_LIMIT = 'guest_limit'
