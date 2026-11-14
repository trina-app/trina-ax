// Guests (docs/DECISIONS.md "Guests: only what they were invited to"): an outside person in exactly one group chat or
// one project. The server decides everything a guest may reach (server/src/auth/guests.ts, the endpoint allow-list);
// the screens only label guests and leave out what a guest cannot use. The contract's guest fields are read here:
// Person.guest (the tag), Me.guest and User.guest (the place by name and the AI; placeOut and teamAiGone), InviteInfo.guestPlace
// and InviteInfo.reason (the invite page) and Invite.guestName (who a link is for, in the invite list).
import type { GuestAi, GuestAiChoice, GuestPlace, Invite, InviteInfo, Me, Person, User } from '@mycel/shared/api'

export type PlaceKind = GuestPlace['kind']
/** A guest's one place as the screens name it (the invite page knows no id). */
export interface GuestPlaceView { kind: PlaceKind; id?: string; name?: string }

/** The signed-in person is a guest (Me.user.role). */
export const isGuestMe = (me: Me | null | undefined): boolean => me?.user.role === 'guest'

/** A person of the directory (GET /api/people) is a guest. */
export const personIsGuest = (p: Pick<Person, 'guest'> | null | undefined): boolean => p?.guest === true

/** The signed-in guest's place and AI mode (Me.guest); null for anyone else. Team AI whose team AI account was deleted
 * (Me.guest.teamAiGone) stays 'team': the guest keeps their 트리나 place and is told AI can't answer them now. */
export function meGuest(me: Me | null | undefined): { place: GuestPlaceView | null; ai: GuestAi | undefined } | null {
  if (!isGuestMe(me)) return null
  return { place: me!.guest?.place ?? null, ai: me!.guest?.teamAiGone ? 'team' : me!.guest?.ai.mode }
}

/** The address of the signed-in guest's one place as the server names it (Me.guest.place): their room or their project;
 * null for anyone else or before the server names it. A guest opens straight into it (Slack's single-channel guests). */
export function guestPlacePath(me: Me | null | undefined): string | null {
  const place = meGuest(me)?.place
  if (!place?.id) return null
  return place.kind === 'room' ? `/rooms/${place.id}` : `/projects/${place.id}`
}

/** A guest invite's place (InviteInfo.guestPlace); null for a member invite. */
export function inviteGuest(info: InviteInfo): { place: GuestPlaceView | null } | null {
  return info.role === 'guest' ? { place: info.guestPlace ?? null } : null
}

/** Why a removed guest is not in their place (User.guest.placeOut): left it, its project in the trash, or gone. */
export type GuestPlaceOut = NonNullable<NonNullable<User['guest']>['placeOut']>

/** A guest's place and AI choice as Admin › Members shows them (User.guest), with why a removed one is not in their place
 * (`out`) and whether their Team AI's account was deleted (`aiGone`). */
export function userGuest(u: User): { place: GuestPlaceView | null; ai: GuestAiChoice | null; out: GuestPlaceOut | null; aiGone: boolean } | null {
  return u.role === 'guest' ? { place: u.guest?.place ?? null, ai: u.guest?.ai ?? null, out: u.guest?.placeOut ?? null, aiGone: u.guest?.teamAiGone === true } : null
}

/** Why an invite link does not work (InviteInfo.reason), or null while it works or when an older server does not say. */
export const inviteDeadReason = (info: InviteInfo): NonNullable<InviteInfo['reason']> | null => (info.valid ? null : info.reason ?? null)

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
/** A removed guest switched on with nothing to bring them back to (409 conflict, params.placeOut: why). */
export const GUEST_NO_PLACE = 'guest_no_place'
