// "대화방에 보내기" (shared/src/api/chats.ts shareAnswerToRoom): a finished answer of a person's own AI chat goes to a
// room they are in, as their own message: their one-line note, then the answer as the AI wrote it (Markdown), which the
// app shows as a quote headed "the AI's answer" (room_messages.answer_at, migration 261; RoomMessage.sharedAnswer).
// It is posted through Rooms.send, so the sending budget (429), notices, events and "the same clientMessageId again is
// the first message" are a message's. It mentions nobody and never calls the room's AI, whatever the answer's text
// says ("@트리나", "@Name" in it are the AI's words). The author is the person; editing it is refused, deleting works.
//
// Before it goes, two questions, asked apart and only when one applies (otherwise it goes at once):
// A. Access: the files the answer, as the room gets it, links to or shows (answerFilePaths). For each, how many members
//    cannot open it now (the room's own check of a message's links, rooms/service.ts fileOpener). A file I cannot open
//    now myself is never named and its count is everyone else ("missing": gone and not mine read the same). One I can
//    open that some cannot may go with the message as a copy (attach 'yes', ≤ 50 MB, at most 10: RoomFiles.fromTeamFile,
//    which checks my read access again when it copies).
// B. Provenance: content from material some members cannot see, conservatively:
//    - the files every answer on its branch read (message_sources, each with the sha256 it had: an answer may repeat what
//      an earlier one read; skills/ and .system left out like the receipt's team files, a person's own folder kept);
//    - the session's read scope (chat/read-scope.ts) when it describes the answer: its rooms, connections, shared Drives,
//      the in-app browser and every file-type source the source lists do not record (attachments, instructions, a skill,
//      make_file's inputs); file reads the lists record are their files above. The scope is emptied when a new session
//      starts on a first message (chat/turn.ts newSession), so it describes only the answers below the newest first
//      answer on the chat's active branch. For an answer elsewhere what else it used is not known ("unknown": everyone
//      else counts, the app says so);
//    - for an AI-made file being attached, what the turn that made it used (its branch's files, its chat's scope).
//    Left out: material every member can read; a file whose identical content (the same sha256) a turn on this branch
//    saved to a place every member can open now, the copy still there with that hash (a file read without a sha256 is
//    never left out); a linked file being attached (its row says who more will see it).
//    Where it came from is named only where I may look myself (a folder I may read, my own folder, a team connection or
//    shared Drive by its name, a team room by its group's name, the everyone room). Never who: no name or id of a person,
//    and a 1:1 or group conversation is never named (its name is people's names). A chat that read a room's messages
//    (chats.rooms_seen) whose scope does not show which counts every other member as unable.
// The members: everyone in the room but me, a disabled account too (it reads nothing now, and would see the message when
// enabled again). When something applies, nothing is sent: the answer is "confirm" with the rows, the provenance line and
// a confirmKey, a keyed hash (a secret of this server process) over the room, the answer, the members, the sources each
// misses, the rows and what each may attach: sent again with that key, it goes with the files asked for (only rows that
// may be attached); anything changed since (a member swapped for another, someone lost access, a file moved, the server
// restarted) gives "confirm" again with a new key. Older clients send `confirm` = the number they said yes to (nothing
// attached). Names the AI saw through list or glob in a person's own chat are not recorded (only a room's session keeps
// them): a name it repeats without a link is not checked. Every request takes from the sending budget before anything is
// checked (the check is no free probe of who may read what); the message then takes nothing more.
// In a team room or the everyone room, a member who would see what it read there but for an old answer hidden from them
// (docs/DECISIONS.md "지난 대화") is never sent it, confirmed or not (409 answer_share_hidden): the sender cannot see what
// is at stake for them. What it used (and the files that go with it) is kept with the message (room_messages
// .source_scope) for those who join later, and so is each copy with the answer's links that name it: a member who cannot
// open the team file opens the copy from the link (RoomMessage.attachedLinks, rooms/store.ts).
// A confidential conversation (safe operations 1A) is never shared. Audited (room.answer_share) with the room as audit
// rows name it, the number of people, whether it was confirmed, cut, and the number of files attached; no content, no
// names.
import type { Database } from 'bun:sqlite'
import { createHmac, randomBytes } from 'node:crypto'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import {
  ANSWER_SHARE_FILES_MAX, answerFilePaths, answerShareBody, PRODUCT_NAMED_AFTER_AI, ROOM_FILES_MAX, SMALL_UPLOAD_MAX,
  type AnswerShareFile, type AnswerSharePlace, type AnswerShareProvenance, type Locale, type ShareAnswerToRoomResult,
} from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { atLeast, loadPrincipal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { badSegment, hiddenEntry } from '../policy/names'
import { getRow } from '../integrations/connections/store'
import { shareRow } from '../integrations/google-drive/shares'
import { redactorFor } from '../integrations/connections/redact'
import { confidentialChat } from '../safe-ops/confidential'
import { fileOpener, roomsOf } from '../rooms/service'
import { roomFilesOf } from '../rooms/files'
import { groupName, messagesOut, MSG_COLS, roomRow, type MessageRow as RoomMessageRow } from '../rooms/store'
import { historyKinds, openHistories } from '../rooms/history'
import { DECIDE_HISTORY_MS } from '../rooms/ai'
import { hashFile } from '../team-files/place'
import { missingReaders, scopeWithListing, sourceKey, sourceOf, viewersByHistory, type ReadSource } from './read-scope'
import { tr } from './i18n'
import type { ChatRow, MessageRow } from './store'

/** Every this many linked files past the first take one more send from the budget (a row per file is a count per file). */
export const LINKS_PER_TOKEN = 10

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

/** The turns that wrote these answers (turns.message_id, and the message's own turn_id). */
function turnsOf(db: Database, answerIds: readonly string[]): string[] {
  if (!answerIds.length) return []
  const marks = answerIds.map(() => '?').join(',')
  return (db.query(`SELECT id FROM turns WHERE message_id IN (${marks}) UNION SELECT turn_id AS id FROM messages WHERE id IN (${marks}) AND turn_id IS NOT NULL`)
    .all(...answerIds, ...answerIds) as { id: string }[]).map((r) => r.id)
}

/** What one answer's branch (or a whole chat: share-chat.ts chatUse) used: the files its answers read (with the sha256
 * they had), and the scope's other sources when the scope describes it (`known`). */
export interface BranchUse { answers: string[]; files: { path: string; sha256: string | null }[]; other: ReadSource[]; known: boolean; roomsUnseen: boolean }

/** The files these answers read (message_sources, with the sha256 each had), skills/ and .system left out. */
export function filesRead(db: Database, ids: readonly string[]): BranchUse['files'] {
  return ids.length ? (db.query(`SELECT path, sha256 FROM message_sources WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY message_id, ord`).all(...ids) as { path: string; sha256: string | null }[])
    .filter((r) => !notCounted(r.path)) : []
}

/** Did one of these answers run commands in the dev environment (devenv/tool.ts box_shell: a step of it or of its
 * sub-agents, or the dev_env.command audit line of its turn, written even when a crash lost the step)? A command reads
 * whatever the person may read there, and neither the answer's source list nor the read scope records it. */
function ranCommands(db: Database, ids: readonly string[]): boolean {
  if (!ids.length) return false
  if (db.query(`SELECT 1 FROM messages WHERE id IN (${ids.map(() => '?').join(',')}) AND (steps LIKE '%box_shell"%' OR steps LIKE '%"devEnvRun"%') LIMIT 1`).get(...ids)) return true
  const turns = turnsOf(db, ids)
  return turns.length > 0 && !!db.query(`SELECT 1 FROM audit_log WHERE action = 'dev_env.command' AND json_extract(detail, '$.turnId') IN (${turns.map(() => '?').join(',')}) LIMIT 1`).get(...turns)
}

/** The rest of a use once it is known whether the chat's scope describes these answers: the scope's sources the
 * answers' lists do not record (all of them after a turn that never ended), and whether it read rooms the scope does
 * not name. An answer that ran dev environment commands is not all known (ranCommands). */
export function useOf(db: Database, chatId: string, ids: readonly string[], describes: boolean): BranchUse {
  const chat = db.query('SELECT rooms_seen FROM chats WHERE id = ?').get(chatId) as { rooms_seen: number } | null
  const files = filesRead(db, ids)
  const known = describes && !confidentialChat(db, chatId) && !ranCommands(db, ids)
  const scope = known ? scopeWithListing(db, chatId) : null
  // a turn of the branch that never ended (the server stopped mid-answer) saved no source list: its reads are known only
  // as the scope's places, which then all count
  const unended = ids.length > 0 && !!db.query(`SELECT 1 FROM turns WHERE message_id IN (${ids.map(() => '?').join(',')}) AND status IN ('queued','running','interrupted') LIMIT 1`).get(...ids)
  const other = (scope?.sources ?? []).filter((s) => unended || !scope!.listed(s))
  // the chat read a room's messages and the scope does not show which: nobody else is taken to have seen them
  const roomsUnseen = !!chat?.rooms_seen && (!known || !(scope?.sources ?? []).some((s) => s.type === 'room'))
  return { answers: [...ids], files, other, known, roomsUnseen }
}

function branchUse(db: Database, chatId: string, messageId: string): BranchUse {
  const chat = db.query('SELECT id, active_leaf_id FROM chats WHERE id = ?').get(chatId) as Pick<ChatRow, 'id' | 'active_leaf_id'> | null
  const answers = answersAbove(db, messageId)
  return useOf(db, chatId, answers.map((a) => a.id), !!chat && scopeDescribes(db, chat, messageId, answers))
}

/** One linked file as the check sees it. `unable`: member ids who cannot open it now (everyone else when hidden). */
interface Row { link: string; rel: string | null; name: string; size: number; unable: string[]; attach: AnswerShareFile['attach'] }

/** Provenance for one choice of attached files, with what the key binds (`keys`); `hidden`: a member would see a room
 * it read but for old answers hidden from them (never sent); `kept`: what it used, for the message (later members). */
interface Prov { missing: Set<string>; places: AnswerSharePlace[]; otherPlaces: boolean; unknown: boolean; keys: string[]; hidden: boolean; kept: AnswerScopeKept }

/** What a shared answer used, as kept with its message (room_messages.source_scope): the sources checked when it was
 * sent, the files that went with it and the paths it links to (as names), and `unknown` when not all of it is known
 * (the chat's scope did not describe the answer, or it read rooms the scope does not name). A later member of the room
 * sees it only when they may read every source and nothing is unknown (rooms/history.ts). `attached`: each file that
 * went with it as a copy (its room file id), the team path it was copied from and the answer's links that name it, so a
 * member who cannot open the team file opens the copy from the link (rooms/store.ts attachedLinksOf; only the links,
 * which the message's text has, ever leave the server). */
export interface AnswerScopeKept { sources: ReadSource[]; unknown: boolean; attached?: AttachedCopy[] }
/** One file that went with a shared answer as a copy: the room file, its team path when it was copied, the links. */
export interface AttachedCopy { file: string; path: string; links: string[] }

/** Per AppContext: the secret the confirm keys are made with (in memory: a restart asks again). */
const secrets = new WeakMap<AppContext, Buffer>()
const secretOf = (ctx: AppContext) => secrets.get(ctx) ?? secrets.set(ctx, randomBytes(32)).get(ctx)!
/** An opaque key over `state` (HMAC-SHA-256 with this server process's secret): what a person saw when asked. The share
 * of a chat (chat/share-chat.ts) puts `kind: 'chat.share'` in its state; this file's room confirm (confirmKeyOf) has a
 * `roomId` and no `kind`: a key of one question is never one of the other. */
export const confirmMac = (ctx: AppContext, state: unknown): string => createHmac('sha256', secretOf(ctx)).update(JSON.stringify(state)).digest('base64url')

/** The provenance core, without what is particular to a room (the linked files, kept sources): who of the audience
 * misses some of what `uses` read, the places as `userId` may be told them, and what a key binds. */
export interface Provenance { missing: Set<string>; places: AnswerSharePlace[]; otherPlaces: boolean; unknown: boolean; roomsUnseen: boolean; keys: string[]; hidden: boolean; candidates: ReadSource[] }

/**
 * The provenance check of "대화방에 보내기" (B above), for any audience: the room's members but me, or the people of a
 * project but its chat's creator (chat/share-chat.ts). One copy for both. `savedBy`: the answers whose turns' saves the
 * hash rule looks at (the branch, or the whole chat). Everything about other people is ids inside the server; places
 * are named only where `userId` may look now.
 */
export function provenanceChecker(ctx: AppContext, userId: string, audience: readonly string[], savedBy: readonly string[]) {
  const db = ctx.db, rules = ctx.files.rules()
  const me = loadPrincipal(db, userId)
  const mine = fileOpener(ctx, userId)
  const fx = ctx.files.fx
  // a file I may open is the same file on disk for everyone (the walk, links, quarantine and hidden names are the
  // disk's): a member may open it too when the rules let them read its path (rooms/service.ts fileOpener, without a
  // walk per member). An account that is not active reads nothing
  const people = new Map(audience.map((id) => [id, loadPrincipal(db, id)]))
  const reads = (id: string, segs: readonly string[]) => { const p = people.get(id); return !!p && atLeast(rules.access(p, [...segs]), 'read') }
  /** the team file I may open now at `link`: its actual path and size */
  const myFile = (link: string): { rel: string; segs: string[]; size: number } | null => {
    if (!me || !mine(link)) return null
    try { const a = authorize(fx, rules, me, link, 'read'); return a.st?.isFile() ? { rel: a.rel, segs: a.segs, size: a.st.size } : null } catch { return null }
  }
  const everyoneOpens = (rel: string) => { const f = myFile(rel); return !!f && audience.every((id) => reads(id, f.segs)) }

  // what turns of these answers saved, by its hash (the hash rule: a copy every member can open now)
  const saved = new Map<string, Set<string>>()
  const turns = turnsOf(db, savedBy)
  if (turns.length) {
    for (const e of db.query(`SELECT path, sha256 FROM file_events WHERE turn_id IN (${turns.map(() => '?').join(',')}) AND sha256 IS NOT NULL
      AND action IN ('create','update','restore','upload')`).all(...turns) as { path: string; sha256: string }[]) {
      const set = saved.get(e.sha256) ?? saved.set(e.sha256, new Set()).get(e.sha256)!
      set.add(e.path)
    }
  }
  // a file moved by those turns keeps its content (a move records no hash): it is looked at by its hash now
  const moved = turns.length ? (db.query(`SELECT DISTINCT path FROM file_events WHERE turn_id IN (${turns.map(() => '?').join(',')}) AND action = 'create'
    AND sha256 IS NULL AND json_extract(detail, '$.movedFrom') IS NOT NULL AND COALESCE(json_extract(detail, '$.folder'), 0) = 0`).all(...turns) as { path: string }[]).map((r) => r.path) : []
  const hashes = new Map<string, Promise<string | null>>()
  const hashNow = (rel: string) => {
    let p = hashes.get(rel)
    if (!p) {
      p = hashFile(path.join(ctx.files.fx.root, ...rel.split('/'))).catch(() => null)
      hashes.set(rel, p)
    }
    return p
  }
  const coveredCache = new Map<string, Promise<boolean>>()
  /** the hash rule: a turn of these answers saved this content where every member can open it now, and it is still there */
  const covered = (sha: string | null): Promise<boolean> => {
    if (!sha || !audience.length) return Promise.resolve(false)
    let p = coveredCache.get(sha)
    if (!p) {
      p = (async () => {
        for (const rel of [...(saved.get(sha) ?? []), ...moved]) {
          // (a copy I may not open myself is not looked at: nothing about it is told)
          if (!everyoneOpens(rel)) continue
          if ((await hashNow(rel)) === sha) return true
        }
        return false
      })()
      coveredCache.set(sha, p)
    }
    return p
  }

  /** a team folder ('' = the top), named only when I may read it now myself (a rule changed since: not) */
  const folderPlace = (p: string | undefined): AnswerSharePlace | null => (p !== undefined && me && atLeast(rules.access(me, p === '' ? [] : p.split('/')), 'read') ? { kind: 'folder', path: p } : null)
  const placeOf = (s: ReadSource): AnswerSharePlace | null => {
    switch (s.type) {
      case 'root': return folderPlace('')
      case 'folder': return folderPlace((db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null)?.path)
      case 'user': return s.id === userId ? { kind: 'mine' } : null
      case 'integration': { const name = getRow(db, s.id)?.name; return name ? { kind: 'service', name } : null }
      case 'drive_share': { const name = shareRow(db, s.id)?.name; return name ? { kind: 'service', name } : null }
      case 'room': {
        const r = roomRow(db, s.id)
        const team = r?.kind === 'team' ? groupName(db, r) : null
        if (r?.kind === 'all') return { kind: 'room', name: '' }
        if (team) return { kind: 'room', name: team }
        // a 1:1 or group conversation: its name is people's names
        return r?.kind === 'dm' || r?.kind === 'group' ? { kind: 'conversation' } : null
      }
      case 'name': {
        const segs = s.path.split('/').filter(Boolean)
        if (segs[0] === 'users') return segs[1] === userId ? { kind: 'mine' } : null
        const at = sourceOf(db, rules, s.path)
        return at.type === 'name' ? null : placeOf(at)
      }
    }
  }

  /** The provenance of what `uses` read, with `leftOut` (paths or links whose own row tells who sees them) not counted. */
  const of = async (uses: readonly BranchUse[], leftOut: ReadonlySet<string>): Promise<Provenance> => {
    // sources and, for the file ones, whether some file of them is not covered
    const candidates: ReadSource[] = []
    const fileRows = new Map<string, { source: ReadSource; files: { path: string; sha256: string | null }[] }>()
    for (const u of uses) {
      candidates.push(...u.other)
      for (const f of u.files) {
        if (leftOut.has(f.path)) continue
        const source = sourceOf(db, rules, f.path)
        const k = sourceKey(source)
        const entry = fileRows.get(k) ?? fileRows.set(k, { source, files: [] }).get(k)!
        entry.files.push(f)
      }
    }
    const missed = missingReaders(db, rules, [...candidates, ...[...fileRows.values()].map((e) => e.source)], audience, userId)
    // a member who misses a room it read only because of old answers hidden from them (or whose history is not worked
    // out): never shown it, whatever is confirmed
    const audienceSet = new Set(audience)
    let hidden = candidates.some((s) => s.type === 'room' && [...viewersByHistory(db, s.id, undefined, s.fromSeq, userId).hiddenFrom].some((id) => audienceSet.has(id)))
    const missing = new Set<string>()
    const places = new Map<string, AnswerSharePlace>()
    const keys: string[] = []
    let otherPlaces = false
    for (const m of missed) {
      const k = sourceKey(m.source)
      const files = fileRows.get(k)
      // a file-type source from the answers' own lists: left out when every file of it read is covered by the hash rule
      // (only when it came from those lists alone: the scope's unlisted part of the same place still counts)
      if (files && !candidates.some((c) => sourceKey(c) === k)) {
        let all = true
        for (const f of files.files) if (!(await covered(f.sha256))) { all = false; break }
        if (all) continue
      }
      for (const id of m.missing) missing.add(id)
      keys.push(`${k}=${m.missing.join(',')}`)
      const p = placeOf(m.source)
      if (p) places.set(JSON.stringify(p), p)
      else otherPlaces = true
    }
    let unknown = false, roomsUnseen = false
    for (const u of uses) {
      if (!u.known) unknown = true
      if (u.roomsUnseen) { roomsUnseen = true; for (const id of audience) missing.add(id); places.set('{"kind":"conversation"}', { kind: 'conversation' }); keys.push('rooms_seen') }
    }
    if (unknown) { for (const id of audience) missing.add(id); otherPlaces = true; keys.push('unknown') }
    // a chat that read rooms without saying which (this answer's, or the one that made an attached file): any room may be
    // in it, so a member with old answers hidden from them anywhere, or whose history is not worked out yet, is never
    // shown it either (a confirm would carry it past them)
    if (!hidden && roomsUnseen) hidden = audience.some((id) => hiddenAnywhere(db, id))
    return { missing, places: [...places.values()], otherPlaces, unknown, roomsUnseen, keys: keys.sort(), hidden, candidates }
  }

  return { me, rules, people, reads, myFile, hashNow, of }
}

/**
 * The check of one answer for one room, as `userId` sees it now. `answerPart`: the answer's part of the room message
 * (what the room gets: a cut answer's links past the cut are not in it). Everything about other people is ids inside the server; the result for the person is counts and the
 * places they may look themselves.
 */
export async function answerCheck(ctx: AppContext, userId: string, roomId: string, chatId: string, messageId: string, answerPart: string) {
  const db = ctx.db
  // a team room or the everyone room: the members whose history is not worked out yet get it first (rooms/history.ts),
  // for at most DECIDE_HISTORY_MS; one still waiting makes it unsendable (`hidden` below)
  const target = roomRow(db, roomId)
  if (target && historyKinds(target.kind)) try { openHistories(ctx, { roomId, budgetMs: DECIDE_HISTORY_MS, within: true }) } catch (e) { ctx.log.warn('room history not opened', { err: e }) }
  // a disabled or deleted account still in the room reads nothing now: it misses every source and every file
  const audience = (db.query('SELECT user_id FROM room_members WHERE room_id = ? AND user_id <> ? ORDER BY user_id').all(roomId, userId) as { user_id: string }[]).map((r) => r.user_id)
  const use = branchUse(db, chatId, messageId)
  const onBranch = new Set(use.answers)
  // the hash rule looks at what turns on this branch saved
  const pc = provenanceChecker(ctx, userId, audience, use.answers)
  const { me, rules, people, reads, myFile, hashNow } = pc
  const fx = ctx.files.fx
  /** the team folder I may list now at `link` (the app opens such a link on the files screen) */
  const myFolder = (link: string): { rel: string; segs: string[] } | null => {
    if (!me) return null
    try {
      const a = authorize(fx, rules, me, link, 'list')
      return a.st?.isDirectory() && a.segs.length && !a.segs.some((x, i) => badSegment(x) !== null || hiddenEntry(x, i)) ? { rel: a.rel, segs: a.segs } : null
    } catch { return null }
  }

  // ---- A. the linked files ----
  const rows: Row[] = []
  const seenRel = new Set<string>()
  /** every link of the answer (as answerFilePaths names it) that is a file I may open now, and its actual path: the
   * links an attached copy stands for (two links may name one file) */
  const linkRel = new Map<string, string>()
  const links = answerFilePaths(answerPart, ANSWER_SHARE_FILES_MAX + 1)
  // more links than rows: the rest is one row nothing is told about (everyone else counted), so nothing goes unasked
  const more = links.length > ANSWER_SHARE_FILES_MAX
  for (const link of more ? links.slice(0, ANSWER_SHARE_FILES_MAX - 1) : links) {
    const f = myFile(link)
    const dir = f ? null : myFolder(link)
    const at = f ?? dir
    if (!at) { rows.push({ link, rel: null, name: '', size: 0, unable: audience, attach: 'hidden' }); continue }
    if (f) linkRel.set(link, f.rel)
    if (seenRel.has(at.rel)) continue
    seenRel.add(at.rel)
    // a folder: who may list it; it is never attached
    const unable = audience.filter((id) => (f ? !reads(id, at.segs) : !(people.get(id) && rules.canList(people.get(id)!, at.segs))))
    const size = f?.size ?? 0
    rows.push({ link, rel: at.rel, name: at.segs[at.segs.length - 1]!, size, unable, attach: !unable.length || !f ? 'no' : size > SMALL_UPLOAD_MAX ? 'too_big' : 'yes' })
  }
  if (more) rows.push({ link: '', rel: null, name: '', size: 0, unable: audience, attach: 'hidden' })
  /** what the switches start as: the files that may go, the first ROOM_FILES_MAX */
  const offered = rows.filter((r) => r.attach === 'yes').slice(0, ROOM_FILES_MAX).map((r) => r.rel!)

  // ---- B. where the content came from ----
  // an AI-made file that may be attached: what the turn that made it used (only when that turn is not on this branch,
  // whose own use is counted already); looked up once per file, for the files that go. Only a turn of my own chats:
  // another person's chat is never read here (what it used would tell me who they talk to); their file's row already
  // counts who would see it. My own confidential chat counts as not known
  const makers = new Map<string, Promise<BranchUse | null>>()
  const makerOf = (rel: string) => {
    let p = makers.get(rel)
    if (!p) {
      p = (async () => {
        const sha = await hashNow(rel)
        if (!sha) return null
        const ev = db.query(`SELECT e.turn_id, t.message_id, m.chat_id, c.user_id FROM file_events e JOIN turns t ON t.id = e.turn_id JOIN messages m ON m.id = t.message_id
          JOIN chats c ON c.id = m.chat_id WHERE e.path = ? AND e.sha256 = ? AND e.action IN ('create','update') ORDER BY e.id DESC LIMIT 1`).get(rel, sha) as { turn_id: string; message_id: string; chat_id: string; user_id: string } | null
        return !ev || ev.user_id !== userId || onBranch.has(ev.message_id) ? null : branchUse(db, ev.chat_id, ev.message_id)
      })()
      makers.set(rel, p)
    }
    return p
  }

  /** The provenance when `attached` (team paths) go with the message (once per choice). */
  const provs = new Map<string, Promise<Prov>>()
  const provenance = (attached: ReadonlySet<string>): Promise<Prov> => {
    const k = [...attached].sort().join('\n')
    return provs.get(k) ?? provs.set(k, provenanceOf(attached)).get(k)!
  }
  const provenanceOf = async (attached: ReadonlySet<string>): Promise<Prov> => {
    const made = await Promise.all([...attached].map(makerOf))
    const uses: BranchUse[] = [use, ...made.filter((u): u is BranchUse => !!u)]
    const leftOut = new Set([...attached, ...rows.filter((r) => r.rel && attached.has(r.rel)).map((r) => r.link)])
    const p = await pc.of(uses, leftOut)
    // for the message: every source its uses had (covered files too: a later member is judged on what they may read),
    // the files that go with it as their places, the paths it links to as names
    const kept: AnswerScopeKept = {
      sources: [...p.candidates, ...uses.flatMap((u) => u.files.map((f) => sourceOf(db, rules, f.path))), ...[...attached].map((rel) => sourceOf(db, rules, rel)),
        ...rows.filter((r) => r.rel).map((r): ReadSource => ({ type: 'name', path: r.rel! }))],
      unknown: p.unknown || p.roomsUnseen || rows.some((r) => r.rel === null),
    }
    return { missing: p.missing, places: p.places, otherPlaces: p.otherPlaces, unknown: p.unknown, keys: p.keys, hidden: p.hidden, kept }
  }

  /** what an older client is told and sends back (`confirm`): nobody attached, so every row's people count */
  const peopleWithout = async (): Promise<number> => unablePeople({ audience, rows }, new Set(), await provenance(new Set()))

  return { audience, rows, offered, provenance, peopleWithout, linkRel }
}

type Check = Awaited<ReturnType<typeof answerCheck>>

/** Has this person old answers hidden from them in some room, or a team room's or the everyone room's history not
 * worked out yet (rooms/history.ts)? */
function hiddenAnywhere(db: Database, userId: string): boolean {
  return !!db.query('SELECT 1 FROM room_hidden_answers WHERE user_id = ? LIMIT 1').get(userId)
    || !!db.query(`SELECT 1 FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ? AND r.kind IN ('team', 'all') AND r.archived_at IS NULL
      AND m.history_from_seq IS NULL AND m.visible_from_seq > 0 LIMIT 1`).get(userId)
}

/** The members who cannot open a linked file that does not go with the message, or see some of that material. */
const unablePeople = (c: { audience: readonly string[]; rows: readonly Row[] }, attached: ReadonlySet<string>, prov: Prov): number => {
  const ids = new Set(prov.unknown ? c.audience : prov.missing)
  for (const r of c.rows) if (!(r.rel && attached.has(r.rel))) for (const id of r.unable) ids.add(id)
  return ids.size
}

/** The key a "confirm" carries: what the person saw (never any id inside it can be read back). */
function confirmKeyOf(ctx: AppContext, userId: string, roomId: string, messageId: string, c: Check, prov: Prov): string {
  const state = JSON.stringify({
    v: 1, userId, roomId, messageId, members: c.audience,
    files: c.rows.map((r) => [r.rel ?? '', r.attach, r.unable]),
    sources: prov.keys,
  })
  return createHmac('sha256', secretOf(ctx)).update(state).digest('base64url')
}

export interface ShareAnswerInput { roomId: string; note?: string; confirm?: number; confirmKey?: string; attach?: string[]; clientMessageId: string }

/** POST /api/chats/:id/messages/:messageId/share-to-room. `chat` is the caller's own (routes/chats.ts ownChat: not a
 * room's AI session, not deleted) and `message` one of its messages. */
export async function shareAnswerToRoom(ctx: AppContext, userId: string, chat: ChatRow, message: MessageRow, b: ShareAnswerInput, locale: Locale): Promise<ShareAnswerToRoomResult> {
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
  const { body, at, cut } = answerShareBody(b.note, content, answerCutLine(locale))
  // and one more for every LINKS_PER_TOKEN links past the first: a row per file is a count per file, so an answer made to
  // link many paths costs as many sends
  const linkCount = answerFilePaths(body.slice(at), ANSWER_SHARE_FILES_MAX + 1).length
  for (let n = LINKS_PER_TOKEN; n < linkCount; n += LINKS_PER_TOKEN) rooms.takeSendToken(userId)
  const c = await answerCheck(ctx, userId, room.id, chat.id, message.id, body.slice(at))
  const offered = new Set(c.offered)
  const shown = await c.provenance(offered)
  if (shown.hidden) fail('conflict', tr('answerShareHidden', locale), { params: { reason: 'answer_share_hidden' } })
  // (a room with nobody else in it: nobody to miss anything)
  const applies = c.audience.length > 0 && (c.rows.some((r) => r.unable.length > 0) || shown.missing.size > 0 || shown.unknown)
  const key = confirmKeyOf(ctx, userId, room.id, message.id, c, shown)
  let attach: string[] = []
  let people = 0
  let confirmed = false
  if (applies) {
    if (b.confirmKey !== undefined) {
      // only files of this answer that may go: nothing else of the team folder rides along
      const may = new Set(c.rows.filter((r) => r.attach === 'yes').map((r) => r.rel!))
      attach = [...new Set(b.attach ?? [])]
      if (attach.some((p) => !may.has(p))) {
        if (b.confirmKey === key) fail('validation', undefined, { fields: { 'body.attach': 'not a file of this answer that can be attached' } })
        // a file that could go before and cannot now (I lost access, it grew, it is gone): asked again
        return await confirmOf(c, shown, key, 'changed')
      }
      const chosen = new Set(attach)
      const mine = await c.provenance(chosen)
      if (mine.hidden) fail('conflict', tr('answerShareHidden', locale), { params: { reason: 'answer_share_hidden' } })
      const mineKey = confirmKeyOf(ctx, userId, room.id, message.id, c, mine)
      // the key is for the line as it reads with the files I chose (turning a switch off can bring a file's place into
      // it, an attached AI-made file what made it): the same state with another line is asked again for that choice
      if (b.confirmKey !== mineKey) return b.confirmKey === key ? await confirmOf(c, mine, mineKey, 'choice') : await confirmOf(c, shown, key, 'changed')
      people = unablePeople(c, chosen, mine)
    } else if (b.confirm !== undefined) {
      // an older client: nothing attached; it goes when no more people are unable than it said yes to
      if (b.attach?.length) fail('validation', undefined, { fields: { 'body.attach': 'only with confirmKey' } })
      people = await c.peopleWithout()
      if (people > b.confirm) return await confirmOf(c, shown, key)
    } else return await confirmOf(c, shown, key)
    confirmed = true
  }
  // (nothing applies now, also after a "confirm": every member can open every link, so nothing needs to be attached)
  // the copies first (my read access checked again, the limits of an upload), then the message with them
  const files = roomFilesOf(ctx)
  const fileIds: string[] = []
  const copies: AttachedCopy[] = []
  try {
    for (const rel of attach) {
      const id = (await files.fromTeamFile(userId, room.id, rel)).id
      fileIds.push(id)
      copies.push({ file: id, path: rel, links: [...c.linkRel].filter(([, r]) => r === rel).map(([link]) => link) })
    }
    // audited with the message (Rooms.send: room.answer_share); the copies and the links they stand for are kept with it
    const kept: AnswerScopeKept = { ...(await c.provenance(new Set(attach))).kept, ...(copies.length ? { attached: copies } : {}) }
    const m = rooms.send(userId, room.id, { body, mentions: [], fileIds, clientMessageId: b.clientMessageId }, {}, { at, cut, people, confirmed, scope: JSON.stringify(kept) })
    return { status: 'sent', message: m, cut }
  } finally {
    // copies that did not go (a failure, or the same request sent twice at once): not left behind
    files.discardUnsent(userId, room.id, fileIds)
  }
}

/** The "confirm" answer: rows, the provenance line for the files that go (the ones offered, or the ones I chose), the
 * key; `reason` when it is asked again (something changed meanwhile, or my choice of files changed the line). For older
 * clients the count and the places with nothing attached. */
async function confirmOf(c: Check, prov: Prov, confirmKey: string, reason?: 'changed' | 'choice'): Promise<ShareAnswerToRoomResult> {
  const files: AnswerShareFile[] = c.rows.map((r) => (r.rel === null
    ? { name: '', missing: true, attach: 'hidden', unable: c.audience.length }
    : { name: r.name, path: r.rel, missing: false, attach: r.attach, unable: r.unable.length }))
  const people = prov.unknown ? c.audience.length : prov.missing.size
  const provenance: AnswerShareProvenance | null = people > 0 ? { people, places: prov.places, otherPlaces: prov.otherPlaces, ...(prov.unknown ? { unknown: true as const } : {}) } : null
  const hidden = c.rows.some((r) => r.rel === null)
  const none = await c.provenance(new Set())
  return {
    status: 'confirm', people: Math.max(1, await c.peopleWithout()), places: none.places, otherPlaces: none.otherPlaces || hidden,
    files, provenance, confirmKey, ...(reason ? { reason } : {}),
  }
}
