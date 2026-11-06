// The people directory and profiles (docs/DECISIONS.md "프로필과 사람 목록"). Owner: A (server/src/routes/people.ts).
// Every signed-in member may read the directory: a name, a title, a one-line status and a photo version. Never an email,
// a role or a group (those stay with admins, Admin › People).
import { z } from 'zod'
import { UserId } from '../ids'
import { AVATAR_MAX_BYTES, PROFILE_STATUS_MAX, PROFILE_TITLE_MAX } from '../avatar'
import { PersonName } from './auth'
import { binary, empty, endpoint, stream } from './endpoint'

/** One person in the directory. `avatarVersion` is absent without a photo; with it the photo is at /api/people/:id/avatar?v=<it>. */
export const Person = z.object({
  id: UserId,
  name: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  avatarVersion: z.number().int().positive().optional(),
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

export const PEOPLE = {
  listPeople: endpoint({ method: 'GET', path: '/api/people', auth: 'user', owner: 'A', response: PeopleResponse, summary: 'The people of the team (name, title, status, photo version); no emails, roles or groups; deactivated people left out.' }),
  personAvatar: endpoint({ method: 'GET', path: '/api/people/:id/avatar', auth: 'user', owner: 'A', query: AvatarVersionQuery, response: stream(false), summary: 'A person\'s profile photo (members only; cached for a year when ?v= is the current version); 404 without a photo.' }),
  updateMyProfile: endpoint({ method: 'PATCH', path: '/api/me/profile', auth: 'user', owner: 'A', body: UpdateProfileBody, response: MyProfile, summary: 'Change own name, title and one-line status (length-limited; audited). Nobody can change another person\'s profile.' }),
  putMyAvatar: endpoint({ method: 'PUT', path: '/api/me/avatar', auth: 'user', owner: 'A', query: AvatarQuery, body: binary(AVATAR_MAX_BYTES), response: AvatarInfo, summary: 'Set own profile photo: a square PNG, JPEG or WebP of 64–512 px, up to 256 KiB; metadata is cut out; audited.' }),
  deleteMyAvatar: endpoint({ method: 'DELETE', path: '/api/me/avatar', auth: 'user', owner: 'A', response: empty, status: 204, summary: 'Remove own profile photo; audited.' }),
} as const
