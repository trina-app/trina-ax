// The record behind an AI share card (docs/decisions/20261116-ai-share-card-and-stop.md; server/src/chat/share-card.ts,
// web components/chat/ShareCard.tsx). When the AI shares files (share_with_person) or stops sharing them (stop_sharing),
// the server writes what happened on the tool's step (`Step.shared`) and the app draws the card from it: nothing on the
// card comes from the AI's words or from a file's content. The confirmation card of the same action carries the same
// rows (`AskUserRequest.share`), so the card that asked turns into the card that says what was done.
//
// The record holds ids and the names as they were when it happened; the app reads what is true now for its button as
// the viewer (POST /api/files/shares/cards). In a chat other people see, only the person whose turn it was gets the
// record (server/src/chat/store.ts viewSteps): the others see the step's verb alone.
import { z } from 'zod'

const LinkId = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
/** files named on one card (the tools take at most 10 paths) */
export const SHARE_CARD_FILES_MAX = 10
/** people and groups named on one card; `whoMore` counts the rest */
export const SHARE_CARD_PEOPLE_MAX = 10
/** people listed as still able to open a file after a stop; `stillMore` counts the rest */
export const SHARE_CARD_STILL_MAX = 5

/** One file on the card: its link id (absent when the file never got one: a refusal before any link), its name, and
 * where it is in words ("My files › Work"), never a path. */
export const ShareCardFile = z.object({
  linkId: LinkId.optional(), name: z.string().max(255), place: z.string().max(500),
  /** a folder in the asker's own files (share_folder, server chat/share-folder.ts): what it holds at its first level, as
   * its owner sees it (`more`: more than counted). Its people view everything in it, files added later included.
   * Absent: a file */
  folder: z.object({ files: z.number().int().nonnegative(), folders: z.number().int().nonnegative(), more: z.literal(true).optional() }).optional(),
})
export type ShareCardFile = z.infer<typeof ShareCardFile>

/** One person or group on the card. `members`: how many people a group has now (the whole team: its active members). */
export const ShareCardWho = z.object({
  subjectType: z.enum(['user', 'group']), subjectId: z.string().max(64), name: z.string().max(200),
  avatarVersion: z.number().int().positive().optional(),
  everyone: z.literal(true).optional(),
  members: z.number().int().nonnegative().optional(),
})
export type ShareCardWho = z.infer<typeof ShareCardWho>

/** Someone taken off who can still open `files` of the card's files, and through what: the folder's own rules, a group
 * still on the file (`group`: its name), or the whole team. Computed by the server at the stop. */
export const ShareCardStill = z.object({
  userId: z.string().max(64), name: z.string().max(200), avatarVersion: z.number().int().positive().optional(),
  through: z.enum(['folder', 'group', 'everyone']), group: z.string().max(200).optional(),
  files: z.number().int().positive(),
})
export type ShareCardStill = z.infer<typeof ShareCardStill>

/** Why nothing (or not everything) was done. not_owner: the file is someone else's (`owner`: their name);
 * switched_off: the team turned off members' file sharing; limit: too many shares in a short time; full: the file has
 * its 50 people and groups; changed: something changed while the card waited; failed: anything else. `file`: the first
 * file it happened on. A folder (share_folder): place: it cannot be shared where it is (`block`, the Share dialog's own
 * reason: its words are the dialog's); paused: its share is paused (the folder on the disk is not the one shared). */
export const ShareCardRefusal = z.object({
  reason: z.enum(['not_owner', 'switched_off', 'limit', 'full', 'changed', 'failed', 'place', 'paused']),
  file: z.string().max(255).optional(),
  owner: z.string().max(200).optional(),
  // (api/file-shares.ts FolderShareBlock's values: that module imports entities, which imports this one)
  block: z.enum(['root', 'system_place', 'project', 'team_folder', 'disk', 'run_active']).optional(),
})
export type ShareCardRefusal = z.infer<typeof ShareCardRefusal>

/** The next step a refusal offers, as data: the app shows a button for a kind it knows (web components/chat/ShareCard.tsx
 * registerShareNext) and nothing for one it does not. ask_owner: ask the file's owner (`name`) to share it; ask_admin:
 * ask an admin (why: the offer's `reason`). `fixId`: the server's stored offer on the same step (`Step.fixes`, server
 * files/share-fixes.ts) the button runs; the app shows that offer on the card and not again under the answer. */
export const ShareCardNext = z.object({
  kind: z.enum(['ask_owner', 'ask_admin']),
  fixId: z.string().max(64).optional(),
  linkId: LinkId.optional(),
  userId: z.string().max(64).optional(),
  name: z.string().max(200).optional(),
})
export type ShareCardNext = z.infer<typeof ShareCardNext>

/** The rows of the confirmation card (`AskUserRequest.share`): what is about to be shared or stopped, and for whom. */
export const ShareCardAsk = z.object({
  op: z.enum(['share', 'stop']),
  files: z.array(ShareCardFile).max(SHARE_CARD_FILES_MAX),
  who: z.array(ShareCardWho).max(SHARE_CARD_PEOPLE_MAX),
  whoMore: z.number().int().positive().optional(),
  /** with `whoMore`: a digest of everyone the card covers, so a change among the people not shown is a different card */
  whoKey: z.string().max(64).optional(),
  /** whose files they are, when not the asker's own (an admin and a team file someone else added) */
  owner: z.object({ id: z.string().max(64), name: z.string().max(200) }).optional(),
  /** why the card asks although the person may have chosen "Always allow": the server's own sentence (rooms or a
   * shared file read in this chat, or content someone else wrote), absent when nothing like that happened */
  why: z.string().max(500).optional(),
})
export type ShareCardAsk = z.infer<typeof ShareCardAsk>

/** names listed per line of a team folder card; the rest is a count */
export const TEAM_FOLDER_NAMES_MAX = 5
/** What change_folder_access did (`StepShared.teamFolder`): the folder by its name and place in words (never a path),
 * the change, how many people could open it before and after, and who got more or less access (the first names, and
 * how many in all). */
export const TeamFolderResult = z.object({
  name: z.string().max(200),
  place: z.string().max(500),
  action: z.enum(['add', 'change', 'remove']),
  access: z.enum(['view', 'edit']).optional(),
  before: z.number().int().nonnegative(),
  after: z.number().int().nonnegative(),
  gained: z.array(z.string().max(200)).max(TEAM_FOLDER_NAMES_MAX),
  gainedCount: z.number().int().nonnegative(),
  lost: z.array(z.string().max(200)).max(TEAM_FOLDER_NAMES_MAX),
  lostCount: z.number().int().nonnegative(),
  /** files inside shared one by one when someone lost the folder: the person's pick on the card */
  fileShares: z.enum(['removed', 'kept']).optional(),
})
export type TeamFolderResult = z.infer<typeof TeamFolderResult>

/** `Step.shared`: what a share_with_person or stop_sharing call did. */
export const StepShared = z.object({
  /** share: people were added; stop: people were taken off */
  op: z.enum(['share', 'stop']),
  /** done: every file; partial: some (`files` done, `failed` not); refused: none */
  outcome: z.enum(['done', 'partial', 'refused']),
  files: z.array(ShareCardFile).max(SHARE_CARD_FILES_MAX),
  failed: z.array(ShareCardFile).max(SHARE_CARD_FILES_MAX).optional(),
  /** whose files they are, when not the asker's own */
  owner: z.object({ id: z.string().max(64), name: z.string().max(200) }).optional(),
  /** who has access now by this call (share), or who was taken off (stop) */
  who: z.array(ShareCardWho).max(SHARE_CARD_PEOPLE_MAX),
  whoMore: z.number().int().positive().optional(),
  /** with `whoMore`: a digest of everyone the card covers, so a change among the people not shown is a different card */
  whoKey: z.string().max(64).optional(),
  /** what they can do with the files (file sharing is view only) */
  level: z.literal('view'),
  /** a share: the people who got a notice (ids, the first 50); absent when nobody was told */
  notified: z.array(z.string().max(64)).max(50).optional(),
  /** a stop: the people taken off who can still open a file, and through what */
  still: z.array(ShareCardStill).max(SHARE_CARD_STILL_MAX).optional(),
  stillMore: z.number().int().positive().optional(),
  /** a share: people named who could already open every file (through a group, the folder, the whole team), so they
   * were not added again (server chat/share-next-steps.ts alreadyOpen); with an empty `who`, nobody new got access */
  already: z.array(ShareCardWho).max(SHARE_CARD_PEOPLE_MAX).optional(),
  refusal: ShareCardRefusal.optional(),
  next: ShareCardNext.optional(),
  /** a folder's stop or removal (share_folder): the server's undo snapshot (POST /api/files/shares/undo) and until when
   * the card offers it. Only the person whose turn it was gets the record; the snapshot is theirs alone, once */
  undo: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{22}$/), until: z.string().max(40) }).optional(),
  /** a share that went through (share_with_person, or share_folder on a folder it made from the chat's files): the
   * server's record of exactly what this share added (POST /api/files/shares/take-back), so 취소 takes away only that
   * and never access a person had before. Only the person whose turn it was gets it; theirs alone, once */
  takeBack: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{22}$/), until: z.string().max(40) }).optional(),
  /** share_folder made this folder from files that were only in the chat (its 취소 deletes the folder it made) */
  madeFolder: z.literal(true).optional(),
  /** a folder's stop: the files and folders inside it that stay shared on their own (with people of their own) */
  keptOwn: z.object({ files: z.number().int().nonnegative(), folders: z.number().int().nonnegative() }).optional(),
  /** change_folder_access (server chat/folder-access-tool.ts): a team folder's access changed for the one person or
   * group in `who`, after the admin's yes on the card. `files` is empty then; `op` share = add or change, stop = remove.
   * Older apps ignore it. */
  teamFolder: TeamFolderResult.optional(),
})
export type StepShared = z.infer<typeof StepShared>
