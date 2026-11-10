// Files and images sent in a room (docs/DECISIONS.md "대화방 v1"). Not where people can reach them: owners and admins can
// read the team folder outside users/<id>/ (policy/access.ts), and a room's files belong to its members only. They live
// in <team>/.system/rooms/<room id>/<file id> (0700 / 0600): .system/ is closed to every person, the AI's tools and the
// owner's export (policy/access.ts, policy/resolve.ts, system/export.ts), yet it is in every backup, archive and
// restore of the team folder (system/backup.ts), so room files go wherever the database goes. They are reached only
// through GET /api/rooms/:id/files/:fileId, which checks on every read that the caller is in the room now and may see
// the message the file was sent with. It sends them like a team file's download (team-files/download.ts streamFile:
// nosniff, a sandbox CSP, a page or script type inline as text/plain); the app's preview panel reads those bytes and
// draws them (an HTML page only in its sandbox frame), never as a page of this origin. A file whose bytes are on the
// team's download-only list goes only as a download (no inline read, no thumbnail). The upload path and its limits are the chat attachments' (multipart ≤ 50 MB, the
// storage check, the temp file and its sha256, the image size and thumbnail helpers, the quarantine list).
// reconcile() runs at every start: after a restore the database and the folder may be from different moments; a file
// without its row is set aside in .system/rooms-orphans/ for 30 days, a row without its file is only counted.
// fromTeamFile() makes a room upload from a team file the sender may read now ("대화방에 보내기" attaching the files an
// answer links to, chat/answer-share.ts): the same limits (≤ 50 MB, the storage check), then create().
// hwpSource() gives a Hangul file's bytes to the HWP preview (files/hwp-preview.ts, the HWP Preview plugin's renderer;
// GET /api/rooms/:id/files/:fileId/hwp-preview) with the inline read's checks, made again on every call.
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { which } from '../config'
import { SMALL_UPLOAD_MAX, type Locale, type RoomFile } from '@mycel/shared/api'
import { HWP_LIMITS } from '@mycel/shared/hwp'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { ext } from '../files/extract'
import { HwpError } from '../files/hwp-engine'
import type { HwpSource } from '../files/hwp-preview'
import type { SearchAdmission } from '../files/search-admission'
import { sha256 } from '../files/store'
import { fail } from '../http/errors'
import { loadPrincipal } from '../policy/access'
import { authorize, visiblePath } from '../policy/authorize'
import { badSegment } from '../policy/names'
import { assertStorageRoom } from '../system/storage'
import { checkRegular, openChecked } from '../team-files/place'
import { mimeOf } from '../team-files/service'
import { attachmentKind } from '../uploads/attachments'
import { displaySize, makeThumbnail, type ThumbExt } from '../uploads/image'
import { cleanImage, imageFormat, PHOTO } from '../uploads/metadata'
import { personLocale } from '../files/media-text'
import { tr } from '../chat/i18n'
import { SAFE_OPS_TEXT } from '../safe-ops/strings'
import { canSee, fileOut, memberRow, messageRow, roomRow, type FileRow } from './store'

/** GIF, BMP or SVG by its first bytes (and its name for SVG, which has none): pictures shown as they are. */
function plainPicture(b: Uint8Array, name: string): boolean {
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true // GIF8
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return /\.bmp$/i.test(name) // BM
  return /\.svg$/i.test(name) && /^\s*</.test(Buffer.from(b.subarray(0, 256)).toString('utf8').replace(/^\uFEFF/, ''))
}

/** An upload not sent in a message within a day is removed. */
export const UNSENT_FILE_MS = 24 * 3600_000
/** Room files without a database row are kept this long in .system/rooms-orphans/ (reconcile). */
export const ORPHAN_KEEP_MS = 30 * 86400_000
/** a picture's thumbnail beside it: <file id>.thumb.jpg, or .thumb.png for one with transparency (uploads/image.ts) */
const THUMB = /\.thumb\.(jpg|png)$/
const THUMB_EXTS = ['png', 'jpg'] as const
/** settings: set once every thumbnail from before transparent ones were PNG was looked at (refreshThumbs) */
export const THUMBS_REFRESHED_SETTING = 'rooms.thumbsTransparent'
const MOVING = '.moving'
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
/** the time in an orphan batch's name (<stamp>-<pid>-<n>; a bare <stamp> from before is read too) */
const parseStamp = (s: string): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+-\d+)?$/.exec(s)
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null
}
const services = new WeakMap<AppContext, RoomFiles>()

export class RoomFiles {
  constructor(readonly ctx: AppContext) {}
  root() { return path.join(this.ctx.files.fx.root, PRODUCT.systemDir, 'rooms') }
  private dir(roomId: string) { return path.join(this.root(), roomId) }
  private abs(f: Pick<FileRow, 'room_id' | 'id'>) { return path.join(this.dir(f.room_id), f.id) }
  private thumbBase(f: Pick<FileRow, 'room_id' | 'id'>) { return path.join(this.dir(f.room_id), `${f.id}.thumb`) }
  private removeThumbs(f: Pick<FileRow, 'room_id' | 'id'>) { for (const e of THUMB_EXTS) fs.rmSync(`${this.thumbBase(f)}.${e}`, { force: true }) }

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
    let size = fs.statSync(src).size
    const first = head.subarray(0, headLen)
    // a picture is shown in the room only as one whose metadata can be cut out (JPEG, PNG, WebP, HEIC) or one that
    // carries no place in practice (GIF, BMP, SVG); anything else named like a picture (a TIFF, which can hold GPS like
    // any camera EXIF, or bytes that are not what the name says) goes as a plain file, like a document
    const fmt = imageFormat(first)
    const kind = attachmentKind(clean) === 'image' && !fmt && !plainPicture(first, clean) ? 'other' : attachmentKind(clean)
    // a file on the team's quarantine list (safe-ops) is kept as a file: no preview is made from it
    const quarantined = this.ctx.files.quarantine.hasHash(sha256)
    // the size it is shown at (a portrait phone photo stored landscape stands upright): from the photo as sent
    const dims = kind === 'image' && !quarantined ? displaySize(first) : null
    // every member gets the photo: like a messenger, the place it was taken, the camera and other metadata are cut out
    // first (uploads/metadata.ts PHOTO keeps the colours, an animation and which way up it is). It runs here, in the
    // request: its parsers read each byte at most a few times and HEIC's item tables have a step budget, so even a
    // crafted 50 MB upload costs about 100 ms at most, about as long as reading, hashing and writing the file
    let stored = sha256
    if (kind === 'image' && !quarantined && fmt) {
      const cleaned = cleanImage(fs.readFileSync(src), PHOTO)
      if (!(cleaned instanceof Uint8Array)) { fs.rmSync(src, { force: true }); return fail('validation', tr('roomPhotoUnreadable', personLocale(this.ctx.db, userId))) }
      fs.writeFileSync(src, cleaned)
      size = cleaned.byteLength
      stored = createHash('sha256').update(cleaned).digest('hex')
    }
    try { fs.renameSync(src, dst) } catch { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }) }
    fs.chmodSync(dst, 0o600)
    let thumb = false
    if (kind === 'image' && !quarantined) {
      try { thumb = !!(await makeThumbnail(dst, this.thumbBase({ room_id: roomId, id }), 640, path.join(this.ctx.config.dataDir, 'work'))) } catch (e) { this.ctx.log.debug('room thumbnail failed', { err: e }) }
    }
    this.ctx.db.query(`INSERT INTO room_files (id, room_id, user_id, name, size, mime, kind, width, height, sha256, thumb, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, roomId, userId, clean, size, mimeOf(clean) ?? 'application/octet-stream', kind, dims?.width ?? null, dims?.height ?? null, stored, thumb ? 1 : 0, nowIso())
    return fileOut(this.ctx.db.query('SELECT * FROM room_files WHERE id = ?').get(id) as FileRow)
  }

  /**
   * A copy of the team file `rel` as `userId`'s upload in this room, not sent yet (Rooms.send takes its id). Checked now,
   * with their access today: they are in the room, may read the file (a folder, a link, a hard-linked or quarantined file
   * and one they may not read all answer 404, the same as a missing one), it is at most 50 MB (413) and the team disk has
   * room (507). The bytes are read from one open file (no swap between the check and the copy), hashed on the way to a
   * temp file, then kept like an upload (create: the metadata of a photo is cut out, a quarantined hash gets no preview).
   */
  async fromTeamFile(userId: string, roomId: string, rel: string): Promise<RoomFile> {
    this.member(userId, roomId)
    const who = loadPrincipal(this.ctx.db, userId) ?? fail('not_found')
    const fx = this.ctx.files.fx, rules = this.ctx.files.rules()
    let abs: string, name: string
    try {
      const a = authorize(fx, rules, who, rel, 'read', { mustExist: true })
      if (!a.st?.isFile() || !visiblePath(fx, rules, who, a.rel)) throw new Error('not a file I may open')
      checkRegular(a.abs)
      abs = a.abs
      name = a.segs[a.segs.length - 1]!
    } catch { return fail('not_found') }
    let opened: { fd: number; st: fs.Stats }
    try { opened = openChecked(abs) } catch { return fail('not_found') }
    const tmpDir = path.join(this.ctx.config.dataDir, 'uploads', 'tmp')
    const tmp = path.join(tmpDir, `${PRODUCT.tmpPrefix}room-${randomBytes(8).toString('hex')}`)
    let sha: string
    try {
      if (opened.st.size > SMALL_UPLOAD_MAX) fail('payload_too_large')
      assertStorageRoom(opened.st.size)
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
      const out = fs.openSync(tmp, 'wx', 0o600)
      const h = createHash('sha256')
      try {
        const buf = Buffer.allocUnsafe(1024 * 1024)
        let pos = 0
        for (;;) {
          const n = fs.readSync(opened.fd, buf, 0, buf.length, pos)
          if (!n) break
          pos += n
          // it grew past the limit while being read
          if (pos > SMALL_UPLOAD_MAX) fail('payload_too_large')
          h.update(buf.subarray(0, n))
          fs.writeSync(out, buf, 0, n)
        }
      } finally { fs.closeSync(out) }
      sha = h.digest('hex')
    } catch (e) {
      fs.rmSync(tmp, { force: true })
      throw e
    } finally { fs.closeSync(opened.fd) }
    try { return await this.create(userId, roomId, name, tmp, sha) } finally { fs.rmSync(tmp, { force: true }) }
  }

  /** Uploads of `userId` in this room not sent with a message: removed (a shared answer that did not go after all). */
  discardUnsent(userId: string, roomId: string, fileIds: readonly string[]) {
    if (!fileIds.length) return
    const rows = this.ctx.db.query(`DELETE FROM room_files WHERE room_id = ? AND user_id = ? AND message_id IS NULL AND id IN (${fileIds.map(() => '?').join(',')}) RETURNING id, room_id`)
      .all(roomId, userId, ...fileIds) as Pick<FileRow, 'id' | 'room_id'>[]
    for (const f of rows) { fs.rmSync(this.abs(f), { force: true }); this.removeThumbs(f) }
  }

  /**
   * The file for `userId`, checked now: in the room, and either sent in a message they may see (not deleted) or their
   * own upload not sent yet. thumb: the small preview (or the image itself when it is a small web image). quarantined:
   * its bytes are on the team's download-only list (the route then sends it only as a download).
   */
  open(userId: string, roomId: string, fileId: string, thumb: boolean): { abs: string; name: string; quarantined: boolean; sha256: string } {
    const me = this.member(userId, roomId)
    const f = this.ctx.db.query('SELECT * FROM room_files WHERE id = ? AND room_id = ?').get(fileId, roomId) as FileRow | null
    if (!f) return fail('not_found')
    if (f.message_id) {
      const m = messageRow(this.ctx.db, roomId, f.message_id)
      if (!m || m.deleted_at || !canSee(this.ctx.db, m, me)) fail('not_found')
    } else if (f.user_id !== userId) fail('not_found')
    const abs = this.abs(f)
    const quarantined = this.ctx.files.quarantine.hasHash(f.sha256)
    if (thumb) {
      // a PNG one (a picture with transparency), else the JPEG one (every other picture, and those from before)
      if (f.thumb) {
        for (const e of THUMB_EXTS) {
          const t = `${this.thumbBase(f)}.${e}`
          try { checkRegular(t); return { abs: t, name: `${f.name}.${e}`, quarantined, sha256: f.sha256 } } catch { /* the next, then the original below */ }
        }
      }
      if (f.kind !== 'image' || !/^(png|jpe?g|gif|webp)$/.test(ext(f.name)) || f.size > 2 * 1024 * 1024) fail('not_found')
    }
    try { checkRegular(abs) } catch { fail('not_found') }
    return { abs, name: f.name, quarantined, sha256: f.sha256 }
  }

  /**
   * A Hangul file sent in a room, for the HWP preview (files/hwp-preview.ts pageOf), checked as its inline read is, on
   * every call (the preview calls it before any cache lookup or render, and again after the render): open() (in the room
   * now, the message visible to me and not deleted, or my own upload not sent yet; else 404) and not on the download-only
   * list (503 quarantined, the inline read's answer; no inline read, no preview). The bytes are read from one open file
   * bound to that check (SearchAdmission: no link, no swap, a quarantined hash refused) and must be the bytes the file
   * was sent with (its sha256). The cache knows it by its room, its id and that sha256.
   */
  hwpSource(userId: string, roomId: string, fileId: string, admission: SearchAdmission, locale: Locale): HwpSource {
    const checked = () => {
      const f = this.open(userId, roomId, fileId, false)
      if (f.quarantined) fail('unavailable', SAFE_OPS_TEXT.quarantined[locale], { params: { reason: 'quarantined' } })
      return f
    }
    const f = checked()
    if (!/\.hwpx?$/i.test(f.name)) throw new HwpError('unsupported')
    let st: fs.Stats
    try { st = checkRegular(f.abs) } catch { return fail('not_found') }
    if (st.size > HWP_LIMITS.inputBytes) throw new HwpError('limit')
    const read = admission.read(f.abs, () => {
      try { const now = checked(); return now.abs === f.abs && now.sha256 === f.sha256 && checkRegular(now.abs) } catch { return false }
    }, HWP_LIMITS.inputBytes)
    if (!read) throw new HwpError('changed')
    const hash = sha256(read.bytes)
    if (hash !== f.sha256) throw new HwpError('changed')
    return { key: `room:${roomId}/${fileId}`, bytes: read.bytes, hash, version: f.sha256, ext: /\.hwpx$/i.test(f.name) ? 'hwpx' : 'hwp' }
  }

  /** A message was deleted: its files go from disk and from the table. */
  removeForMessage(messageId: string) {
    const rows = this.ctx.db.query('DELETE FROM room_files WHERE message_id = ? RETURNING id, room_id').all(messageId) as Pick<FileRow, 'id' | 'room_id'>[]
    for (const f of rows) { fs.rmSync(this.abs(f), { force: true }); this.removeThumbs(f) }
  }

  /**
   * At start: the files on disk and the rows in room_files are compared. Nothing is deleted on a guess:
   * - a row whose file is not there is kept (GET answers 404 for it) and only counted in the log: the team folder may be
   *   a share that is not mounted yet, unreadable, or put in place after the first start;
   * - a file without a row (a database restored from a backup is older than the folder: files sent since have no row) is
   *   moved to <team>/.system/rooms-orphans/<time>/<room id>/, so going back to the newer database stays possible, and
   *   such batches are deleted after ORPHAN_KEEP_MS;
   * - files of the first layout (<data dir>/rooms/, before room files were kept with the team folder) are moved over,
   *   file by file through a temporary name, so an interrupted start leaves no half file under a real name.
   * When <team>/.system/rooms is missing or cannot be read, nothing else is done. Runs before requests are served.
   */
  reconcile(now = Date.now()): { movedFiles: number; missingFiles: number; orphansMoved: number; orphanBatchesPurged: number; skipped?: true } {
    const out = { movedFiles: 0, missingFiles: 0, orphansMoved: 0, orphanBatchesPurged: 0 }
    // the first layout moves over only into a team folder that is there: an empty mount point of a share that is not
    // mounted yet gets no .system/rooms of its own
    if (this.teamFolderPresent()) out.movedFiles = this.moveLegacy()
    const root = this.root()
    let rooms: string[]
    try {
      if (!fs.statSync(root).isDirectory()) throw new Error('not a folder')
      fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)
      rooms = fs.readdirSync(root)
    } catch {
      const n = (this.ctx.db.query('SELECT COUNT(*) n FROM room_files').get() as { n: number }).n
      if (n) this.ctx.log.warn('room files folder missing or unreadable; room files are not checked at this start', { rows: n })
      return { ...out, skipped: true }
    }
    const rows = this.ctx.db.query('SELECT id, room_id FROM room_files').all() as Pick<FileRow, 'id' | 'room_id'>[]
    const known = new Set(rows.map((r) => `${r.room_id}/${r.id}`))
    for (const r of rows) if (!fs.existsSync(this.abs(r))) out.missingFiles++
    const batch = this.newBatch(now)
    for (const room of rooms) {
      const dir = path.join(root, room)
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (n.endsWith(MOVING)) { fs.rmSync(path.join(dir, n), { force: true }); continue } // an interrupted copy
        const id = n.replace(THUMB, '')
        if (known.has(`${room}/${id}`)) continue
        fs.mkdirSync(path.join(batch, room), { recursive: true, mode: 0o700 })
        fs.renameSync(path.join(dir, n), path.join(batch, room, n))
        out.orphansMoved++
      }
      try { fs.rmdirSync(dir) } catch { /* not empty */ }
    }
    out.orphanBatchesPurged = this.purgeOrphans(now)
    if (out.movedFiles || out.missingFiles || out.orphansMoved || out.orphanBatchesPurged) this.ctx.log.info('room files checked', out)
    return out
  }

  private orphansRoot() { return path.join(this.ctx.files.fx.root, PRODUCT.systemDir, 'rooms-orphans') }

  /** A batch folder name no other start uses: the time, this process and a count (two starts in one second differ). */
  private newBatch(now: number): string {
    for (let i = 0; ; i++) {
      const p = path.join(this.orphansRoot(), `${stamp(now)}-${process.pid}-${i}`)
      if (!fs.existsSync(p)) return p
    }
  }

  /** The team folder can be read and written and holds something (setup makes its folders; an unmounted share is empty). */
  private teamFolderPresent(): boolean {
    try {
      const t = this.ctx.files.fx.root
      fs.accessSync(t, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)
      return fs.readdirSync(t).length > 0
    } catch { return false }
  }

  /** <data dir>/rooms/<room>/<file> → <team>/.system/rooms/<room>/<file>, each file copied to `<name>.moving` and renamed
   * (a rename when both are on one disk), then the old one removed. A file already there is not copied again. */
  private moveLegacy(): number {
    const legacy = path.join(this.ctx.config.dataDir, 'rooms')
    if (!fs.existsSync(legacy)) return 0
    let moved = 0
    for (const room of fs.readdirSync(legacy)) {
      const from = path.join(legacy, room), to = this.dir(room)
      fs.mkdirSync(to, { recursive: true, mode: 0o700 })
      for (const n of fs.readdirSync(from)) {
        const src = path.join(from, n), dst = path.join(to, n)
        if (!fs.existsSync(dst)) {
          try { fs.renameSync(src, dst) } catch {
            fs.copyFileSync(src, dst + MOVING)
            fs.chmodSync(dst + MOVING, 0o600)
            fs.renameSync(dst + MOVING, dst)
          }
          moved++
        }
        fs.rmSync(src, { force: true })
      }
      try { fs.rmdirSync(from) } catch { /* something was left: looked at again next start */ }
    }
    try { fs.rmdirSync(legacy) } catch { /* the same */ }
    return moved
  }

  /** Orphan batches older than ORPHAN_KEEP_MS by both the time in their name and their folder's time go. Not when the
   * clock looks wrong (earlier than the newest room file: a Mac with a dead clock battery, a restored VM). */
  private purgeOrphans(now: number): number {
    const newest = (this.ctx.db.query('SELECT MAX(created_at) t FROM room_files').get() as { t: string | null }).t
    if (newest && now < Date.parse(newest)) {
      this.ctx.log.warn('the clock is earlier than the newest room file; set-aside room files are kept', { newest })
      return 0
    }
    let n = 0
    let batches: string[] = []
    try { batches = fs.readdirSync(this.orphansRoot()) } catch { return 0 }
    for (const b of batches) {
      const at = parseStamp(b)
      if (at === null || now - at < ORPHAN_KEEP_MS) continue
      let mtime: number
      try { mtime = fs.statSync(path.join(this.orphansRoot(), b)).mtimeMs } catch { continue }
      if (now - mtime < ORPHAN_KEEP_MS) continue
      fs.rmSync(path.join(this.orphansRoot(), b), { recursive: true, force: true })
      n++
    }
    return n
  }

  /**
   * Once (THUMBS_REFRESHED_SETTING), a while after start: a picture sent before transparent ones got a PNG thumbnail
   * has a JPEG one, black where the picture is see-through (a seal stamp on a black square). Each picture that can have
   * transparency (a PNG, WebP or GIF: makeThumbnail transparentOnly) is looked at again, one at a time below
   * interactive work; one with see-through pixels gets its PNG thumbnail and the JPEG one goes. A picture ffmpeg cannot
   * read, or one on the download-only list, keeps what it has; reads go on meanwhile (open() takes either). Stopped by
   * `signal` (the server closing) before it is done: the next start looks again.
   */
  async refreshThumbs(signal?: AbortSignal): Promise<{ refreshed: number } | null> {
    // no ffmpeg now (a server without it, or one being installed): not done, the next start looks again
    if (this.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(THUMBS_REFRESHED_SETTING) || !which('ffmpeg')) return null
    const rows = this.ctx.db.query("SELECT id, room_id, sha256 FROM room_files WHERE kind = 'image' AND thumb = 1").all() as Pick<FileRow, 'id' | 'room_id' | 'sha256'>[]
    // the room files folder not there (a team folder on a share not mounted yet): not now, so none is passed over
    if (rows.length && !fs.existsSync(this.root())) return null
    const work = path.join(this.ctx.config.dataDir, 'work')
    let refreshed = 0
    for (const f of rows) {
      await new Promise((r) => setImmediate(r)) // a row without alpha ends without waiting: requests get their turn between rows
      if (signal?.aborted) return { refreshed }
      const base = this.thumbBase(f)
      if (fs.existsSync(`${base}.png`) || !fs.existsSync(`${base}.jpg`) || this.ctx.files.quarantine.hasHash(f.sha256)) continue
      let made: ThumbExt | null = null
      try {
        checkRegular(this.abs(f))
        made = await makeThumbnail(this.abs(f), base, 640, work, undefined, { transparentOnly: true, background: true, signal })
      } catch (e) { this.ctx.log.debug('room thumbnail refresh failed', { err: e }) }
      if (made !== 'png') continue
      // the message may have been deleted meanwhile: its new thumbnail goes too
      if (!this.ctx.db.query('SELECT 1 FROM room_files WHERE id = ?').get(f.id)) { this.removeThumbs(f); continue }
      fs.rmSync(`${base}.jpg`, { force: true })
      refreshed++
    }
    if (signal?.aborted) return { refreshed }
    this.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(THUMBS_REFRESHED_SETTING, nowIso())
    if (refreshed) this.ctx.log.info('room thumbnails of transparent pictures made again', { refreshed })
    return { refreshed }
  }

  /** Uploads never sent, and files of rooms that are gone. */
  sweep(now = Date.now()) {
    const cutoff = new Date(now - UNSENT_FILE_MS).toISOString()
    const rows = this.ctx.db.query('DELETE FROM room_files WHERE message_id IS NULL AND created_at < ? RETURNING id, room_id').all(cutoff) as Pick<FileRow, 'id' | 'room_id'>[]
    for (const f of rows) { fs.rmSync(this.abs(f), { force: true }); this.removeThumbs(f) }
    return rows.length
  }
}

export function roomFilesOf(ctx: AppContext): RoomFiles {
  let s = services.get(ctx)
  if (!s) { s = new RoomFiles(ctx); services.set(ctx, s) }
  return s
}
