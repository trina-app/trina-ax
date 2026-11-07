// "대화방에 보내기" (shared/src/api/chats.ts shareAnswerToRoom): a finished answer of a person's own AI chat goes to a
// room they are in, as their own message: their one-line note, then the answer as the AI wrote it (Markdown), which the
// app shows as a quote headed "the AI's answer" (room_messages.answer_at, migration 261; RoomMessage.sharedAnswer).
// It is posted through Rooms.send, so the sending budget (429), notices, events and "the same clientMessageId again is
// the first message" are a message's. It mentions nobody and never calls the room's AI, whatever the answer's text
// says ("@트리나", "@Name" in it are the AI's words). The author is the person; editing it is refused, deleting works.
//
// What the answer may carry, conservatively:
// - the files every answer on its branch read (message_sources of each answer from the first message down to it: the
//   AI had the earlier answers in front of it; skills/ and .system left out like the receipt's team files, a person's
//   own folder kept);
// - the team paths the answer itself links to or shows (answerFilePaths): their names, whose readers are who may list
//   them (read-scope.ts {type:'name'});
// - everything the chat's session read (chat/read-scope.ts, its read scope), when that scope describes the answer. It
//   is emptied when a new session starts on a first message (a new chat, the first message edited or its answer made
//   again: chat/turn.ts newSession), so it describes only the answers below the newest first answer. For an answer on
//   another branch (not below it, or not on the chat's active branch) what else it used is not known: every other
//   member counts as unable and the places say there is more (otherPlaces).
// Names the AI saw through list or glob in a person's own chat are not recorded (only a room's session keeps them):
// a name it repeats without a link is not checked.
// The members: everyone in the room but me, a disabled account too (it reads nothing now, and would see the message
// when enabled again). When one of them may not read one of those under today's rules (the readers of the "more
// people can see this" card, read-scope.ts missingReaders), nothing is sent: the answer is "confirm" with how many and
// where it came from, named only where I may look myself (a folder I may read, my own folder, a team connection or
// shared Drive by its name, a team room by its group's name, the everyone room). Never who: no name or id of a person,
// and a 1:1 or group conversation is never named (its name is people's names). Sent again with `confirm` = the number
// it said, it goes, unless more people are unable by then (someone joined or lost access): "confirm" again. A chat
// that read a room's messages (chats.rooms_seen) whose scope does not show which (an older chat, or an answer the
// scope does not describe) counts every other member as unable. Every request takes from the sending budget before
// anything is checked (the check is no free probe of who may read what); the message then takes nothing more.
// In a team room or the everyone room, a member who would see what it read there but for an old answer hidden from them
// (docs/DECISIONS.md "지난 대화") is never sent it, confirmed or not (409 answer_share_hidden): the sender cannot see what
// is at stake for them. What it used is kept with the message (room_messages.source_scope) for those who join later.
// A confidential conversation (safe operations 1A) is never shared. Audited (room.answer_share) with the room as audit
// rows name it, the number of people, whether it was confirmed and cut; no content, no names.
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import { answerFilePaths, answerShareBody, PRODUCT_NAMED_AFTER_AI, type AnswerSharePlace, type Locale, type ShareAnswerToRoomResult } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { atLeast, loadPrincipal, type RuleSet } from '../policy/access'
import { getRow } from '../integrations/connections/store'
import { shareRow } from '../integrations/google-drive/shares'
import { redactorFor } from '../integrations/connections/redact'
import { confidentialChat } from '../safe-ops/confidential'
import { roomsOf } from '../rooms/service'
import { groupName, messagesOut, MSG_COLS, roomRow, type MessageRow as RoomMessageRow } from '../rooms/store'
import { missingReaders, nameSegs, readScope, sourceOf, viewersByHistory, type ReadSource } from './read-scope'
import { historyKinds, openHistories } from '../rooms/history'
import { DECIDE_HISTORY_MS } from '../rooms/ai'
import { tr } from './i18n'
import type { ChatRow, MessageRow } from './store'

/** Paths of an answer's list that are not content of a place people read (the receipt's isTeamFilePath, but a person's
 * own folder stays: it is theirs alone). */
const notCounted = (p: string) => !p || /^(skills|\.system)(\/|$)/.test(p)

/** The line that ends an answer cut to fit one room message, in the sender's language: "…(이하 생략) 전체는 내 트리나
 * 기록에서" (the web app's sidebar heading for the AI chats, with the AI's name there: tabs.ts aiName). */
export function answerCutLine(locale: Locale): string {
  const name = PRODUCT_NAMED_AFTER_AI ? tr('aiOwnName', locale) : PRODUCT.shortName
  return tr('answerShareCut', locale, { history: tr('aiHistory', locale, { name }) })
}

/** The answers on the branch from the first message down to this one (this one included), oldest first. */
function answersAbove(db: Database, messageId: string): { id: string; parent_id: string | null }[] {
  return (db.query(`WITH RECURSIVE up(id, parent_id, role, depth) AS (
      SELECT id, parent_id, role, 0 FROM messages WHERE id = ?
      UNION ALL SELECT m.id, m.parent_id, m.role, up.depth + 1 FROM messages m JOIN up ON m.id = up.parent_id WHERE up.depth < 100000)
    SELECT id, parent_id FROM up WHERE role = 'assistant' ORDER BY depth DESC`).all(messageId) as { id: string; parent_id: string | null }[])
}

/** Does the chat's read scope describe this answer: is it on the chat's active branch, below the newest first answer
 * (the scope was emptied when that one's session started, chat/turn.ts newSession)? */
function scopeDescribes(db: Database, chat: Pick<ChatRow, 'id' | 'active_leaf_id'>, messageId: string, answers: readonly { id: string }[]): boolean {
  const newestFirst = (db.query(`SELECT a.id FROM messages a JOIN messages q ON q.id = a.parent_id
    WHERE a.chat_id = ? AND a.role = 'assistant' AND q.parent_id IS NULL ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`).get(chat.id) as { id: string } | null)?.id
  if (!newestFirst || answers[0]?.id !== newestFirst) return false
  if (!chat.active_leaf_id) return false
  return !!db.query(`WITH RECURSIVE up(id, parent_id, depth) AS (SELECT id, parent_id, 0 FROM messages WHERE id = ?
      UNION ALL SELECT m.id, m.parent_id, up.depth + 1 FROM messages m JOIN up ON m.id = up.parent_id WHERE up.depth < 100000)
    SELECT 1 FROM up WHERE id = ?`).get(chat.active_leaf_id, messageId)
}

/** Who of the room's members (not me) could not read what the answer used, and where it came from as the sender may
 * be told. `answer`: its text (the paths it links to). */
export function answerAudience(ctx: AppContext, userId: string, roomId: string, chat: Pick<ChatRow, 'id' | 'active_leaf_id'>, messageId: string, answer: string): { people: number; places: AnswerSharePlace[]; otherPlaces: boolean; scope: AnswerScopeKept; hidden: boolean } {
  const db = ctx.db, rules = ctx.files.rules()
  // a team room or the everyone room: the members whose history is not worked out yet get it first (rooms/history.ts)
  const target = roomRow(db, roomId)
  // (for at most DECIDE_HISTORY_MS: one still waiting after it makes it unsendable, below)
  if (target && historyKinds(target.kind)) try { openHistories(ctx, { roomId, budgetMs: DECIDE_HISTORY_MS, within: true }) } catch (e) { ctx.log.warn('room history not opened', { err: e }) }
  // a disabled or deleted account still in the room reads nothing now: it misses every source (missingReaders)
  const audience = (db.query('SELECT user_id FROM room_members WHERE room_id = ? AND user_id <> ?').all(roomId, userId) as { user_id: string }[]).map((r) => r.user_id)
  const places = new Map<string, AnswerSharePlace>()
  let otherPlaces = false
  const missing = new Set<string>()
  const me = loadPrincipal(db, userId)
  const add = (p: AnswerSharePlace) => { const k = JSON.stringify(p); if (!places.has(k)) places.set(k, p) }
  /** a team folder ('' = the top), named only when I may read it now myself (a rule changed since: not) */
  const folder = (path: string | undefined) => {
    if (path !== undefined && me && atLeast(rules.access(me, path === '' ? [] : path.split('/')), 'read')) add({ kind: 'folder', path })
    else otherPlaces = true
  }
  const answers = answersAbove(db, messageId)
  const described = scopeDescribes(db, chat, messageId, answers)
  const paths = answers.length ? (db.query(`SELECT path FROM message_sources WHERE message_id IN (${answers.map(() => '?').join(',')}) ORDER BY message_id, ord`).all(...answers.map((a) => a.id)) as { path: string }[]).map((r) => r.path).filter((p) => !notCounted(p)) : []
  const scope = described ? readScope(db, chat.id) ?? [] : []
  const sources: ReadSource[] = [...scope, ...paths.map((p) => sourceOf(db, rules, p)), ...answerFilePaths(answer, 500).filter((p) => !notCounted(p)).map((path): ReadSource => ({ type: 'name', path }))]
  // the chat read a room's messages, and the scope does not show which
  const roomsSeen = !!(db.query('SELECT rooms_seen FROM chats WHERE id = ?').get(chat.id) as { rooms_seen: number } | null)?.rooms_seen
  const roomsUnknown = roomsSeen && (!described || !scope.some((s) => s.type === 'room'))
  // kept with the message for those who join the room later (rooms/history.ts): what it used, and whether that is all
  const kept: AnswerScopeKept = { sources, unknown: !described || roomsUnknown }
  if (!audience.length) return { people: 0, places: [], otherPlaces: false, scope: kept, hidden: false }
  // a member who would see a room it read but for old answers hidden from them (or whose history is not worked out):
  // the sender cannot see what is at stake for them, so this is never sent, even when confirmed (as the room AI's
  // answer that used a hidden answer cannot be posted)
  const audienceSet = new Set(audience)
  const hidden = sources.some((s) => s.type === 'room' && [...viewersByHistory(db, s.id, undefined, s.fromSeq, userId).hiddenFrom].some((id) => audienceSet.has(id)))
  for (const { source: s, missing: who } of missingReaders(db, rules, sources, audience, userId)) {
    for (const id of who) missing.add(id)
    switch (s.type) {
      case 'root': folder(''); break
      case 'folder': folder((db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null)?.path); break
      case 'user': if (s.id === userId) add({ kind: 'mine' }); else otherPlaces = true; break
      case 'integration': { const name = getRow(db, s.id)?.name; if (name) add({ kind: 'service', name }); else otherPlaces = true; break }
      case 'drive_share': { const name = shareRow(db, s.id)?.name; if (name) add({ kind: 'service', name }); else otherPlaces = true; break }
      case 'room': {
        const r = roomRow(db, s.id)
        const team = r?.kind === 'team' ? groupName(db, r) : null
        if (r?.kind === 'all') add({ kind: 'room', name: '' })
        else if (team) add({ kind: 'room', name: team })
        // a 1:1 or group conversation: its name is people's names
        else if (r?.kind === 'dm' || r?.kind === 'group') add({ kind: 'conversation' })
        else otherPlaces = true
        break
      }
      case 'name': {
        // a path the answer names: my own folder, else the team folder it is in
        const segs = nameSegs(s.path)
        if (segs[0] === 'users') { if (segs[1] === userId) add({ kind: 'mine' }); else otherPlaces = true; break }
        const at = sourceOf(db, rules, s.path)
        if (at.type === 'root') folder('')
        else if (at.type === 'folder') folder((db.query('SELECT path FROM folders WHERE id = ?').get(at.id) as { path: string } | null)?.path)
        else otherPlaces = true
        break
      }
    }
  }
  // what else the answer used is not known (the scope does not describe it): nobody else is taken to have seen it
  if (!described) {
    for (const id of audience) missing.add(id)
    otherPlaces = true
  }
  // the chat read a room's messages, and the scope does not show which: nobody else is taken to have seen them
  if (roomsUnknown) {
    for (const id of audience) missing.add(id)
    add({ kind: 'conversation' })
  }
  return { people: missing.size, places: [...places.values()], otherPlaces, scope: kept, hidden }
}

/** What a shared answer used, as kept with its message (room_messages.answer_scope): the sources checked when it was
 * sent, and `unknown` when they are not all (the chat's scope did not describe the answer, or it read rooms the scope
 * does not name). A later member of the room sees it only when they may read every source and nothing is unknown. */
export interface AnswerScopeKept { sources: ReadSource[]; unknown: boolean }

export interface ShareAnswerInput { roomId: string; note?: string; confirm?: number; clientMessageId: string }

/** POST /api/chats/:id/messages/:messageId/share-to-room. `chat` is the caller's own (routes/chats.ts ownChat: not a
 * room's AI session, not deleted) and `message` one of its messages. */
export function shareAnswerToRoom(ctx: AppContext, userId: string, chat: ChatRow, message: MessageRow, b: ShareAnswerInput, locale: Locale): ShareAnswerToRoomResult {
  const db = ctx.db, rooms = roomsOf(ctx)
  if (message.role !== 'assistant') fail('validation', tr('answerShareNotReady', locale), { fields: { 'params.messageId': 'not an answer' } })
  const content = redactorFor(ctx, userId).hide(message.content ?? '')
  if (message.status !== 'done' || !content.trim()) fail('conflict', tr('answerShareNotReady', locale), { params: { reason: 'answer_not_finished' } })
  // safe operations' 1A material stays in its conversation (like a team skill made from one, or the room's AI)
  if (confidentialChat(db, chat.id)) fail('conflict', tr('answerShareConfidential', locale), { params: { reason: 'confidential' } })
  // a room I am in (not archived): anything else is 404, the same as a room that does not exist
  const { room, me } = rooms.mine(userId, b.roomId)
  // the same request again (a retry after it went): the first message, nothing checked or counted again
  const again = db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE room_id = ? AND author_id = ? AND client_id = ?`).get(room.id, userId, b.clientMessageId) as RoomMessageRow | null
  if (again) {
    const m = messagesOut(db, [again], me)[0]!
    return { status: 'sent', message: m, cut: !!m.sharedAnswer?.cut }
  }
  // from the sending budget first (429): asking who could not read what is no free probe; the message takes no more
  rooms.takeSendToken(userId)
  const who = answerAudience(ctx, userId, room.id, chat, message.id, content)
  if (who.hidden) fail('conflict', tr('answerShareHidden', locale), { params: { reason: 'answer_share_hidden' } })
  // sent when nobody is unable, or no more people than the person said yes to (else they are asked again)
  if (who.people > 0 && !(b.confirm !== undefined && who.people <= b.confirm)) return { status: 'confirm', people: who.people, places: who.places, otherPlaces: who.otherPlaces }
  const { body, at, cut } = answerShareBody(b.note, content, answerCutLine(locale))
  // audited with the message (Rooms.send: room.answer_share)
  const m = rooms.send(userId, room.id, { body, mentions: [], fileIds: [], clientMessageId: b.clientMessageId }, {}, { at, cut, people: who.people, scope: JSON.stringify(who.scope) })
  return { status: 'sent', message: m, cut }
}
