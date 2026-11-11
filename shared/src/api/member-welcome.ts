// The welcome card for invited people (docs/DECISIONS.md "A welcome for invited people"). Owner: B
// (server/src/onboarding/member-welcome.ts, registered by server/src/routes/member-welcome.ts).
//
// Someone who joined with a team link, a single-use invite or an admin's "Add directly" gets one card at the top of Home
// while they joined in the last MEMBER_WELCOME_DAYS days and have not finished or hidden it: who invited them, how many
// people are here, and four rows (the rooms they are in, say hi, a photo, ask Trina what they can do here). The team's
// creator never gets it (they have the welcome steps), nor people who joined before it existed. Progress and Hide are
// stored per person on the server, so they follow the person across devices. Only the caller's own card: there is no
// way to read or change anyone else's.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { endpoint } from './endpoint'
import { UserRef } from './entities'

/** The card shows for this many days after joining (the template notices wait as long, unless Connected apps is
 * opened first). */
export const MEMBER_WELCOME_DAYS = 14

/** A room the person is in: the everyone room and their team rooms (by kind: the app names the everyone room). */
export const WelcomeRoom = z.object({ id: Uuid7, kind: z.enum(['all', 'team']), name: z.string().nullable() })
export type WelcomeRoom = z.infer<typeof WelcomeRoom>

export const MemberWelcome = z.object({
  team: z.string(),
  /** who invited them (the link's or the invite's maker); null: "Add directly", or that account is gone */
  inviter: UserRef.nullable(),
  /** active people in the team, the person included */
  people: z.number().int().nonnegative(),
  /** the everyone room first, then the team rooms by name */
  rooms: z.array(WelcomeRoom),
  /** the team's owner (the no-AI row's "Tell {owner}"); null when there is none */
  owner: UserRef.nullable(),
  /** rooms: always done; hi: they wrote a message in a room; photo: they have a profile photo (optional, not counted);
   * asked: they asked Trina what they can do here */
  steps: z.object({ rooms: z.literal(true), hi: z.boolean(), photo: z.boolean(), asked: z.boolean() }),
  /** every counted row is done: the card says "You're all set" (for a few minutes, then it is gone for good) */
  allSet: z.boolean(),
})
export type MemberWelcome = z.infer<typeof MemberWelcome>

export const MemberWelcomeResponse = z.object({ welcome: MemberWelcome.nullable() })
export type MemberWelcomeResponse = z.infer<typeof MemberWelcomeResponse>

/** hide: the card's Hide (for good); asked: the "what can I do here" chat was started */
export const MemberWelcomeUpdate = z.strictObject({ hide: z.literal(true).optional(), asked: z.literal(true).optional() })
  .refine((b) => b.hide || b.asked, { message: 'nothing to change' })

export const MEMBER_WELCOME = {
  getMemberWelcome: endpoint({ method: 'GET', path: '/api/me/welcome', auth: 'user', owner: 'B', response: MemberWelcomeResponse,
    summary: 'My welcome card on Home, when I was invited and it still shows (joined in the last 14 days, not hidden, not finished); else null.' }),
  updateMemberWelcome: endpoint({ method: 'PATCH', path: '/api/me/welcome', auth: 'user', owner: 'B', body: MemberWelcomeUpdate, response: MemberWelcomeResponse,
    summary: 'Hide my welcome card, or record that I asked Trina what I can do here. Mine only.' }),
} as const
