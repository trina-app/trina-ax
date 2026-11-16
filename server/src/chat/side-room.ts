// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a person's own chat opened from a room's side
// panel (chats.side_room_id, migration 276). The turn tells the AI the room (chat/prompt.ts sideRoomSection) while the
// person is still in it and it is not archived; after that the chat is an ordinary chat of theirs.
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { FileService } from '../files/service'
import { atLeast, loadPrincipal, type Principal } from '../policy/access'
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
 * 20261116-room-link-save-one-prompt.md, 20261116-flow-regressions-0512-save-place.md; QA TC-3833): where the
 * room's people can open it. A team room: its group's folder. The Everyone room: shared/ (its meeting-notes or other
 * fitting subfolder, by the placement rule). A group chat or a 1:1: the team folder (a group's or a project's, else
 * shared/) that every team member in it can read and the fewest people outside it can; a 1:1 that only shared/ fits
 * stays in the person's own folder (a private talk is not for the whole company). The person must be able to write
 * there. Before, a group chat saved in the person's own folder, which the room's people could not open (AI flow FL-28,
 * the owner's own case, 2026-11-17).
 */
export function saveInFor(db: Database, files: FileService, r: { id: string; kind: SideRoomPrompt['kind']; group_id: string | null }, userId: string): string {
  const own = `users/${userId}`
  if (r.kind === 'team' && r.group_id) {
    const f = db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(r.group_id) as { path: string } | null
    if (f?.path) return f.path
  }
  if (r.kind === 'all') return 'shared'
  if (r.kind !== 'group' && r.kind !== 'dm') return own
  const rules = files.rules()
  const me = loadPrincipal(db, userId)
  if (!me || rules.isGuest(me)) return own
  const memberIds = new Set((db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(r.id) as { user_id: string }[]).map((m) => m.user_id))
  const people = (db.query("SELECT id FROM users WHERE status = 'active'").all() as { id: string }[]).map((u) => loadPrincipal(db, u.id)).filter((p): p is Principal => !!p)
  const members = people.filter((p) => memberIds.has(p.id))
  const team = members.filter((p) => !rules.isGuest(p))
  const guests = members.filter((p) => rules.isGuest(p))
  const outside = people.filter((p) => !memberIds.has(p.id))
  const reads = (p: Principal, segs: string[]) => atLeast(rules.access(p, segs), 'read')
  const there = (rel: string) => { try { return fs.statSync(path.join(files.fx.root, ...rel.split('/'))).isDirectory() } catch { return false } }
  const groupFolders = (db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id').all() as { path: string }[]).map((x) => x.path)
  const projectFolders = (db.query("SELECT folder_path AS path FROM projects WHERE folder_path LIKE 'projects/%' AND trashed_with IS NULL").all() as { path: string }[]).map((x) => x.path)
  let best: { path: string; outside: number; guests: number } | null = null
  for (const rel of [...new Set([...groupFolders, ...projectFolders])].sort().concat('shared')) {
    const segs = rel.split('/')
    if (!rel || !there(rel) || !atLeast(rules.access(me, segs), 'write') || !team.every((p) => reads(p, segs))) continue
    // fewest people outside the room who could open it (none: no wider-audience card), then the most guests of the room
    const c = { path: rel, outside: outside.filter((p) => reads(p, segs)).length, guests: guests.filter((p) => reads(p, segs)).length }
    if (!best || c.outside < best.outside || (c.outside === best.outside && c.guests > best.guests)) best = c
  }
  if (!best || (best.path === 'shared' && r.kind === 'dm')) return own
  return best.path
}
