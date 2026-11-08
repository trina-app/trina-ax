// 팀장 넘기기 (docs/DECISIONS.md "W6 — Onboarding v6: easy owner handover"). Owner: A (server/src/admin/handover.ts,
// registered by server/src/routes/admin.ts).
//
// The first account stays the owner; nobody is asked "팀장이세요?". The owner ticks "이 사람이 팀장이에요" on a
// single-use invite (admin.ts CreateInviteBody.leadFor, owner only on the server) and says who it is for. The flagged
// link only ever makes a member in the team's group, for 3 days; at most one is open. When someone joins with it, the
// owner gets a card (GET /api/admin/handover `card`), an Inbox notice ('owner.lead_joined', also pushed) and a desktop
// notification. The flag is a hint only: the role moves only with the owner's [넘기기] and password
// (admin.ts transferOwnership), which also ends the connections made with the owner's own accounts that they leave
// ticked. A hosted team gets no flag and no card until its control plane refuses owner and admin reset links (`flag`).
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { IsoTime, Ok } from './common'
import { endpoint } from './endpoint'

/** "누구에게 보내나요?": at most this many characters */
export const LEAD_FOR_MAX = 60
/** how long a flagged invite is open (hours) */
export const LEAD_INVITE_HOURS = 72

/** The owner's words for whom a lead link is: one plain line (no control or format characters, no line breaks, single
 * spaces). Shown as text only, beside facts the joiner cannot set. */
export function cleanLeadFor(s: string): string {
  return s.replace(/(?!\u200d)\p{Cf}/gu, '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim()
}
export const LeadFor = z.string().max(1000).transform(cleanLeadFor)
  .refine((s) => s.length > 0 && [...s].length <= LEAD_FOR_MAX, { message: `1-${LEAD_FOR_MAX} characters` })

/** A connection made with the owner's own account that keeps serving the team: a team AI sign-in (a Claude or ChatGPT
 * subscription; team API keys are the team's and never listed) or a Drive shared with the team. `account`: the masked
 * address of that account when known. */
export const HandoverConnectionKind = z.enum(['team_ai', 'drive_share'])
export type HandoverConnectionKind = z.infer<typeof HandoverConnectionKind>
export const HandoverConnection = z.object({
  kind: HandoverConnectionKind,
  id: z.string().min(1).max(100),
  label: z.string(),
  provider: z.enum(['claude', 'chatgpt', 'google']),
  account: z.string().nullable(),
})
export type HandoverConnection = z.infer<typeof HandoverConnection>
export const HandoverConnectionRef = z.object({ kind: HandoverConnectionKind, id: z.string().min(1).max(100) })
export type HandoverConnectionRef = z.infer<typeof HandoverConnectionRef>

/** What became of a connection the old owner asked to end, after the transfer: ended (and, for a Drive share, what
 * Google said to the revocation), gone (nothing of theirs to end any more) or failed (it keeps working; the new owner
 * can end it in Admin). A failure never undoes the transfer. */
export const EndedConnection = z.object({
  kind: HandoverConnectionKind,
  id: z.string(),
  label: z.string(),
  result: z.enum(['ended', 'gone', 'failed']),
  revoke: z.enum(['revoked', 'unavailable', 'not_needed']).optional(),
})
export type EndedConnection = z.infer<typeof EndedConnection>

/** The person who joined with the owner's lead link, as the card shows them: the owner's words (`leadFor`) beside the
 * account's own name, username and join time. */
export const LeadCard = z.object({
  inviteId: Uuid7,
  leadFor: z.string(),
  user: z.object({ id: UserId, name: z.string(), username: z.string() }),
  joinedAt: IsoTime,
  /** ✕ was pressed: Home shows no card; the Inbox notice and its [넘기기] stay */
  dismissed: z.boolean(),
})
export type LeadCard = z.infer<typeof LeadCard>

/** Who can still set an owner's or admin's password outside the app: hosted = the hosting account (the control plane's
 * reset link), server_mac = the office server Mac's admin, server = whoever runs this self-installed server. */
export const HandoverRecovery = z.enum(['hosted', 'server_mac', 'server'])
export type HandoverRecovery = z.infer<typeof HandoverRecovery>

export const HandoverState = z.object({
  /** the lead flag on invites and the card are offered on this server. false on a hosted team until its control plane
   * refuses owner and admin reset links (server.json handoverSafe): there only ··· › 팀장 넘기기 */
  flag: z.boolean(),
  recovery: HandoverRecovery.nullable(),
  /** the open lead invite (not used, revoked or expired) */
  openLead: z.object({ inviteId: Uuid7, leadFor: z.string(), expiresAt: IsoTime }).nullable(),
  /** someone joined with my lead link, while that still holds: I flagged it, I am still the owner, they are active */
  card: LeadCard.nullable(),
  /** my own connections that the confirm dialog lists (each starts ticked: ended at the transfer) */
  connections: z.array(HandoverConnection),
})
export type HandoverState = z.infer<typeof HandoverState>

export const DismissLeadBody = z.object({ inviteId: Uuid7 })

export const HANDOVER = {
  handoverState: endpoint({ method: 'GET', path: '/api/admin/handover', auth: 'owner', owner: 'A', response: HandoverState, summary: 'The owner\'s handover state: whether the lead flag is offered, the open lead invite, the card of who joined with it, and the owner\'s own connections the confirm lists.' }),
  dismissLeadCard: endpoint({ method: 'POST', path: '/api/admin/handover/dismiss', auth: 'owner', owner: 'A', body: DismissLeadBody, response: Ok, summary: 'Hide the handover card on Home (✕); the Inbox notice stays; audited.' }),
} as const
