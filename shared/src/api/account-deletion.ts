// A person asks for their own account to be deleted ("계정 삭제 요청", Settings › Profile; App Store review 5.1.1(v):
// an app with accounts lets people start the deletion inside the app). Owner: A (server/src/auth/deletion-requests.ts,
// registered by server/src/routes/auth.ts; tables: server/migrations/241_b_account_deletion_requests.sql).
//
// Team admins make the accounts and only the team owner deletes them (Admin › Members, DELETE /api/admin/users/:id),
// so this does not delete anything: it tells the owner in their inbox (event 'account.deletion_request', not an OS
// push), with a link to the person in Admin › Members. One open request per person; asking again while one is open
// changes nothing, and asking again after a cancel re-arms the same inbox entry. The owner cannot ask: their account
// is deleted only after they made someone else the owner (Admin › Team settings). There is no fixed time: the owner
// is told and handles it; deleting the account closes the request.
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint } from './endpoint'

export const AccountDeletionRequest = z.object({
  /** none: no open request · pending: waits for the team owner · owner: the caller is the team owner, who cannot ask */
  state: z.enum(['none', 'pending', 'owner']),
  /** when the open request was made (pending only, null otherwise) */
  requestedAt: IsoTime.nullable(),
})
export type AccountDeletionRequest = z.infer<typeof AccountDeletionRequest>

/** the person confirmed on the page that explains what happens */
export const RequestAccountDeletionBody = z.object({ confirm: z.literal(true) }).strict()
export type RequestAccountDeletionBody = z.infer<typeof RequestAccountDeletionBody>

export const ACCOUNT_DELETION = {
  myDeletionRequest: endpoint({ method: 'GET', path: '/api/me/deletion-request', auth: 'user', owner: 'A', response: AccountDeletionRequest,
    summary: 'Whether I have asked the team owner to delete my account (or am the owner, who cannot ask).' }),
  requestAccountDeletion: endpoint({ method: 'POST', path: '/api/me/deletion-request', auth: 'user', owner: 'A', body: RequestAccountDeletionBody, response: AccountDeletionRequest,
    summary: 'Ask the team owner to delete my account: tells the owner in the app (metadata only), audited, idempotent. The owner gets 409.' }),
  cancelAccountDeletion: endpoint({ method: 'DELETE', path: '/api/me/deletion-request', auth: 'user', owner: 'A', response: AccountDeletionRequest,
    summary: 'Take back my open account deletion request (no-op when none is open); audited.' }),
} as const
