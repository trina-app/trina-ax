// The welcome card for invited people (docs/DECISIONS.md "A welcome for invited people"). Owner: B
// (server/src/onboarding/member-welcome.ts, registered by server/src/routes/member-welcome.ts).
//
// Someone who joined with a team link, a single-use invite or an admin's "Add directly" gets one card at the top of Home
// while they joined in the last MEMBER_WELCOME_DAYS days and have not finished or hidden it: who invited them, how many
// people are here, and four rows (the rooms they are in, say hi, a photo, ask Trina what they can do here). The team's
// creator gets it once the team setup reaches its end screen ("My setup", docs/decisions/20261120-my-setup-card.md:
// kind 'owner', its 14 days from then); a new owner or admin who never had a connection of their own gets it on their
// first read, while the team setup is still open too (docs/decisions/20261128-owner-personal-onboarding.md); people
// who joined before it existed never get it. Progress and Hide are stored
// per person on the server, so they follow the person across devices. Only the caller's own card: there is no way to
// read or change anyone else's.
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
  /** 'owner': the team's owner (rows: the team setup's way back while it is open, tools, asked, photo, files; tools and
   * asked count; older servers: tools, photo, files, only tools counts); 'member' (absent from older servers): someone
   * who joined, or an admin (tools, hi and asked count) */
  kind: z.enum(['member', 'owner']).optional(),
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
   * asked: they asked Trina what they can do here; files: a file is in their My files › From this computer (the desktop
   * app's "Bring work files from this computer" row: optional, not counted; absent from older servers); tools: they
   * have a connection of their own (a listed service, Google Drive or a Google app; counted; absent from older servers) */
  steps: z.object({ rooms: z.literal(true), hi: z.boolean(), photo: z.boolean(), asked: z.boolean(), files: z.boolean().optional(), tools: z.boolean().optional() }),
  /** older servers only: an admin's "팀 파일 정리하기" row, now on Admin › Home (MemberWelcomeResponse.organizeFiles) */
  organizeFiles: z.boolean().optional(),
  /** a demo (the scripted demo build, web/demo/server.ts; a free-roam instance): no "Connect your tools" and no
   * "Open the desktop app" / files row (neither can be done there), and tools is not counted (sent done) */
  demo: z.literal(true).optional(),
  /** the caller is the owner and the team setup is open (started, neither finished nor hidden): the owner card leads
   * with its way back, and is not all set until it ends. Absent: not open, someone else, or an older server */
  setupOpen: z.literal(true).optional(),
  /** every counted row is done: the card says "You're all set" (for a few minutes, then it is gone for good) */
  allSet: z.boolean(),
})
export type MemberWelcome = z.infer<typeof MemberWelcome>

export const MemberWelcomeResponse = z.object({
  welcome: MemberWelcome.nullable(),
  /** the card was hidden while its days last and its rows are not done: Settings › Profile can show it again */
  hidden: z.boolean().optional(),
  /** an admin's "팀 파일 정리하기" on Admin › Home: no owner or admin has applied the setup's folder plan yet
   * (docs/DECISIONS.md "Setup 팀 파일: the AI proposes folders"); it opens the same 팀 파일 step. Absent from older servers. */
  organizeFiles: z.boolean().optional(),
})
export type MemberWelcomeResponse = z.infer<typeof MemberWelcomeResponse>

/** hide: the card's Hide; show: Settings › Profile's "show it again" (while its days last); asked: the "what can I do
 * here" chat was started; tools: every tool the "Connect your tools" row offers is connected by the team for everyone
 * (nothing left to connect: the row counts as done) */
export const MemberWelcomeUpdate = z.strictObject({ hide: z.literal(true).optional(), show: z.literal(true).optional(), asked: z.literal(true).optional(), tools: z.literal(true).optional() })
  .refine((b) => b.hide || b.show || b.asked || b.tools, { message: 'nothing to change' })

export const MEMBER_WELCOME = {
  getMemberWelcome: endpoint({ method: 'GET', path: '/api/me/welcome', auth: 'user', owner: 'B', response: MemberWelcomeResponse,
    summary: 'My setup card on Home (invited people, and new owners and admins) while it still shows (14 days, not hidden, not finished); else null.' }),
  updateMemberWelcome: endpoint({ method: 'PATCH', path: '/api/me/welcome', auth: 'user', owner: 'B', body: MemberWelcomeUpdate, response: MemberWelcomeResponse,
    summary: 'Hide my setup card or show it again, or record that I asked Trina what I can do here or that the team connected every tool it offers me. Mine only.' }),
} as const
