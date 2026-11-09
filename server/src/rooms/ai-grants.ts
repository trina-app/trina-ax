// "이 방에서는 항상 허용" (docs/DECISIONS.md "대화방에서 새 파일은 미리 허용"): the person who asked @트리나 in a room lets it
// make new team files in one folder and its subfolders there, without the room's change card, for 30 days (migration
// 266, room_ai_grants). A grant only skips that person's card: the folder rules, the skill-write card, the
// wider-audience card and where the answer goes are decided as before. The calls a grant may cover (new files and files
// the same answer made, never skills or instruction files, never a top folder) are chosen in chat/turn.ts; this module
// keeps the rows and checks, every time one is used, that nothing it was given under has changed:
// - 30 days have not passed;
// - the person is still in the room and the room is not archived;
// - nobody joined the room since its card was raised (their words were never weighed when it was given);
// - who may read and who may write the folder is the same (folderAudience: the people with access there and theirs);
// - it is the same folder (a folder renamed away and another made with its name is not it: folderId);
// - every member of the room, the person too, may write the target (a grant adds nothing a member could not do);
// - the target's own folder has no folder rules of its own below the granted folder, and the same readers and writers;
// - the team's switch (TeamSettings.roomAlwaysAllow) is on: off, grants are ignored, not deleted.
// A lapsed grant is deleted when it is found so (any later change back does not bring it back); leaving the room deletes
// the person's grants there (rooms/service.ts forgetMember). Audit: room.ai_grant (made), room.ai_grant_revoke (deleted:
// the person, a lapse, leaving), room.ai_grant_use (a card skipped by a grant, or by this answer's [이번만 허용]: `once`),
// each naming a DM or a group chat by its kind only.
import type { Database } from 'bun:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AiAllowance } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { newId, nowIso } from '../db'
import { loadPrincipal, type Principal, type RuleSet } from '../policy/access'
import { authorize, type FsCtx } from '../policy/authorize'
import { members, memberRow, roomAuditRef, roomOut, roomRow, type RoomRow } from './store'

/** how long a grant lasts */
export const ROOM_GRANT_DAYS = 30
const DAY_MS = 86_400_000

export type GrantLapse = 'expired' | 'left' | 'member_joined' | 'audience' | 'no_write' | 'folder_changed'
export interface GrantRow { id: string; user_id: string; room_id: string; folder: string; folder_id: string; scope: 'new_files'; audience: string; members_since: string; turn_id: string | null; created_at: string; expires_at: string }

/** May the team's rooms offer "항상" and use grants (the admin switch, on by default)? */
export const grantsOn = (db: Database): boolean => getTeamSettings(db).roomAlwaysAllow !== false

/** Every active person with their groups (the people a folder's rules decide for). */
function activePeople(db: Database): Principal[] {
  const users = db.query("SELECT id, name, role FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY id").all() as { id: string; name: string; role: Principal['role'] }[]
  const groups = new Map<string, string[]>()
  for (const m of db.query('SELECT group_id, user_id FROM group_members ORDER BY group_id').all() as { group_id: string; user_id: string }[]) groups.set(m.user_id, [...(groups.get(m.user_id) ?? []), m.group_id])
  return users.map((u) => ({ ...u, groups: groups.get(u.id) ?? [] }))
}

/** Who may read and who may write `segs` (a folder, actual names), as one hash: the active people with access there and
 * what access, like tools/file-moves.ts compares audiences (identities, never names, leave this module). People with no
 * access are left out: a new account that cannot open the folder changes nothing. */
export function folderAudience(db: Database, rules: RuleSet, segs: readonly string[]): string {
  const rows = activePeople(db).flatMap((p) => { const a = rules.access(p, segs); return a === 'none' ? [] : [`${p.id}\u0000${a}`] }).sort()
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

/** The active people who may read `segs` (the wider-audience check's target readers, chat/turn.ts widenNeed). */
export function readersOf(db: Database, rules: RuleSet, segs: readonly string[]): string[] {
  return activePeople(db).filter((p) => rules.access(p, segs) !== 'none').map((p) => p.id)
}

/** Which folder on disk `segs` (actual names) is: its device and inode, so a folder renamed away and another made with
 * the same name is told apart from it. null: not a folder there. */
export function folderId(fx: FsCtx, segs: readonly string[]): string | null {
  try {
    const st = fs.lstatSync(path.join(fx.root, ...segs))
    return st.isDirectory() ? `${st.dev}:${st.ino}` : null
  } catch { return null }
}

/** A folder below `from` (exclusive) on the way to `to` (inclusive) that has folder rules of its own: coverage stops
 * there. Both are actual names, `from` a prefix of `to`. */
export function ruledBetween(rules: RuleSet, from: readonly string[], to: readonly string[]): boolean {
  const ruled = new Set(rules.ruleFolders())
  for (let n = from.length + 1; n <= to.length; n++) if (ruled.has(to.slice(0, n).join('/'))) return true
  return false
}

/** Is `folder` (actual names) `granted` or below it? */
export function within(granted: readonly string[], folder: readonly string[]): boolean {
  return granted.length <= folder.length && granted.every((s, i) => folder[i] === s)
}

/** May every member of the room now write `rel` (a file, new or not)? An account that cannot be loaded, an error or a
 * room with nobody: no (fails closed). */
export function everyoneWrites(db: Database, fx: FsCtx, rules: RuleSet, roomId: string, rel: string): boolean {
  const ms = members(db, roomId)
  if (!ms.length) return false
  for (const m of ms) {
    const p = loadPrincipal(db, m.user_id)
    if (!p) return false
    try { authorize(fx, rules, p, rel, 'write', { createDirs: true }) } catch { return false }
  }
  return true
}

/** One grant's reasons to lapse now, checked in order; null: still good. The target checks are covers()'s. */
function lapse(db: Database, fx: FsCtx, rules: RuleSet, g: GrantRow, now = Date.now()): GrantLapse | null {
  if (Date.parse(g.expires_at) <= now) return 'expired'
  const room = roomRow(db, g.room_id)
  if (!room || room.archived_at || !memberRow(db, g.room_id, g.user_id)) return 'left'
  // someone joined at or after its card was raised: their messages were not there when it was given (a writer who joined
  // while the card waited counts too; fails closed on the same ms)
  if (db.query('SELECT 1 FROM room_members WHERE room_id = ? AND joined_at >= ? LIMIT 1').get(g.room_id, g.members_since)) return 'member_joined'
  const segs = g.folder.split('/')
  if (folderAudience(db, rules, segs) !== g.audience) return 'audience'
  const me = loadPrincipal(db, g.user_id)
  if (!me) return 'no_write'
  try {
    const r = authorize(fx, rules, me, g.folder, 'write', { mustExist: true })
    if (!r.st?.isDirectory() || r.rel !== g.folder) return 'no_write'
  } catch { return 'no_write' }
  if (folderId(fx, segs) !== g.folder_id) return 'folder_changed'
  return null
}

function revoke(db: Database, g: GrantRow, reason: GrantLapse | 'person' | 'left', actor: string | null) {
  const room = roomRow(db, g.room_id)
  db.query('DELETE FROM room_ai_grants WHERE id = ?').run(g.id)
  audit(db, { actor, action: 'room.ai_grant_revoke', target: g.id, detail: { ...(room ? roomAuditRef(room) : {}), folder: g.folder, reason } })
}

/** Make (or renew for another 30 days) the grant of `userId` in `roomId` for `folder` (actual names, a folder that is
 * there). `since`: when its card was raised (anyone who joined the room at or after it lapses the grant). Audited
 * room.ai_grant. */
export function createGrant(db: Database, fx: FsCtx, rules: RuleSet, o: { userId: string; roomId: string; folder: string; turnId: string | null; since: string }): GrantRow {
  const room = roomRow(db, o.roomId)
  if (!room) throw new Error('no such room')
  const id = folderId(fx, o.folder.split('/'))
  if (!id) throw new Error('not a folder')
  const now = new Date()
  const row: GrantRow = {
    id: newId(), user_id: o.userId, room_id: o.roomId, folder: o.folder, folder_id: id, scope: 'new_files', audience: folderAudience(db, rules, o.folder.split('/')),
    members_since: o.since, turn_id: o.turnId, created_at: now.toISOString(), expires_at: new Date(now.getTime() + ROOM_GRANT_DAYS * DAY_MS).toISOString(),
  }
  db.transaction(() => {
    db.query("DELETE FROM room_ai_grants WHERE user_id = ? AND room_id = ? AND folder = ? AND scope = 'new_files'").run(o.userId, o.roomId, o.folder)
    db.query('INSERT INTO room_ai_grants (id, user_id, room_id, folder, folder_id, scope, audience, members_since, turn_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.room_id, row.folder, row.folder_id, row.scope, row.audience, row.members_since, row.turn_id, row.created_at, row.expires_at)
    audit(db, { actor: o.userId, action: 'room.ai_grant', target: row.id, detail: { ...roomAuditRef(room), folder: o.folder, days: ROOM_GRANT_DAYS, turnId: o.turnId } })
  })()
  return row
}

/**
 * The grant that covers a new file (or a file this answer made) at `segs` (actual names: the file) for `userId` asking
 * in `roomId`, or null. Lapsed grants met on the way are deleted (audited); with the team's switch off none is looked
 * at. The deepest granted folder that still holds wins. A grant covers the target when the target's folder is the
 * granted folder or below it with no folder rules of its own on the way, has the same readers and writers, and every
 * member of the room may write the target. A hit is audited room.ai_grant_use.
 */
export function grantFor(db: Database, fx: FsCtx, rules: RuleSet, o: { userId: string; roomId: string; segs: readonly string[]; tool: string; turnId: string | null }): GrantRow | null {
  if (!grantsOn(db)) return null
  const folder = o.segs.slice(0, -1)
  const rows = (db.query("SELECT * FROM room_ai_grants WHERE user_id = ? AND room_id = ? AND scope = 'new_files'").all(o.userId, o.roomId) as GrantRow[])
    .filter((g) => within(g.folder.split('/'), folder))
    .sort((a, b) => b.folder.length - a.folder.length)
  for (const g of rows) {
    const why = lapse(db, fx, rules, g)
    if (why) { revoke(db, g, why, null); continue }
    const granted = g.folder.split('/')
    if (ruledBetween(rules, granted, folder) || folderAudience(db, rules, folder) !== g.audience) continue
    if (!everyoneWrites(db, fx, rules, o.roomId, o.segs.join('/'))) continue
    const room = roomRow(db, o.roomId)!
    audit(db, { actor: o.userId, action: 'room.ai_grant_use', target: g.id, detail: { ...roomAuditRef(room), folder: g.folder, path: o.segs.join('/'), tool: o.tool, turnId: o.turnId } })
    return g
  }
  return null
}

/** A call this answer's [이번만 허용] for its folder let through without a card: audited like a grant's use (`once`, no
 * grant), so the room's answer names its file too (grantMadeFiles). `rooms`: the room of a room session, or the rooms
 * the person's own chat read (`chat`: docs/DECISIONS.md "대화방을 읽은 뒤 카드 줄이기"); several are named under `rooms`,
 * each as roomAuditRef names it. */
export function auditOnceUse(db: Database, o: { userId: string; rooms: readonly string[]; folder: string; segs: readonly string[]; tool: string; turnId: string | null; chat?: boolean }) {
  const refs = o.rooms.map((id) => roomRow(db, id)).filter((r): r is RoomRow => !!r).map(roomAuditRef)
  if (!refs.length) return
  audit(db, { actor: o.userId, action: 'room.ai_grant_use', target: null, detail: { ...(refs.length === 1 ? refs[0] : { rooms: refs }), folder: o.folder, path: o.segs.join('/'), tool: o.tool, turnId: o.turnId, once: true, ...(o.chat ? { chat: true } : {}) } })
}

/** The files this answer saved without a card through a grant or its own [이번만 허용] (its room.ai_grant_use rows whose
 * file the turn then created or changed), in the order they were used: the room's answer names them (rooms/ai.ts). */
export function grantMadeFiles(db: Database, turnId: string): string[] {
  const rows = db.query(`SELECT json_extract(a.detail, '$.path') path FROM audit_log a WHERE a.action = 'room.ai_grant_use' AND json_extract(a.detail, '$.turnId') = ?1
    AND EXISTS (SELECT 1 FROM file_events e WHERE e.turn_id = ?1 AND e.path = json_extract(a.detail, '$.path') AND e.action IN ('create', 'update')) ORDER BY a.id`).all(turnId) as { path: string | null }[]
  return [...new Set(rows.map((r) => r.path).filter((p): p is string => !!p))]
}

/** This person's grants for Settings › 트리나에게 허용한 것: only rooms they are in now (not archived), each room as they
 * see it; expired ones are deleted on the way (audited). Newest first. */
export function listGrants(db: Database, userId: string): AiAllowance[] {
  const out: AiAllowance[] = []
  const rows = db.query("SELECT g.* FROM room_ai_grants g WHERE g.user_id = ? AND g.scope = 'new_files' ORDER BY g.created_at DESC, g.id").all(userId) as GrantRow[]
  const now = Date.now()
  for (const g of rows) {
    if (Date.parse(g.expires_at) <= now) { revoke(db, g, 'expired', null); continue }
    const room = roomRow(db, g.room_id)
    const me = room && !room.archived_at ? memberRow(db, g.room_id, userId) : null
    if (!room || !me) continue
    const view = roomOut(db, room, me)
    out.push({
      kind: 'room_files', id: g.id, folder: g.folder, createdAt: g.created_at, expiresAt: g.expires_at,
      room: { id: view.id, kind: view.kind, name: view.name, peers: view.peers, memberCount: view.memberCount },
    })
  }
  return out
}

/** Delete one of this person's grants: false when it is not theirs (or not there: the same answer). */
export function deleteGrant(db: Database, userId: string, id: string): boolean {
  const g = db.query('SELECT * FROM room_ai_grants WHERE id = ? AND user_id = ?').get(id, userId) as GrantRow | null
  if (!g) return false
  revoke(db, g, 'person', userId)
  return true
}

/** Someone is out of a room (rooms/service.ts forgetMember): their grants there go (audited, inside the caller's
 * transaction). */
export function dropGrantsOf(db: Database, room: Pick<RoomRow, 'id'>, userId: string) {
  for (const g of db.query('SELECT * FROM room_ai_grants WHERE room_id = ? AND user_id = ?').all(room.id, userId) as GrantRow[]) revoke(db, g, 'left', null)
}
