// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a person's own chat opened from a room's side
// panel (chats.side_room_id, migration 276). The turn tells the AI the room (chat/prompt.ts sideRoomSection) while the
// person is still in it and it is not archived; after that the chat is an ordinary chat of theirs.
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import { atLeast, isStaff, loadPrincipal, type Principal } from '../policy/access'
import { groupName } from '../rooms/store'
import type { SideRoomPrompt } from './prompt'

/** The room this chat was opened from, while its person is still in that room and the room is not archived; else null.
 * Its name as the app shows it: its own, else its group's (a team room); null for a DM or a group chat without one.
 * `files`: also where the AI saves the room's content (saveIn; the turn's instructions need it, a room lookup does not). */
export function sideRoomOf(db: Database, chatId: string, userId: string, files?: FileService): SideRoomPrompt | null {
  const r = db.query(`SELECT r.id, r.kind, r.name, r.group_id FROM chats c JOIN rooms r ON r.id = c.side_room_id AND r.archived_at IS NULL
    JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = c.user_id WHERE c.id = ? AND c.user_id = ?`).get(chatId, userId) as (SideRoomPrompt & { group_id: string | null }) | null
  if (!r) return null
  const saveIn = files ? saveInFor(db, files, r, userId) : undefined
  return { id: r.id, kind: r.kind, name: r.kind === 'dm' ? null : r.name || groupName(db, r), ...(saveIn ? { saveIn } : {}) }
}

/**
 * Where the AI saves what comes from the room when the person names no place (docs/decisions/
 * 20261116-room-link-save-one-prompt.md, 20261116-flow-regressions-0512-save-place.md; QA TC-3833): where the room's
 * people can open it. A team room: its group's folder. The Everyone room: shared/ (its meeting-notes or other fitting
 * subfolder, by the placement rule). A group chat: the folder of the smallest group that every member of the room who is
 * not an owner or admin belongs to (owners and admins read every group's folder), else shared/. A 1:1, a guest asking,
 * or a place the person cannot write: the person's own folder (a private talk is not for a department by default).
 * Before, a group chat saved in the person's own folder, which the room's people could not open (AI flow FL-28, the
 * owner's own case, 2026-11-17). A few queries per turn: no access walk per person and folder.
 */
export function saveInFor(db: Database, files: FileService, r: { id: string; kind: SideRoomPrompt['kind']; group_id: string | null }, userId: string): string {
  const own = `users/${userId}`
  if (r.kind === 'team' && r.group_id) {
    const f = db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(r.group_id) as { path: string } | null
    if (f?.path) return f.path
  }
  if (r.kind === 'all') return 'shared'
  if (r.kind !== 'group') return own
  const rules = files.rules()
  const me = loadPrincipal(db, userId)
  if (!me || rules.isGuest(me)) return own
  const members = (db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(r.id) as { user_id: string }[])
    .map((m) => loadPrincipal(db, m.user_id)).filter((p): p is Principal => !!p && !rules.isGuest(p))
  const plain = members.filter((p) => !isStaff(p))
  const writable = (rel: string) => atLeast(rules.access(me, rel.split('/')), 'write') && members.every((p) => atLeast(rules.access(p, rel.split('/')), 'read'))
  if (plain.length) {
    const ids = plain.map((p) => p.id)
    // the groups every plain member is in, smallest first (the fewest people outside the room)
    const rows = db.query(`SELECT f.path, (SELECT COUNT(*) FROM group_members a WHERE a.group_id = g.id) AS n FROM groups g JOIN folders f ON f.id = g.folder_id
      WHERE (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.user_id IN (${ids.map(() => '?').join(',')})) = ? ORDER BY n, f.path`).all(...ids, ids.length) as { path: string }[]
    for (const g of rows) if (g.path && writable(g.path)) return g.path
  }
  return writable('shared') ? 'shared' : own
}
