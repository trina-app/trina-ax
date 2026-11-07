// "Read scope" of a chat (design tab 7 "공용 폴더를 거친 유출", tab 1 chats.session_read_scope): where the content
// that went into the model came from, so the server can notice when the AI is about to save it somewhere MORE
// people can see (a hidden instruction in a shared document makes a finance member's AI copy finance numbers into
// shared/). Sources, not people, are stored: viewers are computed from the rules at the time of the write, so a
// changed rule or a new member never leaves a stale set behind.
//   {type:'folder', id}  the nearest folder with rules above a file (folders.id: survives renames and moves)
//   {type:'root'}        no rule folder above it: the team folder's default (owner and admins)
//   {type:'user', id}    users/<id>/…, and what the in-app browser showed the person (only they saw it, via
//                        'browser'), and what a personal external-service connection or personal Google Drive returned
//                        (via 'connection'). A row without via is own-folder content, or (a scope written before via
//                        existed) any of the three
//   {type:'integration', id}  what a team external-service connection returned: its viewers are the active people its
//                        access rules allow today (integrations/connections/store.ts)
//   {type:'drive_share', id}  what a Google Drive an admin shares with the team returned: its viewers are the active
//                        people its rule includes today (integrations/google-drive/shares.ts)
//   {type:'room', id, fromSeq}  messages of a team chat room the AI got as context there (rooms/ai.ts), the oldest of
//                        them at seq fromSeq: its viewers are the room's members today who see the room from before
//                        that message (rooms/store.ts seesFrom) and to whom no old answer from there on is hidden
//                        (room_hidden_answers, rooms/history.ts), but for the person who read it: what is hidden from
//                        them was never given to them
//   {type:'name', path}  a room session only (chat/turn.ts noteRoomTool): a team path whose name the tools showed or
//                        answered about (a sub-folder in a listing, a path a call named: there, a folder, not there),
//                        nothing of its content. Its viewers are the people who would see the same name in a listing
//                        (RuleSet.canList: they may read it, or something below it). Kept as the path: it lives for
//                        one question (rooms/ai.ts), and a folder renamed meanwhile is judged by the rules at its
//                        old path
// null (no sources yet) = no limit. read and grep results count; list / glob (names only), skills, memories and the
// person's own messages do not (in a room session names count too, rooms/ai.ts).
// Stored as {sources, v: 2, unlisted}: a scope started by this build (v 2) also keeps the keys of the file-type sources
// (folder, root, own folder) that came at least once from something other than a read the answer's source list records
// (message_sources, files/sources.ts): an attachment, project instructions, a skill, make_file's inputs, more than the
// list holds. "대화방에 보내기" (chat/answer-share.ts) goes by the source list's files for the others (each with its
// sha256). A scope without v (written before) has every source counted as it is.
import type { Database } from 'bun:sqlite'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { getRow, usersOf } from '../integrations/connections/store'
import { shareRow, shareUsers } from '../integrations/google-drive/shares'

export type ReadSource = { type: 'folder'; id: string } | { type: 'user'; id: string; via?: 'browser' | 'connection' } | { type: 'root' } | { type: 'integration'; id: string } | { type: 'drive_share'; id: string } | { type: 'room'; id: string; fromSeq?: number } | { type: 'name'; path: string }

/** One string per source (deduplication, and what the person already allowed for a folder in this turn). */
export const sourceKey = (s: ReadSource) => (s.type === 'root' ? 'root' : s.type === 'room' ? `room:${s.id}:${s.fromSeq ?? 0}` : s.type === 'name' ? `name:${s.path}` : s.type === 'user' && s.via ? `user:${s.id}:${s.via}` : `${s.type}:${s.id}`)
const key = sourceKey
/** One string per place as a card names it: a person's folder, browser and personal connections are one ("my folder") */
const placeKey = (s: ReadSource) => (s.type === 'user' ? `user:${s.id}` : key(s))

/** The source of a team-folder file (relative path with actual names). */
export function sourceOf(db: Database, rules: RuleSet, rel: string): ReadSource {
  const segs = rel.split('/').filter(Boolean)
  if (segs[0] === 'users' && segs.length >= 2) return { type: 'user', id: segs[1]! }
  const ruled = new Set(rules.ruleFolders())
  for (let len = segs.length; len >= 0; len--) {
    const p = segs.slice(0, len).join('/')
    if (!ruled.has(p)) continue
    const row = db.query('SELECT id FROM folders WHERE path = ?').get(p) as { id: string } | null
    if (row) return { type: 'folder', id: row.id }
  }
  return { type: 'root' }
}

interface StoredScope { sources: ReadSource[]; v?: 2; unlisted?: string[] }

function storedScope(db: Database, chatId: string): StoredScope | null {
  const row = db.query('SELECT session_read_scope AS s FROM chats WHERE id = ?').get(chatId) as { s: string | null } | null
  if (!row?.s) return null
  try {
    const v = JSON.parse(row.s) as Partial<StoredScope>
    if (!Array.isArray(v.sources)) return null
    return { sources: v.sources, ...(v.v === 2 ? { v: 2 as const, unlisted: Array.isArray(v.unlisted) ? v.unlisted.filter((k): k is string => typeof k === 'string') : [] } : {}) }
  } catch { return null }
}

export function readScope(db: Database, chatId: string): ReadSource[] | null {
  return storedScope(db, chatId)?.sources ?? null
}

/** A team-folder or own-folder source (what file reads add): a folder, the top, users/<id>/ without via. */
export const isFileSource = (s: ReadSource) => s.type === 'folder' || s.type === 'root' || (s.type === 'user' && !s.via)

/**
 * The scope with, for each file-type source, whether the answer's source lists (message_sources) record all that went
 * in from it (`listed`): only in a scope this build started (v 2), and only when no attachment, instructions, skill or
 * other unrecorded input added it. null: no scope.
 */
export function scopeWithListing(db: Database, chatId: string): { sources: ReadSource[]; listed: (s: ReadSource) => boolean } | null {
  const sc = storedScope(db, chatId)
  if (!sc) return null
  const unlisted = new Set(sc.unlisted ?? [])
  return { sources: sc.sources, listed: (s) => sc.v === 2 && isFileSource(s) && !unlisted.has(key(s)) }
}

/** Add sources to a chat's scope (deduplicated). `listed`: they come from reads the answer's source list records
 * (files/sources.ts SourceLog; chat/turn.ts noteReads); anything else (the default) is marked as not listed. */
export function addSources(db: Database, chatId: string, add: ReadSource[], o: { listed?: boolean } = {}): void {
  if (!add.length) return
  db.transaction(() => {
    // a scope started now keeps which file-type sources are not listed (v 2); one from before stays as it was
    const cur: StoredScope = storedScope(db, chatId) ?? { sources: [], v: 2, unlisted: [] }
    const seen = new Set(cur.sources.map(key))
    const unlisted = new Set(cur.unlisted ?? [])
    let changed = false
    for (const s of add) {
      if (!seen.has(key(s))) { seen.add(key(s)); cur.sources.push(s); changed = true }
      if (cur.v === 2 && !o.listed && isFileSource(s) && !unlisted.has(key(s))) { unlisted.add(key(s)); changed = true }
    }
    if (changed) db.query('UPDATE chats SET session_read_scope = ? WHERE id = ?').run(JSON.stringify(cur.v === 2 ? { sources: cur.sources, v: 2, unlisted: [...unlisted] } : { sources: cur.sources }), chatId)
  })()
}

export function clearScope(db: Database, chatId: string): void {
  db.query('UPDATE chats SET session_read_scope = NULL WHERE id = ?').run(chatId)
}

function activePeople(db: Database): Principal[] {
  const ids = db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]
  return ids.map((r) => loadPrincipal(db, r.id)).filter((p): p is Principal => !!p)
}

/** Who may read what came from this source, under today's rules. A folder row that is gone: nobody (asks). `reader`:
 * the person whose read it was (a room source: what is hidden from them was never given to them). */
export function viewersOf(db: Database, rules: RuleSet, s: ReadSource, people: Principal[], reader?: string | null): Set<string> {
  if (s.type === 'user') return new Set(people.some((p) => p.id === s.id) ? [s.id] : [])
  if (s.type === 'integration') return usersOf(db, s.id)
  if (s.type === 'drive_share') return shareRow(db, s.id) ? shareUsers(db, s.id) : new Set()
  if (s.type === 'room') return roomViewers(db, s.id, people, s.fromSeq, reader)
  if (s.type === 'name') { const segs = nameSegs(s.path); return new Set(people.filter((p) => rules.canList(p, segs)).map((p) => p.id)) }
  let segs: string[] = []
  if (s.type === 'folder') {
    const row = db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null
    if (!row) return new Set()
    segs = row.path === '' ? [] : row.path.split('/')
  }
  return new Set(people.filter((p) => atLeast(rules.access(p, segs), 'read')).map((p) => p.id))
}

/** A name source's path as the rules compare it. */
export const nameSegs = (p: string) => p.split('/').filter(Boolean)

/** The active people in a room now (an archived room: nobody); with `fromSeq`, only those who see the room from before
 * the message at that seq (rooms/store.ts seesFrom). Someone to whom an old answer at or after `fromSeq` is hidden
 * (room_hidden_answers) is not one of them, whatever the source held, but for `reader`, the person whose read it was:
 * what is hidden from them was never given to them (and a read of theirs reaching themselves widens nothing). */
export function roomViewers(db: Database, roomId: string, people?: Principal[], fromSeq?: number, reader?: string | null): Set<string> {
  return viewersByHistory(db, roomId, people, fromSeq, reader).see
}

/** roomViewers, and apart: the members who would see the room from `fromSeq` but for old answers hidden from them (or
 * whose team-room history is not worked out yet: what they will see is not known) — someone may be asked to confirm
 * sending to people who cannot read a source, never past those (chat/answer-share.ts). */
export function viewersByHistory(db: Database, roomId: string, people?: Principal[], fromSeq?: number, reader?: string | null): { see: Set<string>; hiddenFrom: Set<string> } {
  const rows = db.query(`SELECT m.user_id, (m.user_id <> ?4 AND EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = m.user_id AND h.see_seq >= ?3)) hid,
      (r.kind IN ('team', 'all') AND m.history_from_seq IS NULL AND m.visible_from_seq >= ?2) waits
    FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.room_id = ?1 AND r.archived_at IS NULL
      AND (COALESCE(m.history_from_seq, m.visible_from_seq) < ?2 OR (r.kind IN ('team', 'all') AND m.history_from_seq IS NULL))`)
    .all(roomId, fromSeq ?? Number.MAX_SAFE_INTEGER, fromSeq ?? 0, reader ?? '') as { user_id: string; hid: number; waits: number }[]
  const active = new Set((people ?? activePeople(db)).map((p) => p.id))
  const see = new Set<string>(), hiddenFrom = new Set<string>()
  for (const r of rows) {
    if (!active.has(r.user_id)) continue
    if (r.hid || r.waits) hiddenFrom.add(r.user_id)
    else see.add(r.user_id)
  }
  return { see, hiddenFrom }
}

export interface Widening {
  /** sources whose readers do not include everyone who can read the target */
  narrower: ReadSource[]
  /** how many people can read the target */
  targetViewers: number
}

/**
 * Would saving at `targetSegs` let more people see what this chat read (plus `extra` sources, e.g. make_file's
 * source file, embedded images and template)? null = no. chatId null: only `extra` (a tool call outside a chat).
 */
export function widening(db: Database, chatId: string | null, targetSegs: string[], extra: ReadSource[] = []): Widening | null {
  const sources = [...((chatId ? readScope(db, chatId) : null) ?? []), ...extra]
  if (!sources.length) return null
  const rules = RuleSet.load(db)
  const people = activePeople(db)
  const reader = chatId ? (db.query('SELECT user_id FROM chats WHERE id = ?').get(chatId) as { user_id: string } | null)?.user_id ?? null : null
  const target = people.filter((p) => atLeast(rules.access(p, targetSegs), 'read')).map((p) => p.id)
  const narrower = sources.filter((s, i) => sources.findIndex((x) => placeKey(x) === placeKey(s)) === i)
    .filter((s) => { const v = viewersOf(db, rules, s, people, reader); return target.some((id) => !v.has(id)) })
  return narrower.length ? { narrower, targetViewers: target.length } : null
}

/**
 * For each source (each once, in order), the people of `audience` (user ids) who may not see what came from it under
 * today's rules: the readers widening() goes by. An id that is not an active account reads nothing. Only sources that
 * someone misses are returned ("대화방에 보내기", chat/answer-share.ts: the room's members who could not read what an
 * answer used).
 */
export function missingReaders(db: Database, rules: RuleSet, sources: readonly ReadSource[], audience: readonly string[], reader?: string | null): { source: ReadSource; missing: string[] }[] {
  if (!sources.length || !audience.length) return []
  const people = activePeople(db)
  const seen = new Set<string>()
  const out: { source: ReadSource; missing: string[] }[] = []
  for (const s of sources) {
    if (seen.has(key(s))) continue
    seen.add(key(s))
    const v = viewersOf(db, rules, s, people, reader)
    const missing = audience.filter((id) => !v.has(id))
    if (missing.length) out.push({ source: s, missing })
  }
  return out
}

/**
 * Would a message sent in this room let more people see what `sources` came from (an AI app's connection sending as
 * the person, connectors/remote-mcp/rooms.ts)? Its readers are the room's members who will see it: everyone in it, or
 * for a thread reply those who see its first message (`root`). A member whose account cannot read now (disabled: a
 * 1:1 chat keeps them) still counts and reads nothing, as in the room's AI (rooms/ai.ts decide): they would read the
 * message once enabled again. null = no.
 */
export function roomWidening(db: Database, roomId: string, sources: ReadSource[], root?: { id: string; seq: number }, reader?: string | null): Widening | null {
  if (!sources.length) return null
  const rules = RuleSet.load(db)
  const people = activePeople(db)
  // who will see it: everyone in the room; for a thread reply those who see its first message: in a team room or the
  // everyone room every member to whom it is not hidden (one whose history is not open yet too: it opens to them, and
  // then they see the thread), elsewhere who was in the room before it (rooms/ai.ts readers, the same audience)
  const history = !!db.query("SELECT 1 FROM rooms WHERE id = ? AND kind IN ('team', 'all')").get(roomId)
  const target = (db.query(`SELECT m.user_id FROM room_members m WHERE m.room_id = ?1 AND (?3 OR COALESCE(m.history_from_seq, m.visible_from_seq) < ?2)
      AND NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = m.user_id AND h.message_id = ?4)`)
    .all(roomId, root?.seq ?? Number.MAX_SAFE_INTEGER, history || !root ? 1 : 0, root?.id ?? '') as { user_id: string }[]).map((r) => r.user_id)
  const narrower = sources.filter((s, i) => sources.findIndex((x) => placeKey(x) === placeKey(s)) === i)
    .filter((s) => { const v = viewersOf(db, rules, s, people, reader); return target.some((id) => !v.has(id)) })
  return narrower.length ? { narrower, targetViewers: target.length } : null
}

/** Where a source is, for the confirmation card. `ownNames`: a room by the name its members gave it (the card, shown to
 * the person as text); without it by the server's name only (anything the AI reads back: any member of a group chat may
 * set its own name). */
export function sourceLabel(db: Database, s: ReadSource, me: string, text: { mine: string; root: string; room?: string }, o: { ownNames?: boolean } = {}): string {
  if (s.type === 'root') return text.root
  if (s.type === 'room') return (text.room ?? 'room {name}').replace('{name}', roomName(db, s.id, !!o.ownNames))
  if (s.type === 'user') return s.id === me ? text.mine : `users/${s.id}/`
  if (s.type === 'name') { const segs = nameSegs(s.path); return segs[0] === 'users' && segs[1] === me ? text.mine : segs.length ? segs.join('/') : text.root }
  if (s.type === 'integration') return getRow(db, s.id)?.name ?? '?'
  if (s.type === 'drive_share') return shareRow(db, s.id)?.name ?? 'Google Drive'
  const row = db.query('SELECT path FROM folders WHERE id = ?').get(s.id) as { path: string } | null
  return row ? (row.path === '' ? text.root : row.path + '/') : '?'
}

/** A room as a card names it: its own name when it has one and `own` (to the person, shown as text; never for the AI),
 * the group's name for a team room, the other members' names otherwise. */
export function roomName(db: Database, roomId: string, own = false): string {
  const r = db.query('SELECT r.kind, r.name own, g.name FROM rooms r LEFT JOIN groups g ON g.id = r.group_id WHERE r.id = ?').get(roomId) as { kind: string; own: string | null; name: string | null } | null
  if (!r) return '?'
  if (own && r.kind !== 'dm' && r.own) return r.own
  if (r.kind === 'team' && r.name) return r.name
  const names = (db.query('SELECT u.name FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.name LIMIT 4').all(roomId) as { name: string }[]).map((x) => x.name)
  return names.join(', ') || '?'
}
