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
 * nothing about it; `canAsk` when a request is possible (false for every reason alike: a chat or project that is never
 * shared, a confidential chat, nobody left to answer, the owner or an admin who adds themselves), `askedAt` while
 * their ask of this kind waits. 'unknown': no such chat or project (or one in the trash, or a chat of one in the
 * trash). Guests: 403, as on a file's link. At most 60 reads a minute per person (429).
 */
export const LinkAccessView = z.discriminatedUnion('status', [
  z.object({ status: z.literal('open') }),
  z.object({ status: z.literal('no_access'), canAsk: z.boolean(), askedAt: z.string().nullable() }),
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

/**
 * GET /api/chats/:id/file-access?path=: what the side panel offers someone in a chat shared with people when a file
 * link of the chat does not open for them (docs/decisions/20261121-share-chat-files.md). 'ask': the chat made this file
 * in its creator's own folder and only the creator can add it to the chat (`by`: the creator's name, `name`: the file's
 * name as the chat recorded it); 'asked': my ask waits (its date); 'copy': the chat has it as a chat file now (open
 * that). 'no': anything else, for every reason alike (not one of the chat's files, someone else's, a team folder, gone,
 * too large, a guest): it never says whether the path exists, whose it is or where. At most 60 reads a minute (429).
 */
export const ChatFileAccess = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ask'), by: z.string(), name: z.string() }),
  z.object({ status: z.literal('asked'), askedAt: z.string(), by: z.string(), name: z.string() }),
  z.object({ status: z.literal('copy'), fileId: z.string(), name: z.string() }),
  // any other team file linked in a message of the shared chat that I see, by someone who can read it: an ordinary file
  // access request, as a room message's link (by: who answers, only when that is the person who linked it)
  z.object({ status: z.literal('view'), by: z.string().nullable() }),
  z.object({ status: z.literal('viewAsked'), askedAt: z.string(), by: z.string().nullable() }),
  // it opens for me now (link: its /f/ link when only a share lets me in)
  z.object({ status: z.literal('open'), link: z.string().optional() }),
  z.object({ status: z.literal('no') }),
])
export type ChatFileAccess = z.infer<typeof ChatFileAccess>
/** 'sent' or 'already' (mine still waits: its date); 'open': the chat has its copy now, or the file opens for me (link:
 * its /f/ link when only a share lets me in) */
export const ChatFileRequestResult = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['sent', 'already']), askedAt: z.string() }),
  z.object({ status: z.literal('open'), link: z.string().optional() }),
])
export type ChatFileRequestResult = z.infer<typeof ChatFileRequestResult>
export const ChatFileAccessQuery = z.object({ path: z.string().min(1).max(4096) })
export const ChatFileAccessBody = z.object({ path: z.string().min(1).max(4096) }).strict()

export const ACCESS_REQUESTS = {
  chatFileAccess: endpoint({ method: 'GET', path: '/api/chats/:id/file-access', auth: 'user', owner: 'B', query: ChatFileAccessQuery, response: ChatFileAccess, summary: 'In a shared chat that I see (shared with people, or a shared project chat): what I can do about a file link of the chat that does not open for me. ask (a chat shared with people made it in its creator\'s own folder; only the creator can add it), asked (my ask waits), copy (the chat has it now: its file id); view (another team file linked in a message I see, by someone who can read it: I may ask to view it; by: who answers, only when that is the person who linked it), viewAsked (that ask waits), open (it opens for me now; link: its /f/ link when only a share lets me in) or no, the one answer for every other case (never whether the path exists, whose it is or where). At most 60 a minute (429). Anyone who cannot see the chat: its 404.' }),
  requestChatFile: endpoint({ method: 'POST', path: '/api/chats/:id/file-access', auth: 'user', owner: 'B', body: ChatFileAccessBody, response: ChatFileRequestResult, summary: 'For a path file-access answers ask for: ask the creator of a chat shared with people to add a file the chat made in their own folder to the chat (an access.requested notice in their Activity; Add to the chat runs the Share step\'s check again). For one it answers view for: a file access request (its owner, or with none the team owner and admins, answer with Share or Decline in Activity). Else 404, the same for every reason; one waiting ask per person and file; the access requests\' limits (429). open: the chat has it now, or the file opens for me (link: its /f/ link).' }),
  linkAccess: endpoint({ method: 'GET', path: '/api/link-access/:kind/:id', auth: 'user', owner: 'B', response: LinkAccessView, summary: ':kind is chat or project (else 400). What a chat or project link offers the caller when it does not open: open (it does now), no_access (canAsk, askedAt; nothing about the chat or project) or unknown. 403 for guests.' }),
  requestLinkAccess: endpoint({ method: 'POST', path: '/api/link-access/:kind/:id/request', auth: 'user', owner: 'B', body: LinkAccessRequestBody, response: LinkAccessRequestResult, summary: 'Ask to open a chat (its creator answers) or a team project (whoever changes its members). One waiting request per person and target; the file requests\' limits, counted together (429). 403 for guests and where no request is possible (access_request_off); unknown 404; someone it opens for gets open.' }),
  answerAccessRequest: endpoint({ method: 'POST', path: '/api/access-requests/:id', auth: 'user', owner: 'B', body: AccessRequestAnswerBody, response: AccessRequestAnswer, summary: 'Share or Decline on a chat or project access request (whoever may share it now). Share adds the asker by name (a chat\'s first share answers confirm with the check first). A request already answered keeps its answer; the chat or project gone: closed. 404 for anyone it did not go to.' }),
} as const
