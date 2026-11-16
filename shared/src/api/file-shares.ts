// A member shares a file they own with chosen people or groups, Drive style (QA TC-3093, docs/DECISIONS.md "A member
// shares their own files", plan docs/AGENTS/plan/20261115-1407-file-share-links.md). Owner: C
// (server/src/files/shares.ts, routes in server/src/routes/files.ts; migration 355).
//
// A file gets a link `/f/<id>` (16 random bytes, base64url) the first time someone shares it or copies its link. The
// link opens for the people the folder rules let in and for the people and groups added; everyone else gets "Ask for
// access", which the file's owner answers in Activity. The link page never shows the file's name, type or owner to
// someone it does not open for. The id endpoints serve the current bytes only (no versions, history, extracted text,
// path or folder). Search, the AI's read tools and the file list never see a file through a grant.
import { z } from 'zod'
import { RelPath } from './common'
import { endpoint, stream } from './endpoint'
import { ProjectParticipant } from './chats'

/** A link id: 22 base64url characters (16 random bytes). */
export const FileLinkId = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
export type FileLinkId = z.infer<typeof FileLinkId>
/** The web page of a file link. */
export const FILE_LINK_PATH = '/f'
export const fileLinkUrl = (id: string) => `${FILE_LINK_PATH}/${id}`
/** At most this many people and groups on one file (a group is one entry). */
export const FILE_SHARE_MAX = 50
/** A note with an access request, at most (characters). */
export const FILE_REQUEST_NOTE_MAX = 500
/** Requests from one person to one owner in a day, at most; and from one person in an hour, at most. */
export const FILE_REQUESTS_PER_OWNER_DAY = 5
export const FILE_REQUESTS_PER_HOUR = 20

export const FileLinkBody = z.object({ path: RelPath }).strict()
export const FileLink = z.object({ id: FileLinkId, url: z.string() })
export type FileLink = z.infer<typeof FileLink>

/** One person or group a file is shared with (the dialog's rows). */
export const FileShareRow = z.object({
  subjectType: z.enum(['user', 'group']), subjectId: z.string(), name: z.string(),
  title: z.string().optional(),
  avatarVersion: z.number().int().positive().optional(),
  /** a person whose account is turned off (they cannot open it now) */
  inactive: z.literal(true).optional(),
})
export type FileShareRow = z.infer<typeof FileShareRow>
/**
 * GET /api/files/shares?path=: the file's sharing as the caller may see it. `canShare`: the caller may add and remove
 * people (its owner; the team owner and admins for a team file). `owner`: who owns it (a personal file's person, or who
 * added a team file), null when nobody is known. `teamFile`: people who can open its folder can open it too. `off`:
 * the team turned off members' file sharing (a member's Share is off).
 */
export const FileShares = z.object({
  path: RelPath,
  link: FileLink.nullable(),
  canShare: z.boolean(),
  owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** the caller is the owner */
  mine: z.boolean(),
  teamFile: z.boolean(),
  off: z.literal(true).optional(),
  /** the rows: for whoever may share, and for the people in it (they see who else has it) */
  people: z.array(FileShareRow),
})
export type FileShares = z.infer<typeof FileShares>
export const FileSharesQuery = z.object({ path: RelPath })
export const PutFileSharesBody = z.object({
  path: RelPath,
  add: z.array(ProjectParticipant).max(FILE_SHARE_MAX).default([]),
  remove: z.array(ProjectParticipant).max(FILE_SHARE_MAX).default([]),
}).strict()

/**
 * GET /api/files/shared/:id: what the link page shows. 'open': the caller may open it (the name and size; `sharedBy`
 * for someone who has it by a grant, while the sharer's account is there). 'no_access': someone it does not open for,
 * with nothing about the file; `canAsk` when a request is possible (never for a guest, nor for a member's file while
 * the team switch is off), `askedAt` while their request waits. 'unknown': no such link. 'trashed': the owner's own
 * file in the trash (only its owner gets this; everyone else gets no_access).
 */
export const SharedFileView = z.discriminatedUnion('status', [
  z.object({ status: z.literal('open'), name: z.string(), size: z.number().int().nonnegative(), mime: z.string().nullable(), sharedBy: z.string().nullable(), mine: z.boolean() }),
  z.object({ status: z.literal('no_access'), canAsk: z.boolean(), askedAt: z.string().nullable() }),
  z.object({ status: z.literal('trashed') }),
  z.object({ status: z.literal('unknown') }),
])
export type SharedFileView = z.infer<typeof SharedFileView>
export const SharedFileDownloadQuery = z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment') })
export const FileAccessRequestBody = z.object({ message: z.string().max(FILE_REQUEST_NOTE_MAX).optional() }).strict()
export const FileAccessRequestResult = z.object({ status: z.enum(['sent', 'already']), askedAt: z.string() })
export const FileRequestAnswerBody = z.object({ answer: z.enum(['approve', 'decline']) }).strict()
export const FileRequestAnswer = z.object({ state: z.enum(['approved', 'declined', 'closed']) })
/** Admin › Team settings: how many file shares there are (the team owner's "Remove all file shares" confirm). */
export const FileSharesCount = z.object({ files: z.number().int().nonnegative(), people: z.number().int().nonnegative() })

export const FILE_SHARES = {
  fileLink: endpoint({ method: 'POST', path: '/api/files/link', auth: 'user', owner: 'C', body: FileLinkBody, response: FileLink, summary: 'The /f/<id> link of a file the caller can open (made on first use; making it never makes anyone the owner). Folders: 400 is_folder.' }),
  fileShares: endpoint({ method: 'GET', path: '/api/files/shares', auth: 'user', owner: 'C', query: FileSharesQuery, response: FileShares, summary: 'Who a file the caller can open is shared with, whether they may change it, and its owner.' }),
  putFileShares: endpoint({ method: 'PUT', path: '/api/files/shares', auth: 'user', owner: 'C', body: PutFileSharesBody, response: FileShares, summary: 'Add or remove people and groups on a file (view only). Its owner (edit access now), or the team owner and admins for a team file; never a folder (400 is_folder), never a guest (400 unknown_subject). 403 file_share_not_owner, file_shares_off. Takes from the room sending budget (429). Audited; each person added gets an Activity notice.' }),
  sharedFile: endpoint({ method: 'GET', path: '/api/files/shared/:id', auth: 'user', owner: 'C', response: SharedFileView, summary: 'What a file link shows the caller: open (name, size), no_access (nothing about the file), trashed (its owner only) or unknown.' }),
  sharedFileDownload: endpoint({ method: 'GET', path: '/api/files/shared/:id/download', auth: 'user', owner: 'C', query: SharedFileDownloadQuery, response: stream(true), summary: 'The current bytes of a file by its link, for someone it opens for (checked on every request); 404 otherwise. No versions, history or text.' }),
  requestFileAccess: endpoint({ method: 'POST', path: '/api/files/shared/:id/request', auth: 'user', owner: 'C', body: FileAccessRequestBody, response: FileAccessRequestResult, summary: 'Ask the file\'s owner (or, with none, the team owner and admins) to open it. One waiting request per person and file; 5 a day to one owner and 20 an hour in all (429). Not for guests, nor for a member\'s file while members\' file sharing is off (403 file_request_off); unknown links 404.' }),
  answerFileRequest: endpoint({ method: 'POST', path: '/api/files/requests/:id', auth: 'user', owner: 'C', body: FileRequestAnswerBody, response: FileRequestAnswer, summary: 'Share or Decline on an access request (whoever may share the file now). A request already answered keeps its answer; the file gone: closed.' }),
  fileSharesCount: endpoint({ method: 'GET', path: '/api/admin/file-shares', auth: 'admin', owner: 'C', response: FileSharesCount, summary: 'How many files are shared one by one and with how many people (the team owner\'s Remove all).' }),
  removeAllFileShares: endpoint({ method: 'DELETE', path: '/api/admin/file-shares', auth: 'admin', owner: 'C', response: FileSharesCount, summary: 'The team owner removes every file share and waiting request at once (403 owner_only for admins). Audited with the counts.' }),
} as const
