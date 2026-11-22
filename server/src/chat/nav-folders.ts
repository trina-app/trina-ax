// List folders (docs/DECISIONS.md "List folders"; migration 289; contract shared/src/api/nav-folders.ts). A person's own
// folders for sorting their lists: kind 'chats' (the Trina history's sections) holds AI chats of their history, kind
// 'rooms' the rooms, DMs and group chats they are in. Only the maker sees them (every query is by the caller's id;
// another person's folder answers 404, owners and admins included: there is no admin path and nothing is audited, so no
// folder name lands anywhere else). A folder never reveals something its maker cannot open now: what it lists and counts goes through the
// one check below (visibleChatItems / VISIBLE_ROOM_ITEMS), nothing else re-implements it. A chat is in a section only
// while it is in the person's history (chat/history-list.ts, the history list's own rule; owner decision 2026-11-22):
// their own chats, project chats included, the shared project chats they wrote in and the chats shared with them by
// name or through a group. One they lose (taken out of the project, unshared, hidden from their list) drops out on
// read; its row stays and comes back with it.
//
// Clean-up (the check would hide the rows anyway; these keep the table small and the rules plain):
//   - a chat to the trash: its rows go (routes/chats.ts deleteChat, dropChatFolderItems); restoring does not put it back;
//   - a person out of a room (left, taken out, a group's change): its row goes (rooms/service.ts forgetMember);
//   - a hidden or an archived room keeps its row, filtered on read (a hidden room comes back by itself when something
//     arrives, and back in its folder);
//   - the person's account deleted: admin/users.ts deletes their rows (the users row stays as a tombstone);
//   - a purge of the chat or room, or the folder deleted: the FK cascade.
import type { Database } from 'bun:sqlite'
import { NAV_FOLDER_ITEMS_MAX, NAV_FOLDER_TOP, NAV_FOLDERS_MAX, navFolderName, type Chat, type Locale, type NavFolder, type NavFolderKind, type Room } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { fail } from '../http/errors'
import { roomsOf } from '../rooms/service'
import { tr } from './i18n'
import { historyWhere, inHistory } from './history-list'
import { isInternalChat } from './internal-chats'
import type { ChatRuntime } from './runtime'
import { Audiences, chatFor, chatView } from './shared'
import { CHAT_COLS, type ChatRow } from './store'

interface FolderRow { id: string; user_id: string; kind: NavFolderKind; name: string; name_key: string; position: number; created_at: string; updated_at: string }

/** The key that makes a name unique per person and kind: NFC, trimmed, lower case in every language. */
export const nameKey = (name: string): string => navFolderName(name).toLowerCase()

// ---------------- the one visibility check ----------------
/** One of my filed chats that my history shows now. */
interface FiledChat { folderId: string; row: ChatRow }
/**
 * My rows of chats (kind 'chats', of every folder, or of one) whose chat is in my Trina history now, by the history's
 * own rule (chat/history-list.ts: historyWhere, then inHistory per row), newest first. A row of a chat I cannot see in
 * my history (the trash, a room's AI session, a server draft, a project I left, a chat no longer shared with me or
 * hidden from my list) is left out. At most NAV_FOLDERS_MAX × NAV_FOLDER_ITEMS_MAX rows (makeRoom).
 */
export function visibleChatItems(rt: Pick<ChatRuntime, 'db' | 'files'>, userId: string, folderId?: string, aud = new Audiences(rt.db, rt.files)): FiledChat[] {
  const h = historyWhere(rt.db, userId)
  const rows = rt.db.query(`SELECT i.folder_id AS i_folder_id, c.* FROM nav_folder_items i JOIN (SELECT ${CHAT_COLS} FROM chats WHERE ${h.sql}) c ON c.id = i.chat_id
      WHERE i.user_id = ? AND i.kind = 'chats'${folderId ? ' AND i.folder_id = ?' : ''} ORDER BY c.updated_at DESC, c.id DESC`)
    .all(...h.args, userId, ...(folderId ? [folderId] : [])) as (ChatRow & { i_folder_id: string })[]
  const out: FiledChat[] = []
  for (const { i_folder_id, ...row } of rows) if (inHistory(aud, userId, row)) out.push({ folderId: i_folder_id, row })
  return out
}
/** Is this one chat in my history now (the rule of visibleChatItems, for one row)? */
export function chatInHistory(rt: Pick<ChatRuntime, 'db' | 'files'>, userId: string, r: ChatRow, aud = new Audiences(rt.db, rt.files)): boolean {
  const h = historyWhere(rt.db, userId)
  return !!rt.db.query(`SELECT 1 FROM chats WHERE id = ? AND ${h.sql}`).get(r.id, ...h.args) && inHistory(aud, userId, r)
}
/**
 * `i` = nav_folder_items, `m` = room_members, `r` = rooms: the person's rows of rooms they are in now, not archived, not
 * hidden by them, filed while a member this time (a row older than their member row is never theirs to show). Bind:
 * the person's id (once).
 */
export const VISIBLE_ROOM_ITEMS = `nav_folder_items i JOIN room_members m ON m.room_id = i.room_id AND m.user_id = i.user_id
    JOIN rooms r ON r.id = i.room_id
    WHERE i.user_id = ?1 AND i.kind = 'rooms' AND r.archived_at IS NULL AND m.hidden_at IS NULL AND i.added_at >= m.joined_at`

function roomCounts(db: Database, userId: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of db.query(`SELECT i.folder_id f, COUNT(*) n FROM ${VISIBLE_ROOM_ITEMS} GROUP BY i.folder_id`).all(userId) as { f: string; n: number }[]) out.set(r.f, r.n)
  return out
}

// ---------------- folders ----------------
function folderOut(f: FolderRow, count: number, top: Chat[]): NavFolder {
  return { id: f.id, kind: f.kind, name: f.name, position: f.position, count, top }
}
/** One of my folders (of that kind), or 404: someone else's answers exactly like one that is not there. */
function mine(db: Database, userId: string, id: string, kind?: NavFolderKind): FolderRow {
  const f = db.query('SELECT * FROM nav_folders WHERE id = ? AND user_id = ?').get(id, userId) as FolderRow | null
  if (!f || (kind && f.kind !== kind)) return fail('not_found')
  return f
}
function folders(db: Database, userId: string, kind?: NavFolderKind): FolderRow[] {
  return (kind
    ? db.query('SELECT * FROM nav_folders WHERE user_id = ? AND kind = ? ORDER BY position, created_at, id').all(userId, kind)
    : db.query("SELECT * FROM nav_folders WHERE user_id = ? ORDER BY CASE kind WHEN 'chats' THEN 0 ELSE 1 END, position, created_at, id").all(userId)) as FolderRow[]
}
const changed = (ctx: AppContext, userId: string, kind: NavFolderKind) =>
  ctx.services.realtime.publish(userId, { type: 'navFolders.changed', data: { kind } })

/** My folders, both kinds, each with what I can open in it now and (chat folders) its first chats. */
export function listNavFolders(rt: ChatRuntime, userId: string): NavFolder[] {
  const db = rt.db
  const all = folders(db, userId)
  if (!all.length) return []
  const counts = roomCounts(db, userId)
  // each chat folder's count and its NAV_FOLDER_TOP most recently active chats (the rows come newest first)
  const tops = new Map<string, Chat[]>()
  if (all.some((f) => f.kind === 'chats')) {
    const aud = new Audiences(db, rt.files)
    for (const { folderId: f, row } of visibleChatItems(rt, userId, undefined, aud)) {
      counts.set(f, (counts.get(f) ?? 0) + 1)
      const top = tops.get(f) ?? tops.set(f, []).get(f)!
      if (top.length < NAV_FOLDER_TOP) top.push(chatView(rt, userId, row, { aud }))
    }
  }
  return all.map((f) => folderOut(f, counts.get(f.id) ?? 0, tops.get(f.id) ?? []))
}

function one(rt: ChatRuntime, userId: string, id: string): NavFolder {
  return listNavFolders(rt, userId).find((f) => f.id === id) ?? fail('not_found')
}

const nameTaken = (locale: Locale) => fail('conflict', tr('navFolderNameTaken', locale), { fields: { 'body.name': 'nav_folder_name_taken' }, params: { reason: 'nav_folder_name_taken' } })
const isUniqueClash = (e: unknown) => e instanceof Error && /UNIQUE constraint failed: nav_folders\./.test(e.message)

export function createNavFolder(rt: ChatRuntime, userId: string, kind: NavFolderKind, rawName: string, locale: Locale): NavFolder {
  const db = rt.db
  const name = navFolderName(rawName), key = nameKey(rawName)
  const id = newId()
  db.transaction(() => {
    const n = (db.query('SELECT COUNT(*) n, MAX(position) p FROM nav_folders WHERE user_id = ? AND kind = ?').get(userId, kind) as { n: number; p: number | null })
    if (n.n >= NAV_FOLDERS_MAX) fail('conflict', tr('navFoldersFull', locale, { n: String(NAV_FOLDERS_MAX) }), { params: { reason: 'nav_folders_full' } })
    if (db.query('SELECT 1 FROM nav_folders WHERE user_id = ? AND kind = ? AND name_key = ?').get(userId, kind, key)) nameTaken(locale)
    const now = nowIso()
    try {
      db.query('INSERT INTO nav_folders (id, user_id, kind, name, name_key, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, userId, kind, name, key, (n.p ?? -1) + 1, now, now)
    } catch (e) { if (isUniqueClash(e)) nameTaken(locale); throw e }
  })()
  changed(rt.ctx, userId, kind)
  return one(rt, userId, id)
}

export function renameNavFolder(rt: ChatRuntime, userId: string, id: string, rawName: string, locale: Locale): NavFolder {
  const db = rt.db
  const f = mine(db, userId, id)
  const name = navFolderName(rawName), key = nameKey(rawName)
  if (name !== f.name) {
    if (db.query('SELECT 1 FROM nav_folders WHERE user_id = ? AND kind = ? AND name_key = ? AND id <> ?').get(userId, f.kind, key, id)) nameTaken(locale)
    try {
      db.query('UPDATE nav_folders SET name = ?, name_key = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(name, key, nowIso(), id, userId)
    } catch (e) { if (isUniqueClash(e)) nameTaken(locale); throw e }
    changed(rt.ctx, userId, f.kind)
  }
  return one(rt, userId, id)
}

/** Only the folder goes: its rows go with it (cascade), its chats and rooms are where they were. The chats and rooms
 * that were in it get my chat.updated / room.updated (their folderId is gone). */
export function deleteNavFolder(rt: ChatRuntime, userId: string, id: string): void {
  const db = rt.db
  const f = mine(db, userId, id)
  const items = db.query('SELECT chat_id, room_id FROM nav_folder_items WHERE folder_id = ? AND user_id = ?').all(id, userId) as { chat_id: string | null; room_id: string | null }[]
  db.transaction(() => {
    db.query('DELETE FROM nav_folders WHERE id = ? AND user_id = ?').run(id, userId)
    // close the gap: the others keep their order, numbered 0..n-1 again
    renumber(db, userId, f.kind, [])
  })()
  changed(rt.ctx, userId, f.kind)
  const rooms = roomsOf(rt.ctx)
  for (const it of items) {
    if (it.chat_id) chatChanged(rt, userId, it.chat_id)
    if (it.room_id) rooms.roomEvent(it.room_id, 'updated', new Set([userId]))
  }
}

/** `first` of my folders of that kind in that order, then the rest in their order before. */
function renumber(db: Database, userId: string, kind: NavFolderKind, first: readonly string[]) {
  const now = folders(db, userId, kind)
  const byId = new Map(now.map((f) => [f.id, f]))
  const seen = new Set<string>()
  const order: FolderRow[] = []
  for (const id of first) { const f = byId.get(id); if (f && !seen.has(id)) { seen.add(id); order.push(f) } }
  for (const f of now) if (!seen.has(f.id)) order.push(f)
  const set = db.query('UPDATE nav_folders SET position = ? WHERE id = ? AND user_id = ? AND position <> ?')
  order.forEach((f, i) => set.run(i, f.id, userId, i))
}

/** Any subset of my folders of one kind, in the order wanted; unknown ids (another person's, the other kind, gone)
 * are ignored, so two devices that reorder at once both succeed: the last one's order wins. */
export function orderNavFolders(rt: ChatRuntime, userId: string, kind: NavFolderKind, ids: readonly string[]): NavFolder[] {
  rt.db.transaction(() => renumber(rt.db, userId, kind, ids))()
  changed(rt.ctx, userId, kind)
  return listNavFolders(rt, userId)
}

// ---------------- items ----------------
/** Room for one more in the folder: rows that do not show now go first, then the limit is checked against every row
 * left. Chats: rows that fail visibleChatItems (not in my history now: the trash, a chat I lost, a draft). Rooms: rows of rooms
 * I left or that are archived, or filed before I joined again; a hidden room's row stays (it comes back) and counts. */
function makeRoom(rt: Pick<ChatRuntime, 'db' | 'files'>, userId: string, f: FolderRow, locale: Locale) {
  const db = rt.db
  const total = () => (db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE folder_id = ? AND user_id = ?').get(f.id, userId) as { n: number }).n
  if (total() < NAV_FOLDER_ITEMS_MAX) return
  if (f.kind === 'chats') {
    const keep = visibleChatItems(rt, userId, f.id).map((x) => x.row.id)
    db.query("DELETE FROM nav_folder_items WHERE folder_id = ? AND user_id = ? AND kind = 'chats' AND chat_id NOT IN (SELECT value FROM json_each(?))").run(f.id, userId, JSON.stringify(keep))
  }
  else db.query(`DELETE FROM nav_folder_items WHERE folder_id = ?2 AND user_id = ?1 AND rowid NOT IN (SELECT i.rowid FROM nav_folder_items i
      JOIN room_members m ON m.room_id = i.room_id AND m.user_id = i.user_id JOIN rooms r ON r.id = i.room_id
      WHERE i.user_id = ?1 AND i.folder_id = ?2 AND r.archived_at IS NULL AND i.added_at >= m.joined_at)`).run(userId, f.id)
  if (total() >= NAV_FOLDER_ITEMS_MAX) fail('conflict', tr('navFolderFull', locale, { n: String(NAV_FOLDER_ITEMS_MAX) }), { params: { reason: 'nav_folder_full' } })
}

/** My view of the chat (its folderId mine) to my windows alone, while it is in my history (never a chat I lost: a folder
 * deleted with a row of one says nothing about it). */
function chatChanged(rt: ChatRuntime, userId: string, chatId: string): Chat | null {
  const r = rt.store.chatRow(chatId)
  if (!r) return null
  const aud = new Audiences(rt.db, rt.files)
  if (!chatInHistory(rt, userId, r, aud)) return null
  const chat = chatView(rt, userId, r, { aud })
  rt.ctx.services.realtime.publish(userId, { type: 'chat.updated', data: { chatId, change: 'updated', chat } })
  return chat
}

/** Put a chat of my history (chat/history-list.ts: mine, project chats included, or shared with me) in one of my chat
 * folders, or take it out (null). Only my row changes and only I am told: nobody else learns of my folders. */
export function setChatFolder(rt: ChatRuntime, userId: string, chatId: string, folderId: string | null, locale: Locale): Chat {
  const db = rt.db
  // a chat I cannot open, one in the trash, a room's AI session: 404 (chatFor), and so is a draft the server runs for its
  // own work (it is in no list)
  const a = chatFor(rt, userId, chatId, 'view', { locale })
  if (isInternalChat(db, a.row.id)) return fail('not_found')
  if (folderId === null) {
    if (db.query('DELETE FROM nav_folder_items WHERE user_id = ? AND chat_id = ?').run(userId, a.row.id).changes) {
      changed(rt.ctx, userId, 'chats')
      return chatChanged(rt, userId, a.row.id) ?? chatView(rt, userId, a.row)
    }
    return chatView(rt, userId, a.row)
  }
  // only a chat my history shows (the history's own rule): not a project's shared chat I never wrote in (it is on the
  // project's page only), not one I hid from my list
  if (!chatInHistory(rt, userId, a.row)) fail('conflict', tr('navFolderNotInHistory', locale), { params: { reason: 'folder_not_in_history' } })
  const f = mine(db, userId, folderId, 'chats')
  const now = db.query('SELECT folder_id FROM nav_folder_items WHERE user_id = ? AND chat_id = ?').get(userId, a.row.id) as { folder_id: string } | null
  if (now?.folder_id === f.id) return chatView(rt, userId, a.row)
  db.transaction(() => {
    makeRoom(rt, userId, f, locale)
    db.query('DELETE FROM nav_folder_items WHERE user_id = ? AND chat_id = ?').run(userId, a.row.id)
    db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, 'chats', ?, NULL, ?)").run(f.id, userId, a.row.id, nowIso())
  })()
  changed(rt.ctx, userId, 'chats')
  return chatChanged(rt, userId, a.row.id) ?? chatView(rt, userId, a.row)
}

/** Put a room I am in in one of my conversation folders, or take it out (null). Nobody else is told. */
export function setRoomFolder(ctx: AppContext, userId: string, roomId: string, folderId: string | null, locale: Locale): Room {
  const db = ctx.db
  const rooms = roomsOf(ctx)
  // not in it, archived, unknown: 404 alike
  const { me } = rooms.mine(userId, roomId)
  if (folderId === null) {
    if (db.query('DELETE FROM nav_folder_items WHERE user_id = ? AND room_id = ?').run(userId, roomId).changes) {
      changed(ctx, userId, 'rooms')
      rooms.roomEvent(roomId, 'updated', new Set([userId]))
    }
    return rooms.get(userId, roomId)
  }
  if (me.hidden_at) fail('conflict', tr('navFolderRoomHidden', locale), { params: { reason: 'room_hidden' } })
  const f = mine(db, userId, folderId, 'rooms')
  const now = db.query('SELECT folder_id, added_at FROM nav_folder_items WHERE user_id = ? AND room_id = ?').get(userId, roomId) as { folder_id: string; added_at: string } | null
  if (now?.folder_id === f.id && now.added_at >= me.joined_at) return rooms.get(userId, roomId)
  db.transaction(() => {
    makeRoom({ db, files: ctx.files }, userId, f, locale)
    db.query('DELETE FROM nav_folder_items WHERE user_id = ? AND room_id = ?').run(userId, roomId)
    db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, ?, 'rooms', NULL, ?, ?)").run(f.id, userId, roomId, nowIso())
  })()
  changed(ctx, userId, 'rooms')
  rooms.roomEvent(roomId, 'updated', new Set([userId]))
  return rooms.get(userId, roomId)
}

/** Everyone's rows of these chats (they went to the trash). Returns who had one. */
export function dropChatFolderItems(db: Database, chatIds: readonly string[]): Set<string> {
  const who = new Set<string>()
  for (const id of chatIds) for (const r of db.query('DELETE FROM nav_folder_items WHERE chat_id = ? RETURNING user_id').all(id) as { user_id: string }[]) who.add(r.user_id)
  return who
}
/** Tell these people their chat folders changed (after dropChatFolderItems). */
export function chatFoldersChanged(ctx: AppContext, who: Iterable<string>): void {
  for (const u of who) changed(ctx, u, 'chats')
}

/** The chats in one of my folders, for GET /api/chats?folderId= (the folder must be mine: 404 otherwise), by the same
 * check as the folder list (visibleChatItems). */
export function folderChatFilter(rt: Pick<ChatRuntime, 'db' | 'files'>, userId: string, folderId: string): { where: string; args: string[] } {
  mine(rt.db, userId, folderId, 'chats')
  return { where: 'id IN (SELECT value FROM json_each(?))', args: [JSON.stringify(visibleChatItems(rt, userId, folderId).map((x) => x.row.id))] }
}
