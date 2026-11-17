// Why a chat asks first, in the card's words (docs/decisions/20261116-ai-screen-and-shared-tools.md). A file read through
// a share grant marks the chat as having read rooms for good and as holding other people's words (chat/turn.ts
// noteOthersReads: chats.rooms_seen, chats.others_words; docs/decisions/20261116-always-allow-more-cards.md "Content
// written by others"). The cards that follow said "Messages from your conversations … came in here", which is not what
// happened when the cause was a shared file. This picks the sentence: the shared-file one when the chat read a file its
// person can open only through a grant and nothing of a room came in; the room one in every other case.
//
// No mark of its own (the marks are turn.ts's): it is read from what is already kept. A grant read's real path is in the
// chat's read scope like any read, so the chat read through a grant when its scope (or this turn's reads not yet noted)
// holds a team place the person's own folder rules do not open today. A room came in when the scope holds a room, the
// chat is a room's side chat, or a question on the branch quotes a message. Only words depend on this: every gate asks
// the marks.
import type { Database } from 'bun:sqlite'
import { atLeast, loadPrincipal, RuleSet } from '../policy/access'
import type { tr } from './i18n'
import { quotesOnBranch } from './read-rooms'
import { isFileSource, readScope, viewersOf, type ReadSource } from './read-scope'

type TrKey = Parameters<typeof tr>[0]
export interface GrantReadExec { spec: { chatId: string; userId: string; assistantId?: string | null }; rt: { db: Database }; files?: { readPaths?: ReadonlySet<string>; grantReadPaths?: ReadonlySet<string> } }

/** The place as the folder rules alone open it: a source from inside a shared folder without its share. */
const ownPlace = (s: ReadSource): ReadSource => (s.type === 'user' && s.share ? { type: 'user', id: s.id } : s)

/** Did this chat read a file its person can open only through a grant? */
export function readByGrant(exec: GrantReadExec): boolean {
  const db = exec.rt.db
  if (exec.files?.grantReadPaths?.size) return true
  const pending = exec.files?.readPaths
  const scope = (readScope(db, exec.spec.chatId) ?? []).filter(isFileSource)
  if (!pending?.size && !scope.length) return false
  try {
    const me = loadPrincipal(db, exec.spec.userId)
    if (!me) return false
    const rules = RuleSet.load(db)
    for (const p of pending ?? []) if (!atLeast(rules.access(me, p.split('/').filter(Boolean)), 'read')) return true
    // a place inside a folder someone shares (a `user` source with its share, read-scope.ts sourceOf) is judged without
    // the share: its readers include the person only through that grant, which is what is asked here (QA TC-4482)
    return scope.some((s) => !viewersOf(db, rules, ownPlace(s), [me]).has(me.id))
  } catch {
    return false
  }
}

/** Did a room's words come into this chat (a room in the read scope, a side chat, a quoted message)? */
function roomCameIn(exec: GrantReadExec): boolean {
  const db = exec.rt.db
  if ((readScope(db, exec.spec.chatId) ?? []).some((s) => s.type === 'room')) return true
  const chat = db.query('SELECT side_room_id FROM chats WHERE id = ?').get(exec.spec.chatId) as { side_room_id: string | null } | null
  return !!chat?.side_room_id || (!!exec.spec.assistantId && quotesOnBranch(db, exec.spec.assistantId))
}

/** The chat's "rooms seen" mark came from a file shared with the person alone (no room's words came in): the places a
 * card names say "a file shared with you", not "direct messages and group chats" (chat/post-to-room.ts). */
export function grantOnly(exec: GrantReadExec): boolean {
  try { return readByGrant(exec) && !roomCameIn(exec) } catch { return false }
}

/** Did this chat read inside a folder someone else shares with the person (such a place in its read scope)? Then the
 * room check's own count of who cannot see the sources stands on the post card: the count of files shared one by one
 * (chat/share-next-steps.ts grantSourceCant) does not cover a shared folder. Never throws. */
export function readSharedFolder(exec: GrantReadExec): boolean {
  try { return (readScope(exec.rt.db, exec.spec.chatId) ?? []).some((s) => s.type === 'user' && !!s.share && !s.via && s.id !== exec.spec.userId) } catch { return false }
}

/** The AI-facing words for where the other people's words in this chat came from (refusals the AI relays): a file shared
 * with the person when that is the only cause (grantOnly), else `room` (the caller's own room wording). */
export const SHARED_FILE_SOURCE = 'a file someone shared with the user (other people\'s words, not the user\'s own)'
export function othersSource(exec: GrantReadExec, room: string): string {
  return grantOnly(exec) ? SHARED_FILE_SOURCE : room
}

const FILE_WORDS = { roomsSeenWhy: 'sharedFileSeenWhy', roomsSeenConfirm: 'sharedFileSeenConfirm', roomsSeenConfirmRead: 'sharedFileSeenConfirmRead' } as const
/** The sentence that says why this chat asks first: about a file shared with the person when that is the cause and no
 * room's words came in, else the room sentence as before. Never throws (words only: the room sentence on any doubt). */
export function seenWhy<K extends keyof typeof FILE_WORDS>(exec: GrantReadExec, key: K): TrKey {
  return grantOnly(exec) ? FILE_WORDS[key] : key
}
