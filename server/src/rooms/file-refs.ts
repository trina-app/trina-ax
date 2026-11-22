// A room file kept in the team folder instead of room storage (docs/decisions/20261120-project-is-room.md D3,
// migration 430 room_file_refs): a file sent from the computer in a project's chat room lands in the project's Chat
// attachments folder, and a team file attached from Files in a project room stays where it is. The message's room_files
// row then carries a room_file_refs row: where the file is and how it is followed (moves, renames, the trash: the same
// helper as a chat's team file references, uploads/ref-follow.ts). No bytes of it are in .system/rooms.
// Who sees it is checked on every show, read and download with today's rules: a member of the room now AND someone who
// reads the file's path now. Anything else looks the same to them: "unavailable", with its name, path and size blanked.
// A file put in the trash (or deleted for good) shows "File deleted" to a member who reads the place it was in; a
// restore brings it back, because the message is still there and the row follows the trash id.
import fs from 'node:fs'
import type { RoomFile } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { authorize, visiblePath } from '../policy/authorize'
import { mimeOf } from '../team-files/service'
import { attachmentKind } from '../uploads/attachments'
import { RefFollower, type FollowCols } from '../uploads/ref-follow'
import { isRoomMember, setRoomRefView, type FileRow } from './store'
import { teamThumbPossible } from './team-thumbs'

export interface RoomRefRow extends FollowCols { room_file_id: string; path_at_attach: string; sha256: string | null }
const COLS = 'room_file_id, path, path_at_attach, ino, dev, sha256, event_id, trash_id, trash_suffix, lost'

/** Where a room file kept in the team folder is now, for one viewer. */
export type RoomRefState =
  | { state: 'ok'; ref: RoomRefRow; rel: string; abs: string; st: fs.Stats }
  | { state: 'deleted' | 'unavailable'; ref: RoomRefRow | null }

/** One viewer's rules and principal, read once for a list of files. */
export interface RefViewer { user: Principal | null; rules: RuleSet }

const services = new WeakMap<AppContext, RoomFileRefs>()

export class RoomFileRefs {
  private follower: RefFollower
  constructor(private ctx: AppContext) {
    this.follower = new RefFollower(ctx.db, () => ctx.files.fx.root, 'room_file_refs', 'room_file_id')
  }

  row(fileId: string): RoomRefRow | null { return this.ctx.db.query(`SELECT ${COLS} FROM room_file_refs WHERE room_file_id = ?`).get(fileId) as RoomRefRow | null }
  isRef(fileId: string): boolean { return !!this.ctx.db.query('SELECT 1 FROM room_file_refs WHERE room_file_id = ?').get(fileId) }
  /** the ids among these that are kept in the team folder */
  refIds(ids: readonly string[]): Set<string> {
    const out = new Set<string>()
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      for (const r of this.ctx.db.query(`SELECT room_file_id FROM room_file_refs WHERE room_file_id IN (${part.map(() => '?').join(',')})`).all(...part) as { room_file_id: string }[]) out.add(r.room_file_id)
    }
    return out
  }

  /** The reference of a new room file (inside the caller's write): the team file `rel` as it is now (`st`), followed
   * from the newest file event on. */
  add(fileId: string, rel: string, st: Pick<fs.Stats, 'ino' | 'dev'>, sha256: string | null) {
    this.ctx.db.query('INSERT INTO room_file_refs (room_file_id, path, path_at_attach, ino, dev, sha256, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(fileId, rel, rel, st.ino, st.dev, sha256, this.follower.lastEvent())
  }

  forget(fileId: string) { this.follower.forget(fileId) }

  viewer(userId: string): RefViewer {
    let user: Principal | null = null
    try { user = this.ctx.files.principal(userId) } catch { /* a disabled account opens nothing */ }
    return { user, rules: this.ctx.files.rules() }
  }

  /**
   * The file for `userId` now: they are in its room now (not archived, not held) and read its path now (the file
   * screen's own test: authorize + visiblePath, a regular file). A file that is gone (trashed, deleted, moved without a
   * trace) is 'deleted' to a member who reads the place it was last in, else 'unavailable', like anything else that
   * fails. `persist`: the row's place is saved (POST paths).
   */
  locate(userId: string, f: Pick<FileRow, 'id' | 'room_id'>, o: { persist?: boolean; viewer?: RefViewer; memberChecked?: boolean } = {}): RoomRefState {
    const ref = this.row(f.id)
    if (!ref) return { state: 'unavailable', ref: null }
    if (!o.memberChecked && !isRoomMember(this.ctx.db, f.room_id, userId)) return { state: 'unavailable', ref }
    const v = o.viewer ?? this.viewer(userId)
    if (!v.user) return { state: 'unavailable', ref }
    const fol = this.follower.follow(f.id, ref, !!o.persist)
    if (fol.found === null) {
      let reads = false
      try { reads = atLeast(v.rules.access(v.user, fol.last.split('/')), 'read') } catch { /* an odd path: unavailable */ }
      return { state: reads ? 'deleted' : 'unavailable', ref }
    }
    try {
      const r = authorize(this.ctx.files.fx, v.rules, v.user, fol.found, 'read')
      const st = visiblePath(this.ctx.files.fx, v.rules, v.user, r.rel)
      if (!st || !st.isFile()) return { state: 'unavailable', ref }
      return { state: 'ok', ref, rel: r.rel, abs: r.abs, st }
    } catch { return { state: 'unavailable', ref } }
  }

  /** The room file as `userId` sees it now (a message's files, a search hit). */
  view(userId: string, f: FileRow, o: { viewer?: RefViewer; memberChecked?: boolean } = {}): RoomFile {
    const s = this.locate(userId, f, o)
    if (s.state !== 'ok') return goneFile(f.id, s.state)
    const name = s.rel.slice(s.rel.lastIndexOf('/') + 1)
    // a picture stays one only when it was shown as one when sent (rooms/files.ts create) and is still named like one
    const k = attachmentKind(name)
    const kind = k === 'image' ? (f.kind === 'image' ? 'image' : 'other') : k
    // shown as a picture when the room's ?thumb=1 can give a preview of it now (rooms/team-thumbs.ts)
    const thumb = kind === 'image' && teamThumbPossible(name, s.st.size)
    return {
      id: f.id, name, size: s.st.size, mime: mimeOf(name) ?? 'application/octet-stream', kind,
      ...(f.width ? { width: f.width } : {}), ...(f.height ? { height: f.height } : {}), thumb, teamFile: true, teamPath: s.rel,
    }
  }
}

/** A room file kept in the team folder that the viewer cannot have now: nothing about the file. */
export const goneFile = (id: string, state: 'deleted' | 'unavailable'): RoomFile => ({ id, name: '', size: 0, mime: 'application/octet-stream', kind: 'other', thumb: false, teamFile: true, state })

export function roomFileRefsOf(ctx: AppContext): RoomFileRefs {
  let s = services.get(ctx)
  if (!s) {
    const refs = new RoomFileRefs(ctx)
    s = refs
    services.set(ctx, s)
    // a message's files as each viewer sees them (store.ts filesOutFor): their rules read once per list
    setRoomRefView(ctx.db, (viewerId) => { let v: RefViewer | null = null; return (f) => refs.view(viewerId, f, { viewer: (v ??= refs.viewer(viewerId)) }) })
  }
  return s
}
