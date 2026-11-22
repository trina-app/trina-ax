// Files and images sent in a room (docs/DECISIONS.md "대화방 v1"). Not where people can reach them: owners and admins can
// read the team folder outside users/<id>/ (policy/access.ts), and a room's files belong to its members only. They live
// in <team>/.system/rooms/<room id>/<file id> (0700 / 0600): .system/ is closed to every person, the AI's tools and the
// owner's export (policy/access.ts, policy/resolve.ts, system/export.ts), yet it is in every backup, archive and
// restore of the team folder (system/backup.ts), so room files go wherever the database goes. They are reached only
// through GET /api/rooms/:id/files/:fileId, which checks on every read that the caller is in the room now and may see
// the message the file was sent with. It sends them like a team file's download (team-files/download.ts streamFile:
// nosniff, a sandbox CSP, a page or script type inline as text/plain); the app's preview panel reads those bytes and
// draws them (an HTML page only in its sandbox frame), never as a page of this origin. A file whose bytes are on the
// team's download-only list goes only as a download (no inline read, no thumbnail). A file of up to 50 MB arrives in one request (multipart, streamed to a temp
// file and hashed on the way: http/multipart.ts), a larger one, up to ROOM_FILE_MAX (1 GB), through an upload session
// with target room (uploads/sessions.ts: 8 MB chunks written straight to disk, resumable). Either way the file is never
// in memory whole; the storage check, the image size and thumbnail helpers and the quarantine list are the chat
// attachments'. Only a picture of at most 50 MB is read whole (its metadata is cut out); a larger one is a plain file.
// reconcile() runs at every start: after a restore the database and the folder may be from different moments; a file
// without its row is set aside in .system/rooms-orphans/ for 30 days, a row without its file is only counted.
// sweep() (the rooms' one-minute tick) also runs, once a day, the purge of those set-aside batches and purgeArchived():
// the files of a conversation that was archived more than 30 days ago (nobody is in it, nobody can open it and nothing
// brings it back) go with their rows; its messages stay (docs/decisions/20261116-archived-room-files-purge.md).
// fromTeamFile() makes a room upload from a team file the sender may read now ("대화방에 보내기" attaching the files an
// answer links to, chat/answer-share.ts): the same limits (≤ 50 MB, the storage check), then create().
// teamCopy() is the same copy for a phone's attach sheet (POST /api/rooms/:id/team-file), kept as an unsent upload until
// the person sends it: marked with its team path and the file as it was (room_files.team_path, team_stamp; migration
// 287), so the same unchanged file picked again in the same room gets that copy back, and a person's unsent copies are
// capped (TEAM_COPIES_UNSENT_MAX): a small request cannot fill the team's disk with 50 MB copies kept for a day.
// A project's chat room (rooms/project-room.ts) keeps no bytes here (docs/decisions/20261120-project-is-room.md D3): a
// file sent from the computer there goes into the project's Chat attachments folder (createInTeamFolder: the project's
// shared chat's place and checks, uploads/shared-chat.ts), and a team file picked there stays where it is (teamRef). A
// department's team room puts a file from the computer in its group folder's Chat attachments the same way, when that
// folder fits (rooms/team-place.ts teamPlaceFor; else room storage, never a refusal);
// either way the row carries a room_file_refs row (rooms/file-refs.ts) that follows the file and is checked on every
// show and read. One rule on every path that deletes room files (removeForMessage, discardUnsent, sweep's unsent
// uploads, purgeArchived): the row goes (its reference with it), and nothing on disk is deleted for a row kept in the
// team folder; abs() refuses such a row, and reconcile() leaves them out. Only an upload taken out before it was sent
// (a removed chip, an abandoned upload) sends its file to the team trash, when it is the uploader's own, unchanged and
// shown nowhere else (no other chat's or room's reference to it).
// hwpSource() gives a Hangul file's bytes to the HWP preview (files/hwp-preview.ts, the HWP Preview plugin's renderer;
// GET /api/rooms/:id/files/:fileId/hwp-preview) with the inline read's checks, made again on every call.
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { which } from '../config'
import { isFileListName, GUEST_FILE_MAX, ROOM_FILE_MAX, SMALL_UPLOAD_MAX, type Locale, type RoomFile } from '@mycel/shared/api'
import { guestUploadMax, sizeWords } from '../uploads/guest-limit'
import { HWP_LIMITS } from '@mycel/shared/hwp'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { ext } from '../files/extract'
import { HwpError } from '../files/hwp-engine'
import type { HwpSource } from '../files/hwp-preview'
import type { SearchAdmission } from '../files/search-admission'
import { sha256 } from '../files/store'
import { fail, HttpError } from '../http/errors'
import { loadPrincipal } from '../policy/access'
import { authorize, visiblePath } from '../policy/authorize'
import { badSegment } from '../policy/names'
import { assertStorageRoom } from '../system/storage'
import { checkRegular, openChecked } from '../team-files/place'
import { mimeOf } from '../team-files/service'
import { attachmentKind } from '../uploads/attachments'
import { displaySize, makeThumbnail, type ThumbExt } from '../uploads/image'
import { cleanImage, imageFormat, PHOTO, plainPicture } from '../uploads/metadata'
import { personLocale } from '../files/media-text'
import { tr } from '../chat/i18n'
import { SAFE_OPS_TEXT } from '../safe-ops/strings'
import { canSee, fileOut, memberRow, messageRow, roomRow, type FileRow } from './store'
import { roomFileRefsOf, type RoomRefRow } from './file-refs'
import { projectRoomLink } from './project-room'
import { roomHasTeamPlace, teamPlaceFor, type TeamPlace } from './team-place'
import { safeName } from './file-moves'
import { instructionFile } from '../team-files/ai-trash'
import { otherRefTo } from '../uploads/ref-follow'
import { ATTACH_RATE_MAX, hashChecked } from '../uploads/team-refs'
import { FileError } from '../team-files/errors'
import { componentC } from '../team-files/component'

/** How a room file was made (room_files.origin, migration 433): from the computer, a phone's team pick, a copy of a team
 * file an AI answer attached. NULL on older rows. */
export type RoomFileOrigin = 'upload' | 'team_copy' | 'answer_copy'
/** A name a room file never takes in a team folder (a project's Chat attachments): an instruction file's (CLAUDE.md,
 * AGENTS.md, GEMINI.md, SKILL.md: the project AI would follow it) or the folder's file list's (_FILES.md). Such a name
 * gets the next free one, "CLAUDE (2).md" (team-files placeUpload `taken`). */
export const takenInTeamPlace = (name: string): boolean => instructionFile(name) || /^CLAUDE\.local\.md$/i.test(name) || isFileListName(name)

/** An upload not sent in a message within a day is removed. */
export const UNSENT_FILE_MS = 24 * 3600_000
/** A person's team-file copies not sent yet (teamCopy), in bytes, all rooms together: four 50 MB files, or many small ones */
export const TEAM_COPIES_UNSENT_MAX = 200 * 1024 * 1024
/** A person's team-file references in project rooms not sent yet (teamRef), all rooms together */
export const TEAM_REFS_UNSENT_MAX = 50
/** The daily part of sweep(): the set-aside batches and the archived conversations' files. */
export const DAILY_MS = 24 * 3600_000
/** purgeArchived: rows per statement, and how long one run may take before it goes on at the next tick */
const PURGE_BATCH = 100
const PURGE_BUDGET_MS = 2000
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
  /** teamCopy: bytes of copies on their way, per person (counted by the cap until their row carries them) */
  private reserved = new Map<string, number>()
  /** teamCopy: the copies on their way, by person, room, team path and stamp */
  private copying = new Map<string, Promise<RoomFile>>()
  /** when the daily part of sweep() last ran (null: not since this start, so the first tick runs it) */
  private dailyAt: number | null = null
  root() { return path.join(this.ctx.files.fx.root, PRODUCT.systemDir, 'rooms') }
  private dir(roomId: string) { return path.join(this.root(), roomId) }
  /** a room-stored file's bytes; a row kept in the team folder has none here, and is refused (no later change can point
   * a delete or a read of room storage at the team folder) */
  private abs(f: Pick<FileRow, 'room_id' | 'id'>) {
    if (this.refs().isRef(f.id)) throw new Error('a room file kept in the team folder has no room storage')
    return path.join(this.dir(f.room_id), f.id)
  }
  private refs() { return roomFileRefsOf(this.ctx) }
  private thumbBase(f: Pick<FileRow, 'room_id' | 'id'>) { return path.join(this.dir(f.room_id), `${f.id}.thumb`) }
  private removeThumbs(f: Pick<FileRow, 'room_id' | 'id'>) { for (const e of THUMB_EXTS) fs.rmSync(`${this.thumbBase(f)}.${e}`, { force: true }) }

  private member(userId: string, roomId: string) {
    const room = roomRow(this.ctx.db, roomId)
    const me = room && !room.archived_at ? memberRow(this.ctx.db, roomId, userId) : null
    return me ?? fail('not_found')
  }

  /** The name a file is kept under, or 422 for one that cannot be a file name. */
  private cleanName(name: string, field = 'body.name'): string {
    const clean = name.normalize('NFC').replace(/[\u0000-\u001f]/g, '').trim()
    const bad = clean.includes('/') || clean.includes('\\') ? 'names cannot contain "/"' : badSegment(clean)
    if (bad) fail('validation', undefined, { fields: { [field]: bad } })
    return clean
  }

  /**
   * Before a large upload starts (an upload session with target room, uploads/sessions.ts), and again when it is
   * complete: the person is in the room, the name can be kept and the file is at most ROOM_FILE_MAX. Refused before any
   * byte is taken, in plain words with the limit (a guest's own: maxFor).
   */
  assertUpload(userId: string, roomId: string, name: string, size: number): void {
    this.member(userId, roomId)
    this.cleanName(name, 'body.target.name')
    this.assertSize(userId, size)
  }

  /** The largest file this person may send in a room now: ROOM_FILE_MAX, or for a guest the team's choice (100 MB
   * unless the owner or an admin raised it to 1 GB: uploads/guest-limit.ts). Read at every upload, from their role then. */
  maxFor(userId: string): number {
    return Math.min(ROOM_FILE_MAX, guestUploadMax(this.ctx.db, userId) ?? ROOM_FILE_MAX)
  }

  /** 413 in plain words with the person's own limit ("… The limit is 100 MB."). */
  private assertSize(userId: string, size: number): void {
    const max = this.maxFor(userId)
    if (size <= max) return
    fail('payload_too_large', tr('roomFileTooBig', personLocale(this.ctx.db, userId), { max: sizeWords(max) }), { params: { reason: 'room_file_too_large', maxBytes: max } })
  }

  /**
   * Keep an uploaded temp file (moved, not copied) for sending in this room. Nothing here reads the whole file into
   * memory unless it is a picture of at most SMALL_UPLOAD_MAX (its metadata is cut out); a larger file named like a
   * picture is kept as a plain file (no preview made from it), like any document.
   */
  async create(userId: string, roomId: string, name: string, src: string, sha256: string, o: { roomStorage?: boolean; origin?: RoomFileOrigin } = {}): Promise<RoomFile> {
    this.member(userId, roomId)
    const clean = this.cleanName(name)
    // a project's chat room: into the project's Chat attachments folder; a department's team room: into its group
    // folder's, when that fits (rooms/team-place.ts teamPlaceFor; a copy fromTeamFile makes for an answer stays a room
    // copy: it is there for the members who cannot open the team file)
    let place = o.roomStorage ? null : teamPlaceFor(this.ctx, roomId, userId)
    // a department room never refuses a file: bytes on the download-only list stay in room storage, as before (they
    // never become a team file the AI could be handed)
    if (place?.via === 'group' && this.ctx.files.quarantine.hasHash(sha256)) place = null
    if (place) return this.createInTeamFolder(userId, roomId, place, clean, src, sha256)
    const id = newId()
    fs.mkdirSync(this.dir(roomId), { recursive: true, mode: 0o700 })
    const dst = this.abs({ room_id: roomId, id })
    const head = Buffer.alloc(64 * 1024)
    const fd = fs.openSync(src, 'r')
    let headLen = 0
    try { headLen = fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
    let size = fs.statSync(src).size
    // the person's limit as it is now, whichever way the bytes came (one request, an upload session, a team file's copy)
    this.assertSize(userId, size)
    const first = head.subarray(0, headLen)
    // a picture is shown in the room only as one whose metadata can be cut out (JPEG, PNG, WebP, HEIC) or one that
    // carries no place in practice (GIF, BMP, SVG); anything else named like a picture (a TIFF, which can hold GPS like
    // any camera EXIF, or bytes that are not what the name says) goes as a plain file, like a document
    const fmt = imageFormat(first)
    const kind = attachmentKind(clean) === 'image' && (size > SMALL_UPLOAD_MAX || (!fmt && !plainPicture(first, clean))) ? 'other' : attachmentKind(clean)
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
    // another disk than the uploads folder: a copy that does not hold the server up while a large file is written
    try { fs.renameSync(src, dst) } catch {
      try { await fs.promises.copyFile(src, dst) } catch (e) { fs.rmSync(dst, { force: true }); throw e }
      fs.rmSync(src, { force: true })
    }
    fs.chmodSync(dst, 0o600)
    // the room may have been archived, or the person taken out, while the copy ran
    try { this.member(userId, roomId) } catch (e) { fs.rmSync(dst, { force: true }); throw e }
    let thumb = false
    if (kind === 'image' && !quarantined) {
      try { thumb = !!(await makeThumbnail(dst, this.thumbBase({ room_id: roomId, id }), 640, path.join(this.ctx.config.dataDir, 'work'))) } catch (e) { this.ctx.log.debug('room thumbnail failed', { err: e }) }
    }
    this.ctx.db.query(`INSERT INTO room_files (id, room_id, user_id, name, size, mime, kind, width, height, sha256, thumb, created_at, origin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, roomId, userId, clean, size, mimeOf(clean) ?? 'application/octet-stream', kind, dims?.width ?? null, dims?.height ?? null, stored, thumb ? 1 : 0, nowIso(), o.origin ?? 'upload')
    const out = fileOut(this.ctx.db.query('SELECT * FROM room_files WHERE id = ?').get(id) as FileRow)
    // the uploader is told it stayed in the conversation where files otherwise go to a team folder
    const room = roomRow(this.ctx.db, roomId)
    return room && roomHasTeamPlace(this.ctx.db, room) ? { ...out, roomOnly: true } : out
  }

  /**
   * A file from the computer in a project's chat room (docs/decisions/20261120-project-is-room.md D3) or a department's
   * team room whose folder fits (docs/AGENTS/plan/20261121-0619-structure-polish.md B; rooms/team-place.ts): placed by the
   * person in the Chat attachments folder `place` as a Files-screen upload of theirs, with the shared chat's place and
   * checks (uploads/shared-chat.ts chatAttachmentsPlace: write access there, for a project 403 shared_upload_read_only
   * otherwise; the folder made when missing; a taken name, an instruction file's name or the file list's (_FILES.md) gets
   * the next free one, "(2)": takenInTeamPlace; a name the team folder refuses gets a safe one, rooms/file-moves.ts
   * safeName; never an overwrite). Its upload event carries { attachment, roomId } (the file's history reads "Sent in the chat
   * room"). The room's limits stay (maxFor), a picture's metadata is cut out first as for any room photo, and bytes on
   * the download-only list are refused (they never become a team file the AI could be handed). The room keeps no bytes:
   * the row gets a room_file_refs row. A row that cannot be made sends the placed file to the trash.
   */
  private async createInTeamFolder(userId: string, roomId: string, place: TeamPlace, clean: string, src: string, sha256: string): Promise<RoomFile> {
    const db = this.ctx.db
    const locale = personLocale(db, userId)
    const team = componentC(this.ctx).files
    if (this.ctx.files.quarantine.hasHash(sha256)) fail('unavailable', SAFE_OPS_TEXT.quarantined[locale], { params: { reason: 'quarantined' } })
    const head = Buffer.alloc(64 * 1024)
    const fd = fs.openSync(src, 'r')
    let headLen = 0
    try { headLen = fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
    const size = fs.statSync(src).size
    this.assertSize(userId, size)
    const first = head.subarray(0, headLen)
    const fmt = imageFormat(first)
    const kind = attachmentKind(clean) === 'image' && (size > SMALL_UPLOAD_MAX || (!fmt && !plainPicture(first, clean))) ? 'other' : attachmentKind(clean)
    const dims = kind === 'image' ? displaySize(first) : null
    // like any room photo, the place it was taken, the camera and other metadata are cut out (uploads/metadata.ts)
    let stored = sha256
    if (kind === 'image' && fmt) {
      const cleaned = cleanImage(fs.readFileSync(src), PHOTO)
      if (!(cleaned instanceof Uint8Array)) { fs.rmSync(src, { force: true }); return fail('validation', tr('roomPhotoUnreadable', locale)) }
      fs.writeFileSync(src, cleaned)
      stored = createHash('sha256').update(cleaned).digest('hex')
    }
    if (!place.exists) {
      // another upload of the same moment may have made it just now
      try { team.mkdir(userId, place.folder) } catch (e) { if (!(e instanceof FileError && e.key === 'exists')) throw e }
    }
    const id = newId()
    const entry = await team.placeUpload(userId, place.folder, safeName(clean), src, 'rename', stored, { action: 'upload', detail: { attachment: id, roomId } }, { taken: takenInTeamPlace })
    const at = path.join(team.root, ...entry.path.split('/'))
    let placed: fs.Stats | null = null
    try { placed = fs.lstatSync(at) } catch { /* gone already: refused below */ }
    try {
      if (!placed?.isFile()) fail('not_found')
      // the room may have been archived, or the person taken out, while it was placed
      this.member(userId, roomId)
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      db.transaction(() => {
        db.query(`INSERT INTO room_files (id, room_id, user_id, name, size, mime, kind, width, height, sha256, thumb, created_at, origin)
          VALUES (?,?,?,?,?,?,?,?,?,?,0,?,'upload')`).run(id, roomId, userId, name, placed!.size, mimeOf(name) ?? 'application/octet-stream', kind, dims?.width ?? null, dims?.height ?? null, stored, nowIso())
        this.refs().add(id, entry.path, placed!, stored)
      })()
    } catch (e) {
      // only the file this upload put there (not one that took its place meanwhile)
      try {
        const now = fs.lstatSync(at)
        if (placed && now.ino === placed.ino && now.dev === placed.dev) team.remove(userId, entry.path)
      } catch (err) { this.ctx.log.warn('a room upload kept in the team folder whose row failed could not go to the trash', { err }) }
      throw e
    }
    return this.refs().view(userId, db.query('SELECT * FROM room_files WHERE id = ?').get(id) as FileRow)
  }

  /**
   * "Add from team files" in a project's chat room (teamCopy there): a reference to the team file `rel`, never a copy
   * (docs/decisions/20261120-project-is-room.md D3): `userId`'s unsent upload marked with its team path and stamp, as a
   * copy is (the same unchanged pick again gives it back; Rooms.send checks the access again and audits it). A member
   * who cannot open the file sees it as "unavailable". Its content hash is read once, through the checked descriptor.
   */
  private async teamRef(userId: string, roomId: string, src: { abs: string; name: string; rel: string; st: fs.Stats }, stamp: string, locale: Locale): Promise<RoomFile> {
    const db = this.ctx.db
    const same = db.query('SELECT f.* FROM room_files f JOIN room_file_refs r ON r.room_file_id = f.id WHERE f.room_id = ? AND f.user_id = ? AND f.message_id IS NULL AND f.team_path = ? AND f.team_stamp = ? ORDER BY f.created_at DESC LIMIT 1').get(roomId, userId, src.rel, stamp) as FileRow | null
    if (same) return this.refs().view(userId, same)
    // each new reference hashes the file: as for a chat's team file references (uploads/team-refs.ts ATTACH_RATE_MAX),
    // at most that many new ones a person in ten minutes (429), and at most TEAM_REFS_UNSENT_MAX not sent yet (409)
    const since = new Date(Date.now() - 10 * 60_000).toISOString()
    const recent = (db.query('SELECT COUNT(*) n FROM room_files f JOIN room_file_refs r ON r.room_file_id = f.id WHERE f.user_id = ? AND f.team_path IS NOT NULL AND f.created_at > ?').get(userId, since) as { n: number }).n
    if (recent >= ATTACH_RATE_MAX) throw new HttpError('rate_limited', undefined, { retryAfter: 60 })
    const unsent = (db.query('SELECT COUNT(*) n FROM room_files f JOIN room_file_refs r ON r.room_file_id = f.id WHERE f.user_id = ? AND f.message_id IS NULL').get(userId) as { n: number }).n
    if (unsent >= TEAM_REFS_UNSENT_MAX) fail('conflict', tr('roomTeamCopiesFull', locale, { max: `${TEAM_REFS_UNSENT_MAX}` }), { params: { reason: 'team_refs_full' } })
    let sha: string
    try { sha = await hashChecked(src.abs, src.st) } catch { return fail('not_found') }
    this.member(userId, roomId)
    const id = newId()
    const kind = attachmentKind(src.name)
    let dims: { width: number; height: number } | null = null
    if (kind === 'image') {
      try {
        const head = Buffer.alloc(64 * 1024)
        const { fd } = openChecked(src.abs, src.st)
        try { dims = displaySize(head.subarray(0, fs.readSync(fd, head, 0, head.length, 0))) } finally { fs.closeSync(fd) }
      } catch { /* no size: shown as a file */ }
    }
    db.transaction(() => {
      db.query(`INSERT INTO room_files (id, room_id, user_id, name, size, mime, kind, width, height, sha256, thumb, created_at, team_path, team_stamp, origin)
        VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,'team_copy')`).run(id, roomId, userId, src.name, src.st.size, mimeOf(src.name) ?? 'application/octet-stream', kind, dims?.width ?? null, dims?.height ?? null, sha, nowIso(), src.rel, stamp)
      this.refs().add(id, src.rel, src.st, sha)
    })()
    return this.refs().view(userId, db.query('SELECT * FROM room_files WHERE id = ?').get(id) as FileRow)
  }

  /** The rows among these kept in the team folder, by id (read before they are deleted: their reference goes with them). */
  private refRows(ids: readonly string[]): Map<string, RoomRefRow> {
    const out = new Map<string, RoomRefRow>()
    for (const id of this.refs().refIds(ids)) { const r = this.refs().row(id); if (r) out.set(id, r) }
    return out
  }

  /** An upload of `f.user_id` taken out before it was sent (a removed chip, an abandoned upload), kept in the team folder:
   * its team path when the file should go to the trash: the upload event names this row and its room, no other chat's
   * or room's reference shows the very file, and it is still the file put there (the same place and inode, the same
   * size, not modified since). Else null: anything else stays where it is (a team file picked from Files, one moved,
   * renamed or edited since, one shown elsewhere). Read before the row goes. */
  private uploadToTrash(f: Pick<FileRow, 'id' | 'room_id' | 'user_id' | 'size' | 'created_at'>, ref: RoomRefRow): string | null {
    if (!f.user_id) return null
    const uploaded = this.ctx.db.query("SELECT 1 FROM file_events WHERE path = ? AND user_id = ? AND action = 'upload' AND json_extract(detail, '$.attachment') = ? AND json_extract(detail, '$.roomId') = ? LIMIT 1")
      .get(ref.path_at_attach, f.user_id, f.id, f.room_id)
    if (!uploaded || otherRefTo(this.ctx.db, { table: 'room_file_refs', id: f.id }, ref)) return null
    const s = this.refs().locate(f.user_id, f, { persist: true })
    if (s.state !== 'ok' || s.rel !== ref.path_at_attach || s.st.ino !== ref.ino || s.st.dev !== ref.dev || s.st.size !== f.size) return null
    // modified after it was sent in (2 s for the file system's clock)
    if (Math.floor(s.st.mtimeMs) > Date.parse(f.created_at) + 2000) return null
    return s.rel
  }

  /** Rows that went (`rows`): a room-stored file's bytes and thumbnails go; a row kept in the team folder (`refs`, read
   * before) leaves the disk alone, except `trash` (uploadToTrash's answers), which go to the team trash as their
   * uploader's delete. */
  private afterDelete(rows: readonly Pick<FileRow, 'id' | 'room_id'>[], refs: ReadonlyMap<string, RoomRefRow>, trash: ReadonlyMap<string, { userId: string; rel: string; ino: number; dev: number }> = new Map()) {
    for (const f of rows) {
      if (refs.has(f.id)) {
        this.refs().forget(f.id)
        const t = trash.get(f.id)
        if (t) try {
          // still the very file uploadToTrash checked (nothing took its place meanwhile)
          const now = fs.lstatSync(path.join(componentC(this.ctx).files.root, ...t.rel.split('/')))
          if (now.isFile() && now.ino === t.ino && now.dev === t.dev) componentC(this.ctx).files.remove(t.userId, t.rel)
        } catch (e) { this.ctx.log.warn('a removed room upload could not go to the trash', { err: e }) }
        continue
      }
      fs.rmSync(path.join(this.dir(f.room_id), f.id), { force: true })
      this.removeThumbs(f)
    }
  }

  /**
   * A copy of the team file `rel` as `userId`'s upload in this room, not sent yet (Rooms.send takes its id). Checked now,
   * with their access today: they are in the room, may read the file (a folder, a link, a hard-linked or quarantined file
   * and one they may not read all answer 404, the same as a missing one), it is at most 50 MB (413) and the team disk has
   * room (507). The bytes are read from one open file (no swap between the check and the copy), hashed on the way to a
   * temp file, then kept like an upload (create: the metadata of a photo is cut out, a quarantined hash gets no preview).
   */
  async fromTeamFile(userId: string, roomId: string, rel: string, o: { origin?: RoomFileOrigin } = {}): Promise<RoomFile> {
    this.member(userId, roomId)
    const { abs, name, st: seen } = this.teamSource(userId, rel)
    let opened: { fd: number; st: fs.Stats }
    try { opened = openChecked(abs, seen) } catch { return fail('not_found') }
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
    try { return await this.create(userId, roomId, name, tmp, sha, { roomStorage: true, origin: o.origin ?? 'answer_copy' }) } finally { fs.rmSync(tmp, { force: true }) }
  }

  /**
   * A room copy of something an answer made beside the chat (an artifact's page, or a promo video's rendered MP4) that goes
   * with that answer sent to a room (chat/answer-share.ts sendShare): written to a temp file, hashed, then create() with
   * the same limits as any upload (the storage check, the person's size limit), kept in room storage like fromTeamFile's
   * copies. `src`: the bytes, or a file of the server's own (never a team path).
   */
  async fromMade(userId: string, roomId: string, name: string, src: { bytes: Uint8Array } | { abs: string }): Promise<RoomFile> {
    this.member(userId, roomId)
    const tmpDir = path.join(this.ctx.config.dataDir, 'uploads', 'tmp')
    const tmp = path.join(tmpDir, `${PRODUCT.tmpPrefix}room-${randomBytes(8).toString('hex')}`)
    let sha: string
    try {
      const size = 'bytes' in src ? src.bytes.byteLength : fs.statSync(src.abs).size
      this.assertSize(userId, size)
      assertStorageRoom(size)
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
      if ('bytes' in src) fs.writeFileSync(tmp, src.bytes, { mode: 0o600, flag: 'wx' })
      else await fs.promises.copyFile(src.abs, tmp, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(tmp, 0o600)
      sha = 'bytes' in src ? createHash('sha256').update(src.bytes).digest('hex') : await hashTemp(tmp)
    } catch (e) {
      fs.rmSync(tmp, { force: true })
      throw e
    }
    try { return await this.create(userId, roomId, name, tmp, sha, { roomStorage: true, origin: 'answer_copy' }) } finally { fs.rmSync(tmp, { force: true }) }
  }

  /** The team file `rel` as `userId` may read it now: a regular file they may open (anything else 404, like a missing
   * one), its real path, name and stat. */
  private teamSource(userId: string, rel: string): { abs: string; name: string; rel: string; st: fs.Stats } {
    const who = loadPrincipal(this.ctx.db, userId) ?? fail('not_found')
    const fx = this.ctx.files.fx, rules = this.ctx.files.rules()
    try {
      const a = authorize(fx, rules, who, rel, 'read', { mustExist: true })
      if (!a.st?.isFile() || !visiblePath(fx, rules, who, a.rel)) throw new Error('not a file I may open')
      return { abs: a.abs, name: a.segs[a.segs.length - 1]!, rel: a.rel, st: checkRegular(a.abs) }
    } catch { return fail('not_found') }
  }

  /**
   * "팀 파일" in a room's box: fromTeamFile's copy, kept as `userId`'s unsent upload marked with its team path and the file
   * as it was (team_stamp). The same file, unchanged, picked again in this room before sending: that copy again (no new
   * one). Over TEAM_COPIES_UNSENT_MAX of the person's unsent copies (all rooms) with this one: refused (409
   * team_copies_full, a plain line), before anything is read. Sent, Rooms.send audits it (room.team_file).
   */
  async teamCopy(userId: string, roomId: string, rel: string, locale: Locale): Promise<RoomFile> {
    this.member(userId, roomId)
    const src = this.teamSource(userId, rel)
    const stamp = `${src.st.size}:${Math.trunc(src.st.mtimeMs)}:${src.st.ino}`
    const key = [userId, roomId, src.rel, stamp].join('\n')
    // a project's chat room: a reference to the team file, never a copy (the same pick on its way: that one)
    if (projectRoomLink(this.ctx.db, roomId)) {
      const going = this.copying.get(key)
      if (going) return going
      const ref = (async () => { try { return await this.teamRef(userId, roomId, src, stamp, locale) } finally { this.copying.delete(key) } })()
      this.copying.set(key, ref)
      return ref
    }
    const same = this.ctx.db.query('SELECT * FROM room_files WHERE room_id = ? AND user_id = ? AND message_id IS NULL AND team_path = ? AND team_stamp = ? ORDER BY created_at DESC').all(roomId, userId, src.rel, stamp) as FileRow[]
    for (const f of same) {
      try { checkRegular(this.abs(f)); return fileOut(f) } catch { /* its file is gone: a new copy below */ }
    }
    // the same pick already on its way (a double tap, two boxes): that copy, not a second one
    const going = this.copying.get(key)
    if (going) return going
    // the cap counts the copies on their way too: their bytes are taken here, before anything awaits (one server
    // process: nothing else runs between the sum and the reservation), and given back once the row carries them
    // (a project room's reference holds no bytes: never counted here)
    const unsent = (this.ctx.db.query('SELECT COALESCE(SUM(size), 0) n FROM room_files WHERE user_id = ? AND message_id IS NULL AND team_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM room_file_refs rr WHERE rr.room_file_id = room_files.id)').get(userId) as { n: number }).n
    const held = this.reserved.get(userId) ?? 0
    if (unsent + held + src.st.size > TEAM_COPIES_UNSENT_MAX) fail('conflict', tr('roomTeamCopiesFull', locale, { max: '200 MB' }), { params: { reason: 'team_copies_full' } })
    this.reserved.set(userId, held + src.st.size)
    const copy = (async () => {
      try {
        const file = await this.fromTeamFile(userId, roomId, src.rel, { origin: 'team_copy' })
        this.ctx.db.query('UPDATE room_files SET team_path = ?, team_stamp = ? WHERE id = ?').run(src.rel, stamp, file.id)
        return file
      } finally {
        const left = (this.reserved.get(userId) ?? 0) - src.st.size
        if (left > 0) this.reserved.set(userId, left)
        else this.reserved.delete(userId)
        this.copying.delete(key)
      }
    })()
    this.copying.set(key, copy)
    return copy
  }

  /**
   * Before a send hands team-file copies to the room (Rooms.send): `userId` must still be able to open each one's team
   * file now (the copy was made with their access then: a person taken out of a group since must not pass that
   * group's file on). Copies they may not open any more are removed (their bytes are not kept for a day, not even for
   * them) and their names are returned; the send is then refused. Uploads and other copies are left as they are.
   */
  revokedTeamCopies(userId: string, roomId: string, fileIds: readonly string[]): { ids: string[]; names: string[] } {
    if (!fileIds.length) return { ids: [], names: [] }
    const copies = this.ctx.db.query(`SELECT id, room_id, name, team_path FROM room_files WHERE room_id = ? AND user_id = ? AND message_id IS NULL AND team_path IS NOT NULL AND id IN (${fileIds.map(() => '?').join(',')})`)
      .all(roomId, userId, ...fileIds) as Pick<FileRow, 'id' | 'room_id' | 'name' | 'team_path'>[]
    if (!copies.length) return { ids: [], names: [] }
    const who = loadPrincipal(this.ctx.db, userId)
    const fx = this.ctx.files.fx, rules = this.ctx.files.rules()
    const mayRead = (rel: string) => {
      if (!who) return false
      try { const a = authorize(fx, rules, who, rel, 'read'); return !a.st?.isDirectory() && !!visiblePath(fx, rules, who, a.rel) } catch { return false }
    }
    const gone = copies.filter((f) => !mayRead(f.team_path!))
    this.discardUnsent(userId, roomId, gone.map((f) => f.id))
    return { ids: gone.map((f) => f.id), names: gone.map((f) => f.name) }
  }

  /** Uploads of `userId` in this room not sent with a message: removed (a shared answer that did not go after all). */
  /** One kept in the team folder (a project room's) leaves the disk alone, unless it is the person's own upload,
   * unchanged and shown nowhere else: then it goes to the team trash (uploadToTrash). */
  discardUnsent(userId: string, roomId: string, fileIds: readonly string[]) {
    if (!fileIds.length) return
    const list = `(${fileIds.map(() => '?').join(',')})`
    const before = this.ctx.db.query(`SELECT id, room_id, user_id, size, created_at FROM room_files WHERE room_id = ? AND user_id = ? AND message_id IS NULL AND id IN ${list}`).all(roomId, userId, ...fileIds) as Pick<FileRow, 'id' | 'room_id' | 'user_id' | 'size' | 'created_at'>[]
    const refs = this.refRows(before.map((f) => f.id))
    const trash = new Map<string, { userId: string; rel: string; ino: number; dev: number }>()
    for (const f of before) { const r = refs.get(f.id); const rel = r ? this.uploadToTrash(f, r) : null; if (rel && r) trash.set(f.id, { userId, rel, ino: r.ino!, dev: r.dev! }) }
    const rows = this.ctx.db.query(`DELETE FROM room_files WHERE room_id = ? AND user_id = ? AND message_id IS NULL AND id IN ${list} RETURNING id, room_id`)
      .all(roomId, userId, ...fileIds) as Pick<FileRow, 'id' | 'room_id'>[]
    this.afterDelete(rows, refs, trash)
  }

  /**
   * The file for `userId`, checked now: in the room, and either sent in a message they may see (not deleted) or their
   * own upload not sent yet. thumb: the small preview (or the image itself when it is a small web image). quarantined:
   * its bytes are on the team's download-only list (the route then sends it only as a download). A file kept in the team
   * folder (`teamFile`: a project room's): the team file as it is now, while I read its path now; its bytes may change.
   */
  open(userId: string, roomId: string, fileId: string, thumb: boolean): { abs: string; name: string; quarantined: boolean; sha256: string; teamFile?: true } {
    const me = this.member(userId, roomId)
    const f = this.ctx.db.query('SELECT * FROM room_files WHERE id = ? AND room_id = ?').get(fileId, roomId) as FileRow | null
    if (!f) return fail('not_found')
    if (f.message_id) {
      const m = messageRow(this.ctx.db, roomId, f.message_id)
      if (!m || m.deleted_at || !canSee(this.ctx.db, m, me)) fail('not_found')
    } else if (f.user_id !== userId) fail('not_found')
    const quarantined = this.ctx.files.quarantine.hasHash(f.sha256)
    // a project room's file kept in the team folder: where it is now, while I read it there (rooms/file-refs.ts)
    if (this.refs().isRef(f.id)) {
      const s = this.refs().locate(userId, f)
      if (s.state !== 'ok') return fail('not_found')
      const name = s.rel.slice(s.rel.lastIndexOf('/') + 1)
      // no thumbnail of its own: the picture itself when it is a small web image (as a chat's team file reference)
      if (thumb && (f.kind !== 'image' || !/^(png|jpe?g|gif|webp)$/.test(ext(name)) || s.st.size > 2 * 1024 * 1024)) fail('not_found')
      return { abs: s.abs, name, quarantined, sha256: f.sha256, teamFile: true }
    }
    // a file on its way to a project's Chat attachments (rooms/file-moves.ts): read from where it is staged, with the same
    // checks, until its reference is there
    const abs = this.stagedOf(f) ?? this.abs(f)
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

  /** Where a room file on its way to a project's folder is staged now (rooms/file-moves.ts 'placing', or a way back
   * that failed: 'kept' restore_failed, until the next start puts it back), when its room
   * storage path is empty; else null. */
  private stagedOf(f: Pick<FileRow, 'id' | 'room_id'>): string | null {
    const m = this.ctx.db.query("SELECT id, staged, ino, dev FROM room_file_moves WHERE room_file_id = ? AND state IN ('placing', 'cleanup', 'kept') AND staged IS NOT NULL").get(f.id) as { id: string; staged: string; ino: number | null; dev: number | null } | null
    if (!m || fs.existsSync(path.join(this.dir(f.room_id), f.id))) return null
    const at = path.join(this.ctx.files.fx.root, ...m.staged.split('/'))
    if (fs.existsSync(at)) return at
    // placed already, its reference not written yet (a stop between the two): the very file the move put there (its
    // upload event names the move, the same inode), until the mover adopts it
    const ev = this.ctx.db.query("SELECT path FROM file_events WHERE action = 'upload' AND json_extract(detail, '$.moved') = ? ORDER BY id DESC LIMIT 1").get(m.id) as { path: string } | null
    if (!ev || m.ino === null) return null
    const placed = path.join(this.ctx.files.fx.root, ...ev.path.split('/'))
    try { const st = fs.lstatSync(placed); return st.isFile() && st.nlink === 1 && st.ino === m.ino && st.dev === m.dev ? placed : null } catch { return null }
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
    }, HWP_LIMITS.inputBytes, { serverOwned: !f.teamFile })
    if (!read) throw new HwpError('changed')
    const hash = sha256(read.bytes)
    // a room-stored file is the bytes it was sent with; one kept in the team folder is the file as it is now
    if (!f.teamFile && hash !== f.sha256) throw new HwpError('changed')
    return { key: `room:${roomId}/${fileId}`, bytes: read.bytes, hash, version: f.teamFile ? hash : f.sha256, ext: /\.hwpx$/i.test(f.name) ? 'hwpx' : 'hwp' }
  }

  /** A message was deleted: its files go from the table, and a room-stored one from disk. A file kept in the team folder
   * (a project room's) stays there as an ordinary team file: deleting a message deletes only the message (owner
   * 2026-11-20, as in Slack); people delete the file from Files themselves. */
  removeForMessage(messageId: string) {
    const ids = (this.ctx.db.query('SELECT id FROM room_files WHERE message_id = ?').all(messageId) as { id: string }[]).map((r) => r.id)
    const refs = this.refRows(ids)
    const rows = this.ctx.db.query('DELETE FROM room_files WHERE message_id = ? RETURNING id, room_id').all(messageId) as Pick<FileRow, 'id' | 'room_id'>[]
    this.afterDelete(rows, refs)
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
    // (a row kept in the team folder has no bytes here: never counted as missing; nor one staged by the file mover,
    // rooms/file-moves.ts, whose bytes are in .system/room-moves/)
    const rows = this.ctx.db.query('SELECT id, room_id FROM room_files f WHERE NOT EXISTS (SELECT 1 FROM room_file_refs rr WHERE rr.room_file_id = f.id)').all() as Pick<FileRow, 'id' | 'room_id'>[]
    const known = new Set(rows.map((r) => `${r.room_id}/${r.id}`))
    // (a kept row still staged, restore_failed: its bytes are there too until the mover's reconcile puts them back)
    const staged = new Set((this.ctx.db.query("SELECT room_file_id FROM room_file_moves WHERE (state IN ('placing', 'cleanup') OR (state = 'kept' AND staged IS NOT NULL)) AND room_file_id IS NOT NULL").all() as { room_file_id: string }[]).map((r) => r.room_file_id))
    for (const r of rows) if (!staged.has(r.id) && !fs.existsSync(path.join(this.dir(r.room_id), r.id))) out.missingFiles++
    // a file moved to a project's folder whose room storage path is the very same file (a second link to it): unlinked,
    // never set aside as an orphan (the team file stays)
    const moved = new Map((this.ctx.db.query("SELECT room_file_id, ino, dev FROM room_file_moves WHERE state = 'done' AND room_file_id IS NOT NULL AND ino IS NOT NULL").all() as { room_file_id: string; ino: number; dev: number }[]).map((r) => [r.room_file_id, r]))
    const batch = this.newBatch(now)
    for (const room of rooms) {
      const dir = path.join(root, room)
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (n.endsWith(MOVING)) { fs.rmSync(path.join(dir, n), { force: true }); continue } // an interrupted copy
        const id = n.replace(THUMB, '')
        if (known.has(`${room}/${id}`)) continue
        const mv = moved.get(n)
        if (mv) {
          try { const st = fs.lstatSync(path.join(dir, n)); if (st.ino === mv.ino && st.dev === mv.dev) { fs.rmSync(path.join(dir, n), { force: true }); continue } } catch { /* set aside below */ }
        }
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

  /** Uploads never sent; once a day, the set-aside batches older than 30 days and the files of conversations archived
   * more than 30 days ago (purgeArchived). */
  sweep(now = Date.now()) {
    const cutoff = new Date(now - UNSENT_FILE_MS).toISOString()
    // an abandoned upload kept in the team folder (a project room's) is taken out as its removed chip would be
    const before = this.ctx.db.query('SELECT id, room_id, user_id, size, created_at FROM room_files WHERE message_id IS NULL AND created_at < ?').all(cutoff) as Pick<FileRow, 'id' | 'room_id' | 'user_id' | 'size' | 'created_at'>[]
    const refs = this.refRows(before.map((f) => f.id))
    const trash = new Map<string, { userId: string; rel: string; ino: number; dev: number }>()
    for (const f of before) { const r = refs.get(f.id); const rel = r ? this.uploadToTrash(f, r) : null; if (rel && r && f.user_id) trash.set(f.id, { userId: f.user_id, rel, ino: r.ino!, dev: r.dev! }) }
    const rows = this.ctx.db.query('DELETE FROM room_files WHERE message_id IS NULL AND created_at < ? RETURNING id, room_id').all(cutoff) as Pick<FileRow, 'id' | 'room_id'>[]
    this.afterDelete(rows, refs, trash)
    // a clock set back: the day starts again from now, so the daily part does not stop
    if (this.dailyAt !== null && now < this.dailyAt) this.dailyAt = now
    if (this.dailyAt === null || now - this.dailyAt >= DAILY_MS) {
      // each on its own: one that fails (a share that refuses a delete) neither stops the other nor runs again every
      // minute; it is tried again the next day
      let archived = { files: 0, more: false }, batches = 0
      try { archived = this.purgeArchived(now) } catch (e) { this.ctx.log.warn('archived conversations\' files not purged', { err: e }) }
      try { batches = this.purgeOrphans(now) } catch (e) { this.ctx.log.warn('set-aside room files not purged', { err: e }) }
      // not done (the time ran out on a large conversation): the next tick goes on
      if (!archived.more) this.dailyAt = now
      if (archived.files || batches) this.ctx.log.info('room files checked', { archivedFilesPurged: archived.files, orphanBatchesPurged: batches })
    }
    return rows.length
  }

  /**
   * The files of conversations archived more than ORPHAN_KEEP_MS ago, and still without a member (the rule that makes
   * them unreachable, checked here, not assumed): their rows go, then each file and its thumbnails, then the
   * conversation's empty folder. The messages stay. Nothing when the room files folder is not there (a share not
   * mounted: the rows would go while the bytes stay on the share) or when the clock looks wrong (earlier than the newest
   * room file or the newest archive). At most PURGE_BUDGET_MS a run; `more`: there is more to do.
   */
  purgeArchived(now = Date.now(), o: { batch?: number; budgetMs?: number } = {}): { files: number; more: boolean } {
    const out = { files: 0, more: false }
    if (!this.teamFolderPresent()) return out
    try { if (!fs.statSync(this.root()).isDirectory()) return out } catch { return out }
    const newest = this.ctx.db.query('SELECT MAX(created_at) t FROM room_files').get() as { t: string | null }
    const archived = this.ctx.db.query('SELECT MAX(archived_at) t FROM rooms').get() as { t: string | null }
    if ((newest.t && now < Date.parse(newest.t)) || (archived.t && now < Date.parse(archived.t))) {
      this.ctx.log.warn('the clock is earlier than the newest room file or archive; archived conversations keep their files', { newest: newest.t, archived: archived.t })
      return out
    }
    const cutoff = new Date(now - ORPHAN_KEEP_MS).toISOString()
    const batch = o.batch ?? PURGE_BATCH
    const del = this.ctx.db.query(`DELETE FROM room_files WHERE id IN (SELECT f.id FROM room_files f JOIN rooms r ON r.id = f.room_id
      WHERE r.archived_at IS NOT NULL AND r.archived_at < ? AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id) LIMIT ${Math.max(1, Math.floor(batch))})
      RETURNING id, room_id`)
    const until = Date.now() + (o.budgetMs ?? PURGE_BUDGET_MS)
    const rooms = new Set<string>()
    let failed = 0
    // (a row kept in the team folder: the row goes, the team file stays; its id is looked up before the delete)
    const refsAmong = this.ctx.db.query(`SELECT f.id FROM room_files f JOIN rooms r ON r.id = f.room_id JOIN room_file_refs rr ON rr.room_file_id = f.id
      WHERE r.archived_at IS NOT NULL AND r.archived_at < ? AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id)`)
    for (;;) {
      const refIds = new Set((refsAmong.all(cutoff) as { id: string }[]).map((r) => r.id))
      const rows = del.all(cutoff) as Pick<FileRow, 'id' | 'room_id'>[]
      // the rows are gone: a file that cannot be removed now is set aside by the next start's check (reconcile)
      for (const f of rows) {
        rooms.add(f.room_id)
        if (refIds.has(f.id)) { this.refs().forget(f.id); continue }
        try { fs.rmSync(path.join(this.dir(f.room_id), f.id), { force: true }); this.removeThumbs(f) } catch { failed++ }
      }
      out.files += rows.length
      if (rows.length < batch) break
      if (Date.now() > until) { out.more = true; break }
    }
    for (const r of rooms) try { fs.rmdirSync(this.dir(r)) } catch { /* not empty: an unsent upload's file, gone tomorrow */ }
    if (failed) this.ctx.log.warn('some files of archived conversations could not be removed', { failed })
    return out
  }
}

/** A file's sha256, read in parts (never whole in memory). */
async function hashTemp(abs: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of fs.createReadStream(abs)) h.update(chunk as Buffer)
  return h.digest('hex')
}

export function roomFilesOf(ctx: AppContext): RoomFiles {
  let s = services.get(ctx)
  if (!s) { s = new RoomFiles(ctx); services.set(ctx, s); roomFileRefsOf(ctx) }
  return s
}
