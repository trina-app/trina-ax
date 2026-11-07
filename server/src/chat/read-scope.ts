// "Read scope" of a chat (design tab 7 "공용 폴더를 거친 유출", tab 1 chats.session_read_scope): where the content
// that went into the model came from, so the server can notice when the AI is about to save it somewhere MORE
// people can see (a hidden instruction in a shared document makes a finance member's AI copy finance numbers into
// shared/). Sources, not people, are stored: viewers are computed from the rules at the time of the write, so a
// changed rule or a new member never leaves a stale set behind.
//   {type:'folder', id}  the nearest folder with rules above a file (folders.id: survives renames and moves)
//   {type:'root'}        no rule folder above it: the team folder's default (owner and admins)
//   {type:'user', id}    users/<id>/…, and what the in-app browser showed the person (only they saw it), and what a
//                        personal external-service connection returned
//   {type:'integration', id}  what a team external-service connection returned: its viewers are the active people its
//                        access rules allow today (integrations/connections/store.ts)
//   {type:'drive_share', id}  what a Google Drive an admin shares with the team returned: its viewers are the active
//                        people its rule includes today (integrations/google-drive/shares.ts)
//   {type:'room', id, fromSeq}  messages of a team chat room the AI got as context there (rooms/ai.ts), the oldest of
//                        them at seq fromSeq: its viewers are the room's members today who could see that message
//                        (they were in the room before it)
//   {type:'name', path}  a room session only (chat/turn.ts noteRoomTool): a team path whose name the tools showed or
//                        answered about (a sub-folder in a listing, a path a call named: there, a folder, not there),
//                        nothing of its content. Its viewers are the people who would see the same name in a listing
//                        (RuleSet.canList: they may read it, or something below it). Kept as the path: it lives for
//                        one question (rooms/ai.ts), and a folder renamed meanwhile is judged by the rules at its
//                        old path
// null (no sources yet) = no limit. read and grep results count; list / glob (names only), skills, memories and the
// person's own messages do not (in a room session names count too, rooms/ai.ts).
import type { Database } from 'bun:sqlite'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { getRow, usersOf } from '../integrations/connections/store'
import { shareRow, shareUsers } from '../integrations/google-drive/shares'

export type ReadSource = { type: 'folder'; id: string } | { type: 'user'; id: string } | { type: 'root' } | { type: 'integration'; id: string } | { type: 'drive_share'; id: string } | { type: 'room'; id: string; fromSeq?: number } | { type: 'name'; path: string }

/** One string per source (deduplication, and what the person already allowed for a folder in this turn). */
export const sourceKey = (s: ReadSource) => (s.type === 'root' ? 'root' : s.type === 'room' ? `room:${s.id}:${s.fromSeq ?? 0}` : s.type === 'name' ? `name:${s.path}` : `${s.type}:${s.id}`)
const key = sourceKey

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

export function readScope(db: Database, chatId: string): ReadSource[] | null {
  const row = db.query('SELECT session_read_scope AS s FROM chats WHERE id = ?').get(chatId) as { s: string | null } | null
  if (!row?.s) return null
  try {
    const v = JSON.parse(row.s) as { sources?: ReadSource[] }
    return Array.isArray(v.sources) ? v.sources : null
  } catch { return null }
}

/** Add sources to a chat's scope (deduplicated). */
export function addSources(db: Database, chatId: string, add: ReadSource[]): void {
  if (!add.length) return
  db.transaction(() => {
    const cur = readScope(db, chatId) ?? []
    const seen = new Set(cur.map(key))
    let changed = false
    for (const s of add) if (!seen.has(key(s))) { seen.add(key(s)); cur.push(s); changed = true }
    if (changed) db.query('UPDATE chats SET session_read_scope = ? WHERE id = ?').run(JSON.stringify({ sources: cur }), chatId)
  })()
}

export function clearScope(db: Database, chatId: string): void {
  db.query('UPDATE chats SET session_read_scope = NULL WHERE id = ?').run(chatId)
}

function activePeople(db: Database): Principal[] {
  const ids = db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]
  return ids.map((r) => loadPrincipal(db, r.id)).filter((p): p is Principal => !!p)
}

/** Who may read what came from this source, under today's rules. A folder row that is gone: nobody (asks). */
function viewersOf(db: Database, rules: RuleSet, s: ReadSource, people: Principal[]): Set<string> {
  if (s.type === 'user') return new Set(people.some((p) => p.id === s.id) ? [s.id] : [])
  if (s.type === 'integration') return usersOf(db, s.id)
  if (s.type === 'drive_share') return shareRow(db, s.id) ? shareUsers(db, s.id) : new Set()
  if (s.type === 'room') return roomViewers(db, s.id, people, s.fromSeq)
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

/** The active people in a room now (an archived room: nobody); with `fromSeq`, only those who can see the room's
 * message at that seq (who were in the room before it). */
export function roomViewers(db: Database, roomId: string, people?: Principal[], fromSeq?: number): Set<string> {
  const ids = (db.query('SELECT m.user_id FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.room_id = ? AND r.archived_at IS NULL AND m.visible_from_seq < ?')
    .all(roomId, fromSeq ?? Number.MAX_SAFE_INTEGER) as { user_id: string }[]).map((r) => r.user_id)
  const active = new Set((people ?? activePeople(db)).map((p) => p.id))
  return new Set(ids.filter((id) => active.has(id)))
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
  const target = people.filter((p) => atLeast(rules.access(p, targetSegs), 'read')).map((p) => p.id)
  const narrower = sources.filter((s, i) => sources.findIndex((x) => key(x) === key(s)) === i)
    .filter((s) => { const v = viewersOf(db, rules, s, people); return target.some((id) => !v.has(id)) })
  return narrower.length ? { narrower, targetViewers: target.length } : null
}

/**
 * Would a message sent in this room let more people see what `sources` came from (an AI app's connection sending as
 * the person, connectors/remote-mcp/rooms.ts)? Its readers are the room's members who will see it: everyone in it, or
 * for a thread reply those who see its first message (`rootSeq`). A member whose account cannot read now (disabled: a
 * 1:1 chat keeps them) still counts and reads nothing, as in the room's AI (rooms/ai.ts decide): they would read the
 * message once enabled again. null = no.
 */
export function roomWidening(db: Database, roomId: string, sources: ReadSource[], rootSeq?: number): Widening | null {
  if (!sources.length) return null
  const rules = RuleSet.load(db)
  const people = activePeople(db)
  const target = (db.query('SELECT user_id FROM room_members WHERE room_id = ? AND visible_from_seq < ?').all(roomId, rootSeq ?? Number.MAX_SAFE_INTEGER) as { user_id: string }[]).map((r) => r.user_id)
  const narrower = sources.filter((s, i) => sources.findIndex((x) => key(x) === key(s)) === i)
    .filter((s) => { const v = viewersOf(db, rules, s, people); return target.some((id) => !v.has(id)) })
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
