// The people directory and profiles (docs/DECISIONS.md "프로필과 사람 목록"). Owner: A (server/src/routes/people.ts).
// Every signed-in member may read the directory: a name, a title, a one-line status (unused), a photo version and the
// status message now. Never an email, a role or a group (those stay with admins, Admin › People).
import { z } from 'zod'
import { UserId } from '../ids'
import { AVATAR_MAX_BYTES, PROFILE_STATUS_MAX, PROFILE_TITLE_MAX } from '../avatar'
import { PersonName } from './auth'
import { binary, empty, endpoint, stream } from './endpoint'
import { MyStatus, SetStatusBody, StatusMessage } from './status-message'


/** One person in the directory. `avatarVersion` is absent without a photo; with it the photo is at /api/people/:id/avatar?v=<it>. */
export const Person = z.object({
  id: UserId,
  name: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  avatarVersion: z.number().int().positive().optional(),
  /** their status message now (docs/DECISIONS.md "상태 메시지"): absent without one, before its first day and after it
   * cleared */
  statusMessage: StatusMessage.optional(),
})
export type Person = z.infer<typeof Person>
export const PeopleResponse = z.object({ people: z.array(Person) })
export type PeopleResponse = z.infer<typeof PeopleResponse>

/** PATCH /api/me/profile: only what is sent changes; an empty title or status clears it. */
export const UpdateProfileBody = z.object({
  name: PersonName.optional(),
  title: z.string().trim().max(PROFILE_TITLE_MAX).optional(),
  status: z.string().trim().max(PROFILE_STATUS_MAX).optional(),
}).strict()
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>
/** The profile as saved. */
export const MyProfile = Person
/** PUT /api/me/avatar?type=<the image's type>: the stored photo's version. */
export const AvatarQuery = z.object({ type: z.string().min(1).max(100) })
export const AvatarInfo = z.object({ avatarVersion: z.number().int().positive() })
export type AvatarInfo = z.infer<typeof AvatarInfo>
/** GET /api/people/:id/avatar */
export const AvatarVersionQuery = z.object({ v: z.string().max(20).optional() })

// Online status (docs/DECISIONS.md "접속 상태"): a dot on a person's picture. Only the state goes over the wire (the
// WebSocket's `presence` control frame, shared/src/api/ws.ts): never a device, a window count or a time.
/** online: a window of theirs is open and in use; away: open but idle (or they set themselves away); offline: none open */
export const PresenceState = z.enum(['online', 'away', 'offline'])
export type PresenceState = z.infer<typeof PresenceState>
/** What one window says about itself: in use, or idle (no input for 10 minutes; a phone's page hidden). */
export const WindowActivity = z.enum(['active', 'idle'])
export type WindowActivity = z.infer<typeof WindowActivity>
/** PUT /api/me/away: set yourself away (kept until you change it, also across devices and sign-ins), or back to
 * automatic. The answer is what is kept. */
export const SetAwayBody = z.object({ away: z.boolean() }).strict()
export type SetAwayBody = z.infer<typeof SetAwayBody>

export const PEOPLE = {
  listPeople: endpoint({ method: 'GET', path: '/api/people', auth: 'user', owner: 'A', response: PeopleResponse, summary: 'The people of the team (name, title, status, photo version); no emails, roles or groups; deactivated people left out.' }),
  personAvatar: endpoint({ method: 'GET', path: '/api/people/:id/avatar', auth: 'user', owner: 'A', query: AvatarVersionQuery, response: stream(false), summary: 'A person\'s profile photo (members only; cached for a year when ?v= is the current version); 404 without a photo.' }),
  updateMyProfile: endpoint({ method: 'PATCH', path: '/api/me/profile', auth: 'user', owner: 'A', body: UpdateProfileBody, response: MyProfile, summary: 'Change own name, title and one-line status (length-limited; audited). Nobody can change another person\'s profile.' }),
  putMyAvatar: endpoint({ method: 'PUT', path: '/api/me/avatar', auth: 'user', owner: 'A', query: AvatarQuery, body: binary(AVATAR_MAX_BYTES), response: AvatarInfo, summary: 'Set own profile photo: a square PNG, JPEG or WebP of 64–512 px, up to 256 KiB; metadata is cut out; audited.' }),
  deleteMyAvatar: endpoint({ method: 'DELETE', path: '/api/me/avatar', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Remove own profile photo; audited.' }),
  setMyStatus: endpoint({ method: 'PUT', path: '/api/me/status', auth: 'user', owner: 'A', body: SetStatusBody, response: MyStatus, summary: 'Set your status message: one emoji, up to 100 characters of text, and when it clears (30 minutes to 2 hours, the end of today or this week in the team\'s time zone, chosen days, or never); only your own. The team sees it beside your name.' }),
  clearMyStatus: endpoint({ method: 'DELETE', path: '/api/me/status', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Clear your status message (also one that starts later); only your own.' }),
  setMyAway: endpoint({ method: 'PUT', path: '/api/me/away', auth: 'user', owner: 'A', body: SetAwayBody, response: SetAwayBody, summary: 'Set yourself away (your dot shows away to the team until you change it) or back to automatic; only your own.' }),
} as const
