// A person deletes their own account (Settings › Profile › Delete account; App Store review 5.1.1(v) and Google Play:
// an app with accounts lets people delete them inside the app, without waiting for a person). Owner: A
// (server/src/auth/deletion-requests.ts, registered by server/src/routes/auth.ts; tables:
// server/migrations/244_b_account_deletion_requests.sql, 295_b_account_deletion_due.sql).
//
// Asking needs the person's password (the re-check limit: 5 wrong tries per 15 minutes) and sets a date
// ACCOUNT_DELETION_GRACE_DAYS later. Until then the account works and the person can cancel. On that date the server
// deletes the account by itself (the hourly sweep; docs/DECISIONS.md "Self-service account deletion"). The team owner
// and the admins (an admin: members only) are told in their inbox with the date (not an OS push) and can delete it
// sooner in Admin › Members; they cannot stop it. One open request per person; asking again while one is open changes
// nothing. The owner cannot ask: their account is deleted only after they made someone else the owner, and becoming the
// owner cancels an open request.
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint } from './endpoint'

/** days between asking and the automatic deletion */
export const ACCOUNT_DELETION_GRACE_DAYS = 7

export const AccountDeletionRequest = z.object({
  /** none: no open request · pending: the account is deleted on dueAt · owner: the caller is the team owner, who cannot ask */
  state: z.enum(['none', 'pending', 'owner']),
  /** when the open request was made (pending only, null otherwise) */
  requestedAt: IsoTime.nullable(),
  /** when the account is deleted (pending only, null otherwise). Absent from older servers. */
  dueAt: IsoTime.nullable().optional(),
  /** how many days the team's activity log keeps the record of the deletion (Admin › Team settings), for the page's
   * list of what stays. Absent from older servers. */
  auditDays: z.number().int().min(1).optional(),
})
export type AccountDeletionRequest = z.infer<typeof AccountDeletionRequest>

/** the person confirmed on the page that explains what happens, with their password */
export const RequestAccountDeletionBody = z.object({ confirm: z.literal(true), password: z.string().min(1).max(256) }).strict()
export type RequestAccountDeletionBody = z.infer<typeof RequestAccountDeletionBody>

export const ACCOUNT_DELETION = {
  myDeletionRequest: endpoint({ method: 'GET', path: '/api/me/deletion-request', auth: 'user', owner: 'A', response: AccountDeletionRequest,
    summary: 'Whether my account is set to be deleted and on which date (or I am the owner, who cannot ask).' }),
  requestAccountDeletion: endpoint({ method: 'POST', path: '/api/me/deletion-request', auth: 'user', owner: 'A', body: RequestAccountDeletionBody, response: AccountDeletionRequest,
    summary: 'Delete my account in 7 days: needs my password (403 wrong, 429 after 5 wrong in 15 minutes); tells the owner (and the admins, when I am a member) in the app (metadata only); audited, idempotent. The owner gets 409.' }),
  cancelAccountDeletion: endpoint({ method: 'DELETE', path: '/api/me/deletion-request', auth: 'user', owner: 'A', response: AccountDeletionRequest,
    summary: 'Keep my account: cancels the open deletion (no-op when none is open); audited.' }),
} as const
