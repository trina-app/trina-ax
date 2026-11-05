// Files and images sent in a room (docs/DECISIONS.md "대화방 v1"). Not where people can reach them: owners and admins can
// read the team folder outside users/<id>/ (policy/access.ts), and a room's files belong to its members only. They live
// in <team>/.system/rooms/<room id>/<file id> (0700 / 0600): .system/ is closed to every person, the AI's tools and the
// owner's export (policy/access.ts, policy/resolve.ts, system/export.ts), yet it is in every backup, archive and
// restore of the team folder (system/backup.ts), so room files go wherever the database goes. They are reached only
// through GET /api/rooms/:id/files/:fileId, which checks on every read that the caller is in the room now and may see
// the message the file was sent with. The upload path and its limits are the chat attachments' (multipart ≤ 50 MB, the
// storage check, the temp file and its sha256, the image size and thumbnail helpers, the quarantine list).
// reconcile() runs at every start: after a restore the database and the folder may be from different moments, and a
// file without its row, or a row without its file, is removed.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import type { RoomFile } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { ext } from '../files/extract'
import { fail } from '../http/errors'
import { badSegment } from '../policy/names'
import { checkRegular } from '../team-files/place'
import { mimeOf } from '../team-files/service'
import { attachmentKind } from '../uploads/attachments'
import { imageSize, makeThumbnail } from '../uploads/image'
import { canSee, fileOut, memberRow, messageRow, roomRow, type FileRow } from './store'

/** An upload not sent in a message within a day is removed. */
export const UNSENT_FILE_MS = 24 * 3600_000
const services = new WeakMap<AppContext, RoomFiles>()

export class RoomFiles {
  constructor(readonly ctx: AppContext) {}
  root() { return path.join(this.ctx.files.fx.root, PRODUCT.systemDir, 'rooms') }
  private dir(roomId: string) { return path.join(this.root(), roomId) }
  private abs(f: Pick<FileRow, 'room_id' | 'id'>) { return path.join(this.dir(f.room_id), f.id) }
  private thumbAbs(f: Pick<FileRow, 'room_id' | 'id'>) { return path.join(this.dir(f.room_id), `${f.id}.thumb.jpg`) }

  private member(userId: string, roomId: string) {
    const room = roomRow(this.ctx.db, roomId)
    const me = room && !room.archived_at ? memberRow(this.ctx.db, roomId, userId) : null
    return me ?? fail('not_found')
  }

  /** Keep an uploaded temp file (moved, not copied) for sending in this room. */
  async create(userId: string, roomId: string, name: string, src: string, sha256: string): Promise<RoomFile> {
    this.member(userId, roomId)
    const clean = name.normalize('NFC').replace(/[\u0000-\u001f]/g, '').trim()
    const bad = clean.includes('/') || clean.includes('\\') ? 'names cannot contain "/"' : badSegment(clean)
    if (bad) fail('validation', undefined, { fields: { 'body.name': bad } })
    const id = newId()
    fs.mkdirSync(this.dir(roomId), { recursive: true, mode: 0o700 })
    const dst = this.abs({ room_id: roomId, id })
    const head = Buffer.alloc(64 * 1024)
    const fd = fs.openSync(src, 'r')
    let headLen = 0
    try { headLen = fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
    const size = fs.statSync(src).size
    try { fs.renameSync(src, dst) } catch { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }) }
    fs.chmodSync(dst, 0o600)
    const kind = attachmentKind(clean)
    // a file on the team's quarantine list (safe-ops) is kept as a file: no preview is made from it
    const quarantined = this.ctx.files.quarantine.hasHash(sha256)
    const dims = kind === 'image' && !quarantined ? imageSize(head.subarray(0, headLen)) : null
    let thumb = false
    if (kind === 'image' && !quarantined) {
      try { thumb = await makeThumbnail(dst, this.thumbAbs({ room_id: roomId, id }), 640, path.join(this.ctx.config.dataDir, 'work')) } catch (e) { this.ctx.log.debug('room thumbnail failed', { err: e }) }
    }
    this.ctx.db.query(`INSERT INTO room_files (id, room_id, user_id, name, size, mime, kind, width, height, sha256, thumb, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, roomId, userId, clean, size, mimeOf(clean) ?? 'application/octet-stream', kind, dims?.width ?? null, dims?.height ?? null, sha256, thumb ? 1 : 0, nowIso())
    return fileOut(this.ctx.db.query('SELECT * FROM room_files WHERE id = ?').get(id) as FileRow)
  }

  /**
   * The file for `userId`, checked now: in the room, and either sent in a message they may see (not deleted) or their
   * own upload not sent yet. thumb: the small preview (or the image itself when it is a small web image).
   */
  open(userId: string, roomId: string, fileId: string, thumb: boolean): { abs: string; name: string } {
    const me = this.member(userId, roomId)
    const f = this.ctx.db.query('SELECT * FROM room_files WHERE id = ? AND room_id = ?').get(fileId, roomId) as FileRow | null
    if (!f) return fail('not_found')
    if (f.message_id) {
      const m = messageRow(this.ctx.db, roomId, f.message_id)
      if (!m || m.deleted_at || !canSee(m, me)) fail('not_found')
    } else if (f.user_id !== userId) fail('not_found')
    const abs = this.abs(f)
    if (thumb) {
      if (f.thumb) { try { checkRegular(this.thumbAbs(f)); return { abs: this.thumbAbs(f), name: `${f.name}.jpg` } } catch { /* the original below */ } }
      if (f.kind !== 'image' || !/^(png|jpe?g|gif|webp)$/.test(ext(f.name)) || f.size > 2 * 1024 * 1024) fail('not_found')
    }
    try { checkRegular(abs) } catch { fail('not_found') }
    return { abs, name: f.name }
  }

  /** A message was deleted: its files go from disk and from the table. */
  removeForMessage(messageId: string) {
    const rows = this.ctx.db.query('DELETE FROM room_files WHERE message_id = ? RETURNING id, room_id').all(messageId) as Pick<FileRow, 'id' | 'room_id'>[]
    for (const f of rows) { fs.rmSync(this.abs(f), { force: true }); fs.rmSync(this.thumbAbs(f), { force: true }) }
  }

  /**
   * At start: the files on disk and the rows in room_files are made to match. A database restored from a backup (Admin ›
   * Backups) is older than the folder: files sent since have no row (removed), and a row whose file was removed since
   * (a deleted message) has no file (the row goes; the message keeps its text). Files of the first room-files layout
   * (<data dir>/rooms/, before they were kept with the team folder) are moved over first. Runs before requests are
   * served, so no upload is half-way.
   */
  reconcile(): { movedRooms: number; filesRemoved: number; rowsRemoved: number } {
    const out = { movedRooms: 0, filesRemoved: 0, rowsRemoved: 0 }
    const legacy = path.join(this.ctx.config.dataDir, 'rooms')
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(this.root(), { recursive: true, mode: 0o700 })
      for (const r of fs.readdirSync(legacy)) {
        const to = path.join(this.root(), r)
        if (fs.existsSync(to)) continue
        try { fs.renameSync(path.join(legacy, r), to) } catch { fs.cpSync(path.join(legacy, r), to, { recursive: true }); fs.rmSync(path.join(legacy, r), { recursive: true, force: true }) }
        out.movedRooms++
      }
      try { fs.rmdirSync(legacy) } catch { /* something could not move: left for a look */ }
    }
    const rows = this.ctx.db.query('SELECT id, room_id, thumb FROM room_files').all() as Pick<FileRow, 'id' | 'room_id' | 'thumb'>[]
    const known = new Set(rows.map((r) => `${r.room_id}/${r.id}`))
    for (const r of rows) {
      if (fs.existsSync(this.abs(r))) continue
      this.ctx.db.query('DELETE FROM room_files WHERE id = ?').run(r.id)
      known.delete(`${r.room_id}/${r.id}`)
      out.rowsRemoved++
    }
    let rooms: string[] = []
    try { rooms = fs.readdirSync(this.root()) } catch { return out }
    for (const room of rooms) {
      const dir = path.join(this.root(), room)
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        const id = n.endsWith('.thumb.jpg') ? n.slice(0, -'.thumb.jpg'.length) : n
        if (known.has(`${room}/${id}`)) continue
        fs.rmSync(path.join(dir, n), { recursive: true, force: true })
        out.filesRemoved++
      }
      try { fs.rmdirSync(dir) } catch { /* not empty */ }
    }
    if (out.movedRooms || out.filesRemoved || out.rowsRemoved) this.ctx.log.info('room files reconciled', out)
    return out
  }

  /** Uploads never sent, and files of rooms that are gone. */
  sweep(now = Date.now()) {
    const cutoff = new Date(now - UNSENT_FILE_MS).toISOString()
    const rows = this.ctx.db.query('DELETE FROM room_files WHERE message_id IS NULL AND created_at < ? RETURNING id, room_id').all(cutoff) as Pick<FileRow, 'id' | 'room_id'>[]
    for (const f of rows) { fs.rmSync(this.abs(f), { force: true }); fs.rmSync(this.thumbAbs(f), { force: true }) }
    return rows.length
  }
}

export function roomFilesOf(ctx: AppContext): RoomFiles {
  let s = services.get(ctx)
  if (!s) { s = new RoomFiles(ctx); services.set(ctx, s) }
  return s
}
