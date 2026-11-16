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
export const ShareCardFile = z.object({ linkId: LinkId.optional(), name: z.string().max(255), place: z.string().max(500) })
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
 * file it happened on. */
export const ShareCardRefusal = z.object({
  reason: z.enum(['not_owner', 'switched_off', 'limit', 'full', 'changed', 'failed']),
  file: z.string().max(255).optional(),
  owner: z.string().max(200).optional(),
})
export type ShareCardRefusal = z.infer<typeof ShareCardRefusal>

/** The next step a refusal offers, as data: the app shows a button for a kind it knows (web components/chat/ShareCard.tsx
 * registerShareNext) and nothing for one it does not. ask_owner: ask the file's owner (`userId`, `name`) to share it,
 * by its link (`linkId`); ask_admin: ask an admin. */
export const ShareCardNext = z.object({
  kind: z.enum(['ask_owner', 'ask_admin']),
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
  /** whose files they are, when not the asker's own (an admin and a team file someone else added) */
  owner: z.object({ id: z.string().max(64), name: z.string().max(200) }).optional(),
})
export type ShareCardAsk = z.infer<typeof ShareCardAsk>

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
  /** what they can do with the files (file sharing is view only) */
  level: z.literal('view'),
  /** a share: the people who got a notice (ids, the first 50); absent when nobody was told */
  notified: z.array(z.string().max(64)).max(50).optional(),
  /** a stop: the people taken off who can still open a file, and through what */
  still: z.array(ShareCardStill).max(SHARE_CARD_STILL_MAX).optional(),
  stillMore: z.number().int().positive().optional(),
  refusal: ShareCardRefusal.optional(),
  next: ShareCardNext.optional(),
})
export type StepShared = z.infer<typeof StepShared>
