// The words of sharing and posting through the AI (docs/decisions/20261116-ai-share-words.md; the owner's plan "AI
// sharing", 2026-11-16, part 1): what the AI is told about the share and post tools, what it gets when one refuses, and
// how a card names a file. A teammate's hands-on tests (QA "Manual AI tests") found the AI pasting a file's text into a
// room (MAN-013: nothing told it a link in `text` sends the file), picking a thread by guess (MAN-015), cards and
// questions with disk paths, and refusals that stopped at "can't". Wording only: nothing here changes what is refused,
// who is asked, or who may open what.
//
// - The rules (…_RULE, …_LINE): appended next to the rules they extend in chat/prompt.ts.
// - The refusals (SHARE_NO, POST_NO): each says why in plain words and ends with "Next step:", the sentence the AI passes
//   on and the offer it makes. A button for that step (another builder's) sits under the same sentence.
// - Place words: a file on a card is its name and its place as the Files screen says it (chat/place-words.ts), never a
//   team path; an ask_user option whose label is a path is said the same way.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { TOP_FOLDERS } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import type { FileShares } from '../files/shares'
import { hiddenEntry } from '../policy/names'
import { SCREEN } from '../policy/refusal'
import { placeWords } from './place-words'
import { tr } from './i18n'
import { alwaysHere, type AlwaysPlace } from './always-allow'
import type { CardAlwaysKind } from '@mycel/shared/api'

// ---- the rules ----

/** After ROOMS_POST_RULE (MAN-013): a file goes to a room as a link in `text`; the card then offers the file itself. */
export const POST_FILE_RULE = 'To post a file to a room or a person, link it in text ([name](/files/view?path=<team path, URL-encoded>)) with one short line; never paste the file\'s content, and no own_words for it: the card then offers to send the file with it.'
/** After ROOMS_POST_RULE (MAN-015): no thread named, none quoted: ask, never the newest. */
export const WHICH_THREAD_RULE = '"That thread" or "that message" with none named or quoted: never guess the newest. Read the room, then ask which one, offering two or three by who wrote it and its first words.'
/** With the share and post tools (the plan's "거절에는 다음 단계"): a refusal is passed on with its next step. */
export const REFUSAL_NEXT_RULE = 'When a share or a post is refused, do not stop at "I can\'t": say why in one plain sentence and offer the next step its result names. A whole folder cannot be shared yet: offer to share the files in it; a team folder is shared by the team owner or an admin with Share on the folder in Files. When the person already has access, say so: that is not a refusal.'
/** With the share and post tools (docs/decisions/20261116-always-allow-more-cards.md "Content written by others"): once
 * the chat read something other people wrote, "Always allow" counts only for what the person's own message names, so the
 * card comes back. Not a refusal; the AI can say why and what skips it. */
export const OTHERS_WORDS_RULE = 'A share or a post may show its card although the user chose "Always allow": this chat read something other people wrote (a teammate\'s file, a shared file, a page, a room). Asked why, say "I read something other people wrote in this chat, so I ask before sharing", and that naming the file and the person in their message, or confirming on the card, is enough.'
/** The card's first line in that case (server text, TEXT.othersWordsWhy): only when the person's "Always allow" is on for
 * this kind and the card comes anyway because content someone else wrote was read. A chat that read rooms has its own
 * line (roomsSeenWhy), and a shared chat never had the choice count this way. */
export const othersWordsCard = (exec: { shared?: unknown; roomsSeen?: unknown; othersWords?: unknown; alwaysPlace?: () => AlwaysPlace }, kind: CardAlwaysKind, alwaysOk: boolean): boolean =>
  !alwaysOk && !exec.shared && !exec.roomsSeen && !!exec.othersWords && alwaysHere(exec.alwaysPlace?.(), kind) === 'on'
/** Next to FIND_FILE_RULE (UX B): several files of one name. */
export const SAME_NAME_RULE = 'Several files fit the name the user gave: if one was made, read or attached in this chat, or is the only one they may share, use it without asking and say which. Otherwise ask, each choice labelled by its name, its place in words and, for a file shared with the user, who shared it and when.'
/** After SOURCE_LINK_RULE (UX A): the same on a card. */
export const CARD_WORDS_RULE = 'The same in a question or an option you put on a card (ask_user): never a team path. Say the place in words, by the names in quotes under "Team folders" and the folder names below them (the user\'s own folder › Work), and give every option a different label.'
/** An own chat (the plan's "Gmail 미연결"): how to connect, and a draft meanwhile. */
export const sendNotConnectedRule = (locale: Locale, connect: boolean) => `Asked to send something by Gmail or another service that is not connected: say in one sentence that it is not connected yet, ${connect ? 'show the connect card (connect_service)' : `say where to connect it (${SCREEN.connectors(locale)})`} and offer to draft the text meanwhile.`

/** "Send to Trina" in an answer's thread (web chat.thread.sendToAi, with the AI's name filled in). */
export const threadSendToAi = (locale: Locale, aiName: string) => tr('threadSendToAi', locale, { name: aiName })
/** A shared chat (MAN-003a; docs/decisions/20261116-chat-answer-threads.md: replies are people's words, the AI does not
 * read them): the AI says so and names the button that brings them to it. */
export const sharedCommentsLine = (asker: string, locale: Locale, aiName: string) => `- People can comment under an answer here (its thread, beside the chat). You cannot read those comments. When ${asker} asks about one, say so and that "${threadSendToAi(locale, aiName)}" in that thread puts the comments in the message box, for ${asker} to send to you.`

/** Added to post_to_room's description. */
export const POST_FILE_DESCRIPTION = ' To post a file, link it in text ([name](/files/view?path=<team path, URL-encoded>)) with one short line and leave own_words out: the card then offers to send the file itself. Never paste a file\'s content in its place. Asked for "that thread" with none named or quoted, ask the user which one (two or three candidates by author and first words) instead of picking one.'
/** Added to share_with_person's description. */
export const SHARE_FOLDER_DESCRIPTION = ' A whole folder cannot be shared yet: asked for one, call this with the folder to learn which files in it can be shared, tell the user and offer to share those. A refusal says why and the next step: pass both on.'

// ---- the refusals (what the AI gets; English, it answers in the user's language) ----

const q = (s: string) => `"${s}"`

/** share_with_person's refusals. `file`, `owner`, `ref`: already one line, capped, tags neutralized (the tool's own
 * helpers). In a shared chat no name and no server words go in (the tool passes null). */
export const SHARE_NO = {
  /** not found, or not one the user can open (the same answer for both, on purpose) */
  notFile: (file: string, why: string) => `Nothing was shared: ${q(file)} ${why}. Next step: look for the file by its name (glob, or list its folder) and call share_with_person again with the one that fits; if none fits, tell the user you could not find it among the files they can open and ask which file they mean.`,
  /** someone else's file. `owner` null: not known, or a shared chat */
  notOwner: (file: string, owner: string | null) => owner
    ? `Nothing was shared: ${q(file)} is ${owner}'s file, so only ${owner} can add people to it. Next step: tell the user that in one sentence and offer to ask ${owner}: with the user's yes, send ${owner} a short message with the file's link (share_file, then post_to_room to ${owner}) asking them to share it with the people the user named.`
    : `Nothing was shared: ${q(file)} is someone else's file, so only its owner can add people to it (a team owner or admin can too, for a team file). Next step: tell the user that in one sentence and offer to write a short request with the file's link (share_file) that they can send to its owner or an admin.`,
  /** the user's own file in a place they can no longer edit (sharing needs edit access) */
  noEdit: (file: string) => `Nothing was shared: the user can open ${q(file)} but can no longer change it there, and sharing a file needs edit access to it. Next step: tell the user that in one sentence and offer to write a short request to the team owner or an admin, who can share a team file or give the user edit access to its folder.`,
  /** the team's switch for members is off. `staff`: the user is the team owner or an admin */
  off: (file: string, L: Locale, staff: boolean) => `Nothing was shared: the team turned off file sharing by members, so ${q(file)} cannot be shared with chosen people now (what was shared before still opens). Next step: tell the user that in one sentence and ${staff ? `that they can turn it back on themselves in ${SCREEN.adminSettings(L)}, team settings, the switch for members sharing files they own; offer to share again once it is on` : `that the team owner or an admin can turn it back on in ${SCREEN.adminSettings(L)}, team settings; offer to write that request for them`}.`,
  /** a folder. `files`: the files right in it the user can share now (team paths, for the next call), null when not counted */
  folder: (name: string | null, o: { files: string[] | null; more: number; teamFolder: boolean; staff: boolean }) => {
    const n = o.files === null ? null : o.files.length + o.more
    const lead = `Nothing was shared: ${name === null ? 'that' : q(name)} is a folder, and a whole folder cannot be shared yet (files put in it later would not follow).`
    const team = o.teamFolder
      ? (o.staff ? ' It is a team folder, and the user is the team owner or an admin: they can share the whole folder with people or groups themselves, with Share on the folder in Files.' : ' It is a team folder: the team owner or an admin can share the whole folder with people or groups, with Share on the folder in Files.')
      : ''
    if (n === null) return `${lead}${team} Next step: tell the user "I can't share the whole folder yet, but I can share the files in it", list the folder to see them, and with the user's yes call share_with_person again with those files (at most 10 a call).`
    if (n === 0) return `${lead}${team} There is no file right in it that the user can share (it is empty, or holds only folders or other people's files). Next step: tell the user that in one sentence and ask which files they want to share.`
    const list = o.files!.map((f) => `- ${f}`).join('\n')
    return `${lead}${team} Next step: tell the user "I can't share the whole folder yet, but I can share the ${n === 1 ? 'file' : `${n} files`} in it" and offer that; with their yes, call share_with_person again with ${n === 1 ? 'this file' : 'these files'} (at most 10 a call; files added to the folder later are not shared by this):\n${list}${o.more ? `\n(and ${o.more} more: list the folder for the rest)` : ''}`
  },
  /** nobody matches: a guest, a person not active in the team and a group the user is not in read the same, on purpose */
  nobody: (ref: string) => `Nothing was shared: no teammate or group matches ${q(ref)}. Files are shared with active teammates and with groups the user is in; a guest, someone who is not on the team and a group the user is not in all read the same here. Next step: ask the user who they mean (a full name or a user name). If they mean a guest or someone outside the team, say files cannot be shared with them this way and offer what works: posting the file to a chat that person is in (post_to_room with the file linked in text), which sends them a copy.`,
  /** a file that could not be shared after the yes (it changed while the card waited); `sofar`: the links already made */
  changed: (file: string, why: string, sofar: string) => `Nothing more was shared: ${q(file)} ${why}.${sofar} Next step: tell the user which files were shared and which one was not, and offer to try that one again.`,
} as const

/** The note of a share where nobody new got access (everyone named could already open every file): said, not refused. */
export const SHARE_ALREADY_NOTE = 'Nobody new got access: the people named could already open these files. This is not a refusal: say in one sentence that they can already open them, and give the links.'
export const SHARE_DONE_NOTE = 'Shared, view only. Reply with these links as Markdown links; the link opens only for the people it was shared with and those who could already open the file.'

/** post_to_room's refusals that got a next step. `ref`, `who`: one line, capped, tags neutralized. */
export const POST_NO = {
  /** no room and no teammate by that name. `shared`: a shared chat, where rooms are not read */
  noMatch: (ref: string, shared: boolean) => `Nothing was posted: no room and no teammate matches ${q(ref)} (an archived room, a room the user is not in, a guest and a person who is not active in the team all read the same). Next step: ${shared
    ? 'tell the user you could not find that room or person among their rooms and teammates, and ask them for its exact name.'
    : 'call rooms, tell the user you could not find it and name the two or three of their rooms closest to what they asked so they can pick one; for a person, ask for their full name. A guest is reached in a group chat they are in.'}`,
  /** the room is archived, or the user left it */
  notMine: (shared: boolean) => `Nothing was posted: that room is archived or the user is no longer in it. Next step: ${shared ? 'tell the user that in one sentence and ask where to send it instead.' : 'call rooms to see the rooms they are in now, tell the user that in one sentence and offer one or two rooms it could go to instead.'}`,
  /** a thread reply to a teammate with no 1:1 chat yet */
  noDmThread: (who: string) => `Nothing was posted: the user has no 1:1 chat with ${who} yet, so there is no thread to reply in. Next step: call post_to_room again without thread_id: it goes to a new 1:1 chat with them, made when the user presses send.`,
  /** the teammate was turned off or removed while the card waited */
  gone: (who: string) => `Nothing was posted: ${who} can no longer be reached (their account was turned off or removed from the team). Next step: tell the user that in one sentence and ask whether to send it to someone else or to a room.`,
  /** any other refused check, with the server's own words */
  other: (why: string) => `Nothing was posted: ${why}. Next step: tell the user it was not sent and why in one plain sentence, and offer to try again.`,
} as const

// ---- place words on cards ----

const TOPS = TOP_FOLDERS as readonly string[]
/** A team path as a model writes one: a top folder, then at least one more part, on one line. */
const PATHISH = new RegExp(`^(?:${TOPS.join('|')})/[^\\n]*[^\\s/][^\\n]*$`)
const isTeamPath = (s: string) => s.length <= 1024 && PATHISH.test(s) && !s.includes('://')

/** A file as a card lists it: its place in the words of the Files screen, ending in its name ("내 폴더 › 작업 ›
 * 견적서.pdf"). Two files of one name in two folders then read differently (placeWords keeps two places apart). */
export const fileWords = (db: Database, rel: string, L: Locale, me: string) => placeWords(db, rel.replace(/\/+$/, ''), L, me)

/** A card text an AI wrote, with the team paths in it said in place words: the whole text when it is a path, and every
 * part in backticks that is one. Anything else stays as written. */
export function pathsToWords(db: Database, s: string, L: Locale, me: string): string {
  const t = s.trim()
  const bare = t.replace(/^`([^`]+)`$/, '$1')
  if (isTeamPath(bare)) return fileWords(db, bare, L, me)
  return s.replace(/`([^`\n]+)`/g, (all, inner: string) => (isTeamPath(inner.trim()) ? fileWords(db, inner.trim(), L, me) : all))
}

/** ask_user's options as the card shows them: a label that is a team path (or holds one in backticks) in place words.
 * The values go back to the AI unchanged. Two options must never read the same (a card is where the person decides): a
 * label that words would make equal to another one keeps what the AI wrote. */
export function optionWords<T extends { label: string; value: string }>(db: Database, options: readonly T[], L: Locale, me: string): T[] {
  const worded = options.map((o) => pathsToWords(db, o.label, L, me))
  const count = new Map<string, number>()
  for (const w of worded) count.set(w, (count.get(w) ?? 0) + 1)
  return options.map((o, i) => (worded[i] !== o.label && count.get(worded[i]!) === 1 ? { ...o, label: worded[i]! } : o))
}

/** A room message's first words as a card's title quotes them: without the Markdown marks around them (bold, italics,
 * code, strike, a heading's or a list's mark, a link's address). */
export function plainQuote(s: string): string {
  return s
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])([*_])(?=\S)([^\n*_]*?\S)\2(?=$|[\s).,!?:;])/g, '$1$3')
    .replace(/`+([^`\n]+)`+/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
}

// ---- a folder's files the user could share instead ----

const FOLDER_SCAN_MAX = 500
const FOLDER_LIST_MAX = 10

/** The files right inside a folder that `userId` can share now, as team paths (each checked by the Share dialog's own
 * check, FileShares.view): what the AI offers when asked to share a folder. `rel` is a folder the same check just called
 * one (so the user may read it). Null when the folder cannot be listed as written. */
export function shareableIn(root: string, shares: Pick<FileShares, 'view'>, userId: string, rel: string, L: Locale): { files: string[]; more: number } | null {
  const segs = rel.split('/').filter(Boolean)
  if (!segs.length || segs.some((s) => s === '.' || s === '..')) return null
  let names: string[]
  try {
    names = fs.readdirSync(path.join(root, ...segs), { withFileTypes: true }).filter((d) => d.isFile() && !hiddenEntry(d.name, segs.length) && !d.name.startsWith('.') && d.name !== '_FILES.md').map((d) => d.name).sort((a, b) => a.localeCompare(b))
  } catch { return null }
  const files: string[] = []
  let more = 0
  for (const name of names.slice(0, FOLDER_SCAN_MAX)) {
    let ok = false
    // (a file the check refuses, for any reason, is just not offered)
    try { ok = shares.view(userId, `${segs.join('/')}/${name}`, L).canShare } catch { ok = false }
    if (!ok) continue
    if (files.length < FOLDER_LIST_MAX) files.push(`${segs.join('/')}/${name}`)
    else more++
  }
  return { files, more }
}
