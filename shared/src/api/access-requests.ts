// "Ask for access" on a chat's or a project's link (QA TC-4185, TC-4186; docs/decisions/
// 20261116-chat-project-ask-access.md). Owner: B (server/src/chat/access-requests.ts, routes in
// server/src/routes/chats.ts; migration 411).
//
// A teammate who opens /c/<id> or /projects/<id> and is not let in reads, as on a file's link (file-shares.ts
// SharedFileView), only whether they may ask and whether they asked: never the title, the creator or who is in it.
// The chat's creator (a chat outside projects), or whoever changes a team project's members, answers in Activity with
// Share or Decline. The limits are the file requests' own, counted together: one waiting ask per person and chat or
// project, FILE_REQUESTS_PER_OWNER_DAY a day to one owner and FILE_REQUESTS_PER_HOUR an hour in all.
import { z } from 'zod'
import { endpoint } from './endpoint'
import { ShareCheck } from './chats'
import { FILE_REQUEST_NOTE_MAX } from './file-shares'

/** What a link asks for: a chat (/c/<id>) or a project (/projects/<id>). */
export const AccessKind = z.enum(['chat', 'project'])
export type AccessKind = z.infer<typeof AccessKind>
/** A chat's or project's id as a link carries it (checked by the route: anything else is unknown). */
export const ACCESS_TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * GET /api/link-access/:kind/:id: what the link's page offers someone the chat or project did not open for.
 * 'open': it opens for them now (the page loads it again; a project the owner or an admin manages counts). 'no_access':
 * nothing about it; `canAsk` when a request is possible, `askedAt` while theirs waits; `why` when no request is
 * possible because of what it is ('not_shareable': a chat that is never shared with people: one in a personal project,
 * a scheduled task's run, a room's side chat, a private chat in a team project, while safe operations are on; or a
 * personal project), so the page can say so without a button. 'unknown': no such chat or project (or one in the
 * trash). Guests: 403, as on a file's link.
 */
export const LinkAccessView = z.discriminatedUnion('status', [
  z.object({ status: z.literal('open') }),
  z.object({ status: z.literal('no_access'), canAsk: z.boolean(), askedAt: z.string().nullable(), why: z.enum(['not_shareable']).optional() }),
  z.object({ status: z.literal('unknown') }),
])
export type LinkAccessView = z.infer<typeof LinkAccessView>
export const LinkAccessRequestBody = z.object({ message: z.string().max(FILE_REQUEST_NOTE_MAX).optional() }).strict()
/** 'open': they have it now (nothing asked); 'already': theirs still waits (its date) */
export const LinkAccessRequestResult = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['sent', 'already']), askedAt: z.string() }),
  z.object({ status: z.literal('open') }),
])
export type LinkAccessRequestResult = z.infer<typeof LinkAccessRequestResult>
/** Share or Decline. A chat's first share with someone runs the Share dialog's check (chat/people-share.ts): the answer
 * is then 'confirm' with what the asker would start to see and the key the Share again carries. */
export const AccessRequestAnswerBody = z.object({ answer: z.enum(['approve', 'decline']), confirmKey: z.string().max(200).optional() }).strict()
export const AccessRequestAnswer = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['approved', 'declined', 'closed']) }),
  z.object({ state: z.literal('confirm'), check: ShareCheck, confirmKey: z.string() }),
])
export type AccessRequestAnswer = z.infer<typeof AccessRequestAnswer>

export const ACCESS_REQUESTS = {
  linkAccess: endpoint({ method: 'GET', path: '/api/link-access/:kind/:id', auth: 'user', owner: 'B', response: LinkAccessView, summary: ':kind is chat or project (else 400). What a chat or project link offers the caller when it does not open: open (it does now), no_access (canAsk, askedAt; nothing about the chat or project) or unknown. 403 for guests.' }),
  requestLinkAccess: endpoint({ method: 'POST', path: '/api/link-access/:kind/:id/request', auth: 'user', owner: 'B', body: LinkAccessRequestBody, response: LinkAccessRequestResult, summary: 'Ask to open a chat (its creator answers) or a team project (whoever changes its members). One waiting request per person and target; the file requests\' limits, counted together (429). 403 for guests and where no request is possible (access_request_off); unknown 404; someone it opens for gets open.' }),
  answerAccessRequest: endpoint({ method: 'POST', path: '/api/access-requests/:id', auth: 'user', owner: 'B', body: AccessRequestAnswerBody, response: AccessRequestAnswer, summary: 'Share or Decline on a chat or project access request (whoever may share it now). Share adds the asker by name (a chat\'s first share answers confirm with the check first). A request already answered keeps its answer; the chat or project gone: closed. 404 for anyone it did not go to.' }),
} as const
