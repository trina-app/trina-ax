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
import { RunStepFixResult } from './entities'
import { ProjectParticipant } from './chats'

/** A link id: 22 base64url characters (16 random bytes). */
export const FileLinkId = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
export type FileLinkId = z.infer<typeof FileLinkId>
/** The web page of a file link. */
export const FILE_LINK_PATH = '/f'
export const fileLinkUrl = (id: string) => `${FILE_LINK_PATH}/${id}`
/** The web page of one Share press's files (a notice of several files). */
export const fileBatchUrl = (id: string) => `${FILE_LINK_PATH}/batch/${id}`
/** At most this many people and groups on one file (a group is one entry; so is "Everyone on the team"). */
export const FILE_SHARE_MAX = 50
/** "Everyone on the team" (docs/decisions/20261116-file-share-everyone.md): a group entry with this id stands for every
 * active member of the team, now and later, never a guest. No real group has it (group ids are uuids). Stored as a
 * group grant, so every way a grant goes (removed, a move or a folder save narrowing, Remove all, the trash, a purge)
 * takes it with the rest. */
export const FILE_SHARE_EVERYONE = '*'
/** At most this many files in one press of Share (Find work files' step; the same as one add's files). */
export const FILE_SHARE_BATCH_MAX = 100
/** A note with an access request, at most (characters). */
export const FILE_REQUEST_NOTE_MAX = 500
/** Requests from one person to one owner in a day, at most; and from one person in an hour, at most. */
export const FILE_REQUESTS_PER_OWNER_DAY = 5
export const FILE_REQUESTS_PER_HOUR = 20

// ---- a folder in a person's own files (docs/decisions/20261116-folder-share-server.md) ----
/** At most this many people and groups on one shared folder (the same as a file's). */
export const FOLDER_SHARE_MAX = FILE_SHARE_MAX
/** At most this many shared folders (with people on them) per owner. */
export const FOLDER_SHARES_PER_OWNER = 100
/** A listing of a shared folder: one level a call, at most this many entries a page. */
export const FOLDER_LIST_PAGE = 200
/** At most this many entries of one directory are read for a listing (more: `truncated`). */
export const FOLDER_LIST_SCAN = 2_000
/** List, entry and download inside shared folders, per person and minute, together (429 above). */
export const FOLDER_OPENS_PER_MIN = 240
/** How long a removal can be undone (POST /api/files/shares/undo). */
export const SHARE_UNDO_MS = 10 * 60_000
/** The dialog's count of what a folder holds at its first level stops here (`more`). */
export const FOLDER_HOLDS_MAX = 500
/** A path inside a shared folder: '' (the folder itself) or names joined by '/'. Checked again on the server, with the
 * shared folder's own path: no '.', '..', hidden or reserved names; the whole path within the usual limits. */
export const FolderSub = z.string().max(1024)
/** Why a folder cannot be shared: the personal folder itself; a place the server keeps (downloads, exports, skills, a
 * hidden folder …); a project's folder (or one holding or inside one); a team folder (admins share those in their own
 * dialog); the server's disk keeps no creation times; a dev environment task that can write there is running. */
export const FolderShareBlock = z.enum(['root', 'system_place', 'project', 'team_folder', 'disk', 'run_active'])
export type FolderShareBlock = z.infer<typeof FolderShareBlock>

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
  /** the row is "Everyone on the team" (a group entry with id FILE_SHARE_EVERYONE) */
  everyone: z.literal(true).optional(),
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
  /** the caller may take people off (never add): whoever may share, and the file's owner always, also with the team's
   * switch off or without edit access (docs/decisions/20261116-ai-share-card-and-stop.md); older servers omit it */
  canStop: z.boolean().optional(),
  /** the rows: for whoever may share, and for the people in it (they see who else has it) */
  people: z.array(FileShareRow),
  // ---- every field below is optional: an older app still parses the answer ----
  /** absent = a file */
  kind: z.enum(['file', 'folder']).optional(),
  /** a folder: why it cannot be shared, when it cannot (Share is off with this reason) */
  blocked: FolderShareBlock.optional(),
  /** a folder whose sharing is paused (the folder on the server is not the one shared): nobody opens it until its
   * owner resumes it (PUT with `resume`) */
  paused: z.literal(true).optional(),
  /** a folder: what it holds at its first level ("3 files, 1 folder"); `more`: the count stopped at FOLDER_HOLDS_MAX */
  holds: z.object({ files: z.number().int().min(0), folders: z.number().int().min(0), more: z.boolean() }).optional(),
  /** a folder: the files AND folders inside it that have people of their own (they keep them when this share stops) */
  ownShares: z.object({
    files: z.number().int().min(0), folders: z.number().int().min(0), people: z.number().int().min(0),
    names: z.array(z.object({ name: z.string(), folder: z.boolean() })).max(5),
  }).optional(),
  /** a file or folder inside a shared folder: the folders above it that share it, nearest first (its owner only) */
  through: z.array(z.object({ path: RelPath, name: z.string(), people: z.array(FileShareRow) })).max(8).optional(),
  /** a folder: the caller has "Always allow" on for saves where more people can see (the dialog says so) */
  wideSavesOn: z.literal(true).optional(),
  /** after a PUT that removed someone: what to send to POST /api/files/shares/undo, and until when it is offered */
  undo: z.object({ id: z.string(), until: z.string() }).optional(),
})
export type FileShares = z.infer<typeof FileShares>
export const FileSharesQuery = z.object({ path: RelPath })
export const PutFileSharesBody = z.object({
  path: RelPath,
  add: z.array(ProjectParticipant).max(FILE_SHARE_MAX).default([]),
  remove: z.array(ProjectParticipant).max(FILE_SHARE_MAX).default([]),
  /** remove everyone (Stop sharing); not with `add` (400) */
  stop: z.literal(true).optional(),
  /** a paused folder: share the folder that is there now (its owner only); not with anything else (400) */
  resume: z.literal(true).optional(),
}).strict()
/** POST /api/files/shares/undo: put back what a removal took (the `undo.id` its answer gave). */
export const ShareUndoBody = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).strict()
/** The sharing after the undo; `restored`: the people and groups put back; `skipped`: those that could not be (no
 * longer on the team, a group that is gone, on it again already). */
export const ShareUndoResult = FileShares.extend({ restored: z.number().int().min(0), skipped: z.number().int().min(0) })
export type ShareUndoResult = z.infer<typeof ShareUndoResult>
/** POST /api/files/shares/take-back: take back what one share added (the `takeBack.id` on its card). `removed`: the
 * grants taken away (and, for a folder the share made, that folder); `skipped`: those that were already gone or changed. */
export const ShareTakeBackBody = ShareUndoBody
export const ShareTakeBackResult = z.object({ removed: z.number().int().min(0), skipped: z.number().int().min(0) })
export type ShareTakeBackResult = z.infer<typeof ShareTakeBackResult>

/**
 * GET /api/files/shared/:id: what the link page shows. 'open': the caller may open it (the name and size; `sharedBy`
 * for someone who has it by a grant, while the sharer's account is there). 'no_access': someone it does not open for,
 * with nothing about the file; `canAsk` when a request is possible (never for a guest, nor for a member's file while
 * the team switch is off), `askedAt` while their request waits. 'unknown': no such link. 'trashed': the owner's own
 * file in the trash (only its owner gets this; everyone else gets no_access).
 */
const SharedFileForms = z.discriminatedUnion('status', [
  // `sharedBy`: who shared it with the caller (the newest grant that counts for them, docs/decisions/
  // 20261116-files-shared-with-me.md); `formerSharer`: that grant's sharer's account is gone ("a former member")
  z.object({ status: z.literal('open'), kind: z.literal('file').optional(), name: z.string(), size: z.number().int().nonnegative(), mime: z.string().nullable(), sharedBy: z.string().nullable(), formerSharer: z.literal(true).optional(), mine: z.boolean() }),
  // `stoppedBy`: who stopped sharing it with the caller (their name), while nothing shares it with them again
  z.object({ status: z.literal('no_access'), canAsk: z.boolean(), askedAt: z.string().nullable(), stoppedBy: z.string().optional() }),
  z.object({ status: z.literal('trashed') }),
  z.object({ status: z.literal('unknown') }),
])
/** A shared folder that opens for the caller: its name and who shared it. What is inside comes from
 * GET /api/files/shared/:id/list. Someone it does not open for gets `no_access`, exactly as for a file. */
export const SharedFolderOpen = z.object({ status: z.literal('open'), kind: z.literal('folder'), name: z.string(), sharedBy: z.string().nullable(), formerSharer: z.literal(true).optional(), mine: z.boolean() })
export const SharedFileView = z.union([SharedFileForms, SharedFolderOpen])
export type SharedFileView = z.infer<typeof SharedFileView>
/** `sub`: for a folder link, the file inside it (required there; refused for a file link) */
export const SharedFileDownloadQuery = z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment'), sub: FolderSub.optional() })
/** GET /api/files/shared/:id/list: one level of a shared folder. `sub`: the folder inside it to list ('' = the shared
 * folder itself); `cursor`: the `next` of the page before. */
export const SharedFolderQuery = z.object({ sub: FolderSub.default(''), cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(FOLDER_LIST_PAGE).default(FOLDER_LIST_PAGE) })
export const SharedFolderItem = z.object({ name: z.string(), dir: z.boolean(), size: z.number().int().min(0).nullable(), modifiedAt: z.string(), mime: z.string().nullable() })
export type SharedFolderItem = z.infer<typeof SharedFolderItem>
export const SharedFolderList = z.object({
  /** from the shared folder down to `sub`: names only, never anything above the shared folder */
  crumbs: z.array(z.string()).max(64),
  /** folders first, then by name */
  items: z.array(SharedFolderItem),
  next: z.string().nullable(),
  /** the directory holds more entries than the server reads for a listing (FOLDER_LIST_SCAN) */
  truncated: z.literal(true).optional(),
})
export type SharedFolderList = z.infer<typeof SharedFolderList>
/** GET /api/files/shared/:id/entry: one file inside a shared folder (the file view of the link page). */
export const SharedFolderEntryQuery = z.object({ sub: FolderSub.min(1) })
export const SharedFolderEntry = z.object({ name: z.string(), size: z.number().int().min(0), mime: z.string().nullable() })
export type SharedFolderEntry = z.infer<typeof SharedFolderEntry>
export const FileAccessRequestBody = z.object({ message: z.string().max(FILE_REQUEST_NOTE_MAX).optional() }).strict()
export const FileAccessRequestResult = z.object({ status: z.enum(['sent', 'already']), askedAt: z.string() })
/** POST /api/files/shared/:id/ask-for: someone who can open the file but may not share it asks its owner to share it
 * with these people (user ids; the Share dialog's "Ask <owner>"). `asked`: requests made now; `already`: waiting ones. */
export const FileAskForBody = z.object({ people: z.array(z.string().min(1).max(64)).min(1).max(20) }).strict()
export const FileAskForResult = z.object({ asked: z.number().int().min(0), already: z.number().int().min(0) })
export type FileAskForResult = z.infer<typeof FileAskForResult>
export const FileRequestAnswerBody = z.object({ answer: z.enum(['approve', 'decline']) }).strict()
export const FileRequestAnswer = z.object({ state: z.enum(['approved', 'declined', 'closed']) })
/** POST /api/files/shares/batch: share several files with the same people and groups in one press (Find work files'
 * step). Each file is the PUT's add with its own rules (owner, team switch, 50, refusals); one send token per 10
 * files of the press, taken first, and the people checked only when a file is one the caller may share; each person newly given access gets ONE notice (and one push when added by name): a single file reads as
 * before, several as "<name> shared 5 files with you", which opens the list (GET /api/files/shared-batch/:id). */
export const ShareFilesBatchBody = z.object({
  paths: z.array(RelPath).min(1).max(FILE_SHARE_BATCH_MAX),
  add: z.array(ProjectParticipant).min(1).max(FILE_SHARE_MAX),
}).strict()
export const ShareFilesBatchResult = z.object({
  shared: z.array(RelPath),
  /** the files not shared, each with the server's words (and its reason code when there is one) */
  failed: z.array(z.object({ path: RelPath, message: z.string(), reason: z.string().optional() })),
})
export type ShareFilesBatchResult = z.infer<typeof ShareFilesBatchResult>
/** A batch's id: 22 base64url characters, as a link's. */
export const FileShareBatchId = FileLinkId
/** GET /api/files/shared-batch/:id: the files of one press that the caller can open now (the notice's list); only for
 * someone the press told (404 otherwise). `by`: who shared them, while their account is there. */
export const SharedBatchView = z.object({
  by: z.string().nullable(),
  files: z.array(z.object({ linkId: FileLinkId, name: z.string(), size: z.number().int().nonnegative() })),
})
export type SharedBatchView = z.infer<typeof SharedBatchView>
/** Files › Shared with me (docs/decisions/20261116-files-shared-with-me.md): one file a grant gives the caller now. The
 * name is the file's own name (no path, folder or owner); `sharedBy` null: the sharer's account is gone ("A former
 * member"); `sharedAt`: when that grant was made. A row opens its link page, /f/<linkId>. */
export const SharedWithMeItem = z.object({ linkId: FileLinkId, name: z.string(), sharedBy: z.string().nullable(), sharedAt: z.string(),
  /** absent = a file; 'folder': a shared folder (its link page lists it) */
  kind: z.enum(['file', 'folder']).optional() })
export type SharedWithMeItem = z.infer<typeof SharedWithMeItem>
/** A page of Shared with me, newest first; `next`: read on from there (a page may be short, even empty, while `next`
 * is set: the server stops after a bounded amount of work) */
export const SharedWithMe = z.object({ items: z.array(SharedWithMeItem), next: z.string().nullable() })
export type SharedWithMe = z.infer<typeof SharedWithMe>
export const SharedWithMeQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(50) })

/** POST /api/files/shares/cards: the files of an AI share card (api/share-card.ts) as the caller may see them now, by
 * link id. `gone`: no such link, the file is gone, the folder rules do not let the caller read it, or the caller may
 * neither add nor take off people (nothing about it). */
export const ShareCardsBody = z.object({ ids: z.array(FileLinkId).min(1).max(10) }).strict()
export const ShareCardState = z.union([
  z.object({ id: FileLinkId, gone: z.literal(true) }),
  z.object({ id: FileLinkId, path: RelPath, name: z.string(), canShare: z.boolean(), canStop: z.boolean(), people: z.array(FileShareRow) }),
])
export type ShareCardState = z.infer<typeof ShareCardState>
export const ShareCardStates = z.object({ items: z.array(ShareCardState) })
/** GET /api/files/granted-link */
export const GrantedFileLink = z.object({ id: z.string().nullable() })
export type GrantedFileLink = z.infer<typeof GrantedFileLink>

/** Admin › Team settings: how many file shares there are (the team owner's "Remove all file shares" confirm). */
export const FileSharesCount = z.object({ files: z.number().int().nonnegative(), people: z.number().int().nonnegative(),
  /** how many shared folders there are (counted apart from `files`) */
  folders: z.number().int().nonnegative().optional() })

export const FILE_SHARES = {
  fileLink: endpoint({ method: 'POST', path: '/api/files/link', auth: 'user', owner: 'C', body: FileLinkBody, response: FileLink, summary: 'The /f/<id> link of a file the caller can open (made on first use; making it never makes anyone the owner). A folder in the caller\'s own files, once folder sharing is on: its owner only, and only a folder that can be shared (400 folder_share_place, folder_share_disk); every other folder: 400 is_folder.' }),
  fileShares: endpoint({ method: 'GET', path: '/api/files/shares', auth: 'user', owner: 'C', query: FileSharesQuery, response: FileShares, summary: 'Who a file the caller can open is shared with, whether they may change it, and its owner. A folder in the caller\'s own files, once folder sharing is on: the same with kind folder, what it holds, and why it cannot be shared when it cannot (blocked); every other folder: 400 is_folder.' }),
  putFileShares: endpoint({ method: 'PUT', path: '/api/files/shares', auth: 'user', owner: 'C', body: PutFileSharesBody, response: FileShares, summary: 'Add or remove people and groups on a file (view only). Its owner (edit access now), or the team owner and admins for a team file; never a folder (400 is_folder), never a guest (400 unknown_subject). 403 file_share_not_owner, file_shares_off. Takes from the room sending budget (429) before the people are checked, once the file is one the caller may share. Audited; each person added gets an Activity notice. Removing people and `stop` (everyone) are always the owner\'s, also while members\' sharing is off or without edit access, and answer with `undo`. A folder in the caller\'s own files (view only for the people added, files added later included): 400 folder_share_place, folder_share_disk, file_share_full; `resume` for a paused folder.' }),
  takeBackFileShares: endpoint({ method: 'POST', path: '/api/files/shares/take-back', auth: 'user', owner: 'C', body: ShareTakeBackBody, response: ShareTakeBackResult, summary: 'Take back what one AI share added, by the take-back id on its card: for 10 minutes, once, only for the person who shared. Removes only the grants that share added (never access a person had before it) and, for a folder the share made from chat files, stops that folder\'s sharing and deletes the folder and the copies it made (unchanged ones). 404 for an id that is unknown, someone else\'s, used or expired.' }),
  undoFileShares: endpoint({ method: 'POST', path: '/api/files/shares/undo', auth: 'user', owner: 'C', body: ShareUndoBody, response: ShareUndoResult, summary: 'Put back the people and groups a removal took off a file or folder, by the undo id that removal answered with: for 10 minutes, once, only for the person who removed them. Restores those still valid (an active member, a group that exists), dated at the undo (they had no access in between), tells nobody, takes no sending budget and does not ask the team switch; says how many it skipped. 404 for an id that is unknown, someone else\'s, used, expired, or older than the team owner\'s Remove all.' }),
  shareCards: endpoint({ method: 'POST', path: '/api/files/shares/cards', auth: 'user', owner: 'C', body: ShareCardsBody, response: ShareCardStates, summary: 'The files of an AI share card as the caller may see them now, by link id: path, people and whether the caller may add or take people off; `gone` for anything the folder rules do not let them read or whose people they may not change. Reads only.' }),
  shareFilesBatch: endpoint({ method: 'POST', path: '/api/files/shares/batch', auth: 'user', owner: 'C', body: ShareFilesBatchBody, response: ShareFilesBatchResult, summary: 'Share up to 100 files with the same people and groups in one press (Find work files\' step): each file as PUT /api/files/shares add (owner, team switch, 50, never a guest), the files refused listed with the server\'s words. One send token per 10 files, taken first (429); the people are checked only when one of the files is one the caller may share. Audited per file; each person newly given access gets one notice for the press (one push when added by name).' }),
  sharedBatch: endpoint({ method: 'GET', path: '/api/files/shared-batch/:id', auth: 'user', owner: 'C', response: SharedBatchView, summary: 'The files of one Share press that the caller can open now (a notice\'s "shared 5 files with you" list), for someone that press told; 404 otherwise.' }),
  sharedWithMe: endpoint({ method: 'GET', path: '/api/files/shared-with-me', auth: 'user', owner: 'C', query: SharedWithMeQuery, response: SharedWithMe, summary: 'Files › Shared with me: the files people shared with the caller that open for them now, newest first (by name always; through a group or the whole team only when the folder does not already let them read it). Name, who shared it and when; no path, folder or owner. Never for guests (403). A bad cursor is 400.' }),
  sharedFile: endpoint({ method: 'GET', path: '/api/files/shared/:id', auth: 'user', owner: 'C', response: SharedFileView, summary: 'What a file link shows the caller: open (name, size; a folder: kind folder and its name), no_access (nothing about the file or folder), trashed (its owner only) or unknown.' }),
  sharedFileDownload: endpoint({ method: 'GET', path: '/api/files/shared/:id/download', auth: 'user', owner: 'C', query: SharedFileDownloadQuery, response: stream(true), summary: 'The current bytes of a file by its link, for someone it opens for (checked on every request); 404 otherwise. No versions, history or text. A folder link: `sub` names the file inside it (the bytes come from the very file that was checked; 429 as the listing); `sub` on a file link is 404.' }),
  sharedFolderList: endpoint({ method: 'GET', path: '/api/files/shared/:id/list', auth: 'user', owner: 'C', query: SharedFolderQuery, response: SharedFolderList, summary: 'One level of a shared folder by its link, for someone it opens for (checked on every request): names, sizes and modified times, folders first, 200 a page. Never hidden names, links, anything above the shared folder, versions or text. 404 otherwise; 429 above 240 list, entry and download calls a minute.' }),
  sharedFolderEntry: endpoint({ method: 'GET', path: '/api/files/shared/:id/entry', auth: 'user', owner: 'C', query: SharedFolderEntryQuery, response: SharedFolderEntry, summary: 'One file inside a shared folder by the link and its path inside the folder: name, size and type. 404 when the link or the path does not open for the caller; 429 as the listing.' }),
  requestFileAccess: endpoint({ method: 'POST', path: '/api/files/shared/:id/request', auth: 'user', owner: 'C', body: FileAccessRequestBody, response: FileAccessRequestResult, summary: 'Ask the file\'s owner (or, with none, the team owner and admins) to open it. One waiting request per person and file; 5 a day to one owner and 20 an hour in all (429). Not for guests, nor for a member\'s file while members\' file sharing is off (403 file_request_off); unknown links 404.' }),
  askFileShareFor: endpoint({ method: 'POST', path: '/api/files/shared/:id/ask-for', auth: 'user', owner: 'C', body: FileAskForBody, response: FileAskForResult, summary: 'Ask the file\'s owner (or, with none, the team owner and admins) to share it with these people, view only (the Share dialog\'s "Ask <owner>"; the same request as the "Ask <owner>" step under an AI answer). For someone who can open the file and may not share it (409 file_request_can_share when they may); never for a guest; people who are guests, not active or can open it already are skipped. One request per person, answered with the owner\'s Share / Decline; the same budget as a request (429). 403 file_request_off when nobody can be asked; 404 for a link the caller cannot open.' }),
  answerFileRequest: endpoint({ method: 'POST', path: '/api/files/requests/:id', auth: 'user', owner: 'C', body: FileRequestAnswerBody, response: FileRequestAnswer, summary: 'Share or Decline on an access request (whoever may share the file now). A request already answered keeps its answer; the file gone: closed.' }),
  // one-tap next steps under an AI step, and a path link opened through a share (docs/decisions/20261116-ai-share-who-can-open.md)
  runShareFix: endpoint({ method: 'POST', path: '/api/share-fixes/:id/run', auth: 'user', owner: 'C', response: RunStepFixResult, summary: 'Run the next step the server offered under one of my AI steps (Step.fixes): "Let them view" shares the files with exactly the people the offer listed who are still in the room, active, no guests and still unable to open them (the Share dialog\'s own checks as me, via ai, audited); "Ask <owner>" sends the owner the access request for them; "Ask an admin" sends my 1:1 message about the folder to the team owner and admins. Once; only for the person the offer was made for (404 otherwise). Answers what it became: done (how many people, and how many in the room still cannot open it and were not listed), or gone (nothing left to do). A refusal of the action (403 file_share_not_owner, 429) leaves the offer open.' }),
  grantedFileLink: endpoint({ method: 'GET', path: '/api/files/granted-link', auth: 'user', owner: 'C', query: FileSharesQuery, response: GrantedFileLink, summary: 'The /f/<id> link id of the file at a team path when it opens for the caller through a file share and not through the folder (a path link in a room message, opened by someone the file was shared with); id null for everything else, a missing path and a file they may not open alike.' }),
  fileSharesCount: endpoint({ method: 'GET', path: '/api/admin/file-shares', auth: 'admin', owner: 'C', response: FileSharesCount, summary: 'How many files and folders are shared one by one and with how many people (the team owner\'s Remove all).' }),
  removeAllFileShares: endpoint({ method: 'DELETE', path: '/api/admin/file-shares', auth: 'admin', owner: 'C', response: FileSharesCount, summary: 'The team owner removes every file and folder share and waiting request at once (403 owner_only for admins); removals made before it can no longer be undone. Audited with the counts.' }),
} as const
