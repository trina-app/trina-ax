// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a person's own chat opened from a room's side
// panel (chats.side_room_id, migration 276). The turn tells the AI the room (chat/prompt.ts sideRoomSection) while the
// person is still in it and it is not archived; after that the chat is an ordinary chat of theirs.
import type { Database } from 'bun:sqlite'
import type { FileService } from '../files/service'
import { atLeast, isStaff, loadPrincipal, type Principal } from '../policy/access'
import { getTeamSettings } from '../admin/settings'
import { groupName } from '../rooms/store'
import { activeProjectOf } from '../rooms/project-link'
import type { SideRoomPrompt } from './prompt'

/** The room this chat was opened from, while its person is still in that room and the room is not archived; else null.
 * Its name as the app shows it: its own, else its group's (a team room); null for a DM or a group chat without one.
 * `files`: also where the AI saves the room's content (saveIn; the turn's instructions need it, a room lookup does not). */
export function sideRoomOf(db: Database, chatId: string, userId: string, files?: FileService): SideRoomPrompt | null {
  const r = db.query(`SELECT r.id, r.kind, r.name, r.group_id FROM chats c JOIN rooms r ON r.id = c.side_room_id AND r.archived_at IS NULL
    JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = c.user_id WHERE c.id = ? AND c.user_id = ?`).get(chatId, userId) as (SideRoomPrompt & { group_id: string | null }) | null
  if (!r) return null
  const save = files ? savePlaceFor(db, files, r, userId) : undefined
  return { id: r.id, kind: r.kind, name: r.kind === 'dm' ? null : r.name || groupName(db, r), ...(save ? { saveIn: save.path } : {}), ...(save?.shareWith?.length ? { shareWith: save.shareWith } : {}), ...(save?.project ? { project: { name: save.project, folderPath: save.path } } : {}) }
}

/** Where room content is saved, and (a group chat that only the company-wide folder holds) the room's other people to
 * share the saved file with, by name (savePlaceFor). */
export interface SavePlace { path: string; shareWith?: string[]; /** the place is the channel's linked project's folder: its name (rooms/project-link.ts) */ project?: string }

/** The place alone (savePlaceFor's path). */
export function saveInFor(db: Database, files: FileService, r: { id: string; kind: SideRoomPrompt['kind']; group_id: string | null }, userId: string): string {
  return savePlaceFor(db, files, r, userId).path
}

/**
 * Where the AI saves what comes from the room when the person names no place (docs/decisions/
 * 20261116-room-link-save-one-prompt.md, 20261116-flow-regressions-0512-save-place.md,
 * 20261117-room-notes-not-company-wide.md; QA TC-3833, MAN-026): where the room's people can open it. A team room: its
 * group's folder. The Everyone room: shared/ (its meeting-notes or other fitting subfolder, by the placement rule). A
 * group chat: the folder of the smallest group that every member of the room who is not an owner or admin belongs to
 * (owners and admins read every group's folder). When no group holds them all and the team has people outside the room,
 * the person's own folder; the file is shared with the room's other people (share_with_person) only when the person asks
 * to share or send it (docs/decisions/20261123-fewer-asks-b5.md: before, the AI shared it after every save, with a card
 * nobody asked for). Before 20261117, it went to shared/, which the whole team can open (MAN-026: notes from a 3-person room in Company-wide ›
 * Meeting notes, 10 people). shared/ stays the place when everyone in the team is in the room, or when the person may
 * not share their own files (the team's "Members can share files they own" is off). A 1:1, a guest asking, or a place
 * the person cannot write: the person's own folder (a private talk is not for a department by default). A few queries
 * per turn: no access walk per person and folder.
 */
export function savePlaceFor(db: Database, files: FileService, r: { id: string; kind: SideRoomPrompt['kind']; group_id: string | null }, userId: string): SavePlace {
  const own = { path: `users/${userId}` }
  // a guest asking: their own folder, first, whatever the room (docs/decisions/20261119-channel-project-link.md D7)
  const asker = loadPrincipal(db, userId)
  if (!asker || files.rules().isGuest(asker)) return own
  // a private channel linked to a team project (rooms/project-link.ts): the project's folder, when the asker can open and
  // write it (the link active, judged now); else the order below
  if (r.kind === 'group') {
    const p = activeProjectOf(db, r.id)
    if (p) {
      const rules = files.rules(), segs = p.folder_path.split('/')
      if (rules.canList(asker, segs) && atLeast(rules.access(asker, segs), 'write')) return { path: p.folder_path, project: p.name }
    }
  }
  if (r.kind === 'team' && r.group_id) {
    const f = db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(r.group_id) as { path: string } | null
    if (f?.path) return { path: f.path }
  }
  if (r.kind === 'all') return { path: 'shared' }
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
    for (const g of rows) if (g.path && writable(g.path)) return { path: g.path }
  }
  // only the company-wide folder holds them all: is anyone in the team outside the room?
  const inRoom = new Set(members.map((p) => p.id))
  const team = (db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL AND guest = 0").all() as { id: string }[])
  const outside = team.some((u) => !inRoom.has(u.id))
  const mayShare = isStaff(me) || getTeamSettings(db).memberFileShares !== false
  const others = members.filter((p) => p.id !== me.id)
  if (outside && mayShare && others.length) return { path: own.path, shareWith: others.map((p) => p.name) }
  return writable('shared') ? { path: 'shared' } : own
}
