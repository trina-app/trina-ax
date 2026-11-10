// Chat attachments (tab 4 "첨부"): stored in the person's own folder users/<id>/.attachments/<chatId>/ (normal
// permission rules apply: nobody else, admins included, can read them), recorded in `attachments` so messages can
// refer to them by id (B: attachmentsByIds when a message is sent). In a shared project chat a file from the computer
// goes into the project folder instead and is attached as a team file (uploads/shared-chat.ts).
import fs from 'node:fs'
import path from 'node:path'
import type { Attachment } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { which } from '../config'
import { newId } from '../db'
import { ext } from '../files/extract'
import { fileEvent } from '../files/store'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { badSegment } from '../policy/names'
import { publishChanges } from '../team-files/changes'
import { fileError } from '../team-files/errors'
import { checkRegular, freeName, hashFile, installFile } from '../team-files/place'
import { mimeOf, type TeamFiles } from '../team-files/service'
import { displaySize, firstBytes, makeThumbnail, mayHaveAlpha, type ThumbExt } from './image'
import type { TeamFileRefs } from './team-refs'
import { visibleSharedChat } from '../chat/shared'
import type { ChatRow } from '../chat/store'
import { instructionFile } from '../team-files/ai-trash'
import { FileError } from '../team-files/errors'
import { ToolError } from '../policy/errors'
import { sharedUploadPlace } from './shared-chat'

export const ATTACHMENTS_DIR = '.attachments'
/** settings: set once every thumbnail from before transparent ones were PNG was looked at (refreshThumbs) */
export const THUMBS_REFRESHED_SETTING = 'attachments.thumbsTransparent'

const KIND: [RegExp, Attachment['kind']][] = [
  [/^(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/, 'image'],
  [/^pdf$/, 'pdf'],
  [/^(docx?|odt|rtf|hwpx?|pages)$/, 'document'],
  [/^(xlsx?|ods|csv|tsv|numbers)$/, 'spreadsheet'],
  [/^(pptx?|odp|key)$/, 'presentation'],
  [/^(mp3|m4a|wav|ogg|oga|flac|aac|opus|weba)$/, 'audio'],
  [/^(mp4|mov|webm|mkv|avi|m4v)$/, 'video'],
  [/^(txt|md|markdown|json|xml|html?|ya?ml|js|ts|tsx|jsx|py|go|rs|java|c|h|cpp|css|sql|log|ini|toml|sh)$/, 'text'],
]
export const attachmentKind = (name: string): Attachment['kind'] => KIND.find(([re]) => re.test(ext(name)))?.[1] ?? 'other'

interface Row { id: string; user_id: string; chat_id: string; path: string; name: string; size: number; mime: string; kind: Attachment['kind']; width: number | null; height: number | null; thumb_path: string | null }
const toApi = (r: Row): Attachment => ({
  id: r.id, name: r.name, path: r.path, size: r.size, mime: r.mime, kind: r.kind,
  ...(r.width ? { width: r.width } : {}), ...(r.height ? { height: r.height } : {}),
})
const COLS = 'id, user_id, chat_id, path, name, size, mime, kind, width, height, thumb_path'

export class Attachments {
  constructor(private ctx: AppContext, private files: TeamFiles, private refs?: TeamFileRefs) {}

  private thumbsDir() { return path.join(this.ctx.config.dataDir, 'thumbs') }

  /** A file from the computer may go into this chat: the caller's own chat (not deleted), or a shared project chat they
   * see whose project folder they may write (the file goes there: uploads/shared-chat.ts sharedUploadPlace, which
   * refuses otherwise; with its reference's limits and, `sha256` known, the download-only list, so a large upload is
   * refused before its bytes are sent). Checked again when the file is placed (rules may change meanwhile). */
  assertUploadChat(userId: string, chatId: string, sha256?: string) {
    const shared = visibleSharedChat(this.ctx.db, this.ctx.files, userId, chatId)
    if (shared) { this.sharedChecks(userId, shared, sha256); return }
    this.assertOwnChat(userId, chatId)
  }

  /** The place of a shared chat's upload and what refuses it before anything is written. */
  private sharedChecks(userId: string, chat: ChatRow, sha256?: string) {
    const place = sharedUploadPlace(this.ctx, this.files, userId, chat)
    // the safety check's download-only list: such bytes are never a team file the AI could be handed
    if (sha256 && this.ctx.files.quarantine.hasHash(sha256)) throw new ToolError('Generated output is download-only.', 'safe_ops_quarantined')
    if (!this.refs) throw new HttpError('unavailable')
    this.refs.assertRoom(userId, chat.id)
    return place
  }

  private assertOwnChat(userId: string, chatId: string) {
    const c = this.ctx.db.query('SELECT id FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND shared_at IS NULL').get(chatId, userId)
    if (!c) fileError('not_found', 'notChat')
  }

  /** Voice input for a chat (a recording becomes text in the message box, never an attachment): the caller's own chat,
   * or a shared project chat they see. */
  assertVoiceChat(userId: string, chatId: string) {
    if (visibleSharedChat(this.ctx.db, this.ctx.files, userId, chatId)) return
    const c = this.ctx.db.query('SELECT id FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(chatId, userId)
    if (!c) fileError('not_found', 'notChat')
  }

  /** Store an uploaded file (on disk at `src`) as an attachment of an own chat, or of a shared project chat the caller
   * sees (createShared). */
  async create(userId: string, chatId: string, name: string, src: string, sha256: string): Promise<Attachment> {
    const shared = visibleSharedChat(this.ctx.db, this.ctx.files, userId, chatId)
    if (!shared) this.assertOwnChat(userId, chatId)
    const clean = name.normalize('NFC').replace(/[\u0000-\u001f]/g, '').trim()
    const bad = clean.includes('/') ? 'names cannot contain "/"' : badSegment(clean)
    if (bad) fileError('validation', 'badName', { name: bad })
    if (shared) return this.createShared(userId, shared, clean, src, sha256)
    const user = this.files.principal(userId)
    const rules = this.files.rules()
    const dir = authorize(this.files.fx, rules, user, ['users', userId, ATTACHMENTS_DIR, chatId].join('/'), 'write', { mustExist: false, createDirs: true })
    if (!dir.exists) {
      let cur = this.files.root
      for (const s of dir.segs) { cur = path.join(cur, s); try { fs.mkdirSync(cur, { mode: 0o700 }) } catch (e: any) { if (e.code !== 'EEXIST') throw e } }
    }
    const final = freeName(dir.abs, clean)
    const r = authorize(this.files.fx, rules, user, [...dir.segs, final].join('/'), 'write', { mustExist: false })
    const head = Buffer.alloc(64 * 1024)
    const fd = fs.openSync(src, 'r')
    let headLen = 0
    try { headLen = fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
    const size = fs.statSync(src).size
    installFile(this.files.root, r.segs, src)
    const quarantined = this.ctx.files.quarantine.hasHash(sha256)
    const kind = attachmentKind(final)
    const id = newId()
    const dims = kind === 'image' && !quarantined ? displaySize(head.subarray(0, headLen)) : null
    let thumb: string | null = null
    if (kind === 'image' && !quarantined) {
      // thumbs/<id>.jpg, or thumbs/<id>.png for a picture with transparency (uploads/image.ts makeThumbnail)
      try { const made = await makeThumbnail(r.abs, path.join(this.thumbsDir(), id), 320, path.join(this.ctx.config.dataDir, 'work')); if (made) thumb = `thumbs/${id}.${made}` } catch (e) { this.ctx.log.debug('thumbnail failed', { err: e }) }
    }
    const mime = mimeOf(final) ?? 'application/octet-stream'
    this.ctx.db.query(`INSERT INTO attachments (${COLS}, sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, chatId, r.rel, final, size, mime, kind, dims?.width ?? null, dims?.height ?? null, thumb, sha256)
    fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'upload', size, sha256, detail: { attachment: id, chatId } })
    this.files.extractText(r.rel)
    publishChanges(this.ctx, [{ path: r.rel, action: 'create', by: { id: userId, name: user.name }, turnId: null }])
    return toApi(this.row(id)!)
  }

  /**
   * A file from the computer in a shared project chat (uploads/shared-chat.ts): placed by the person in the project's
   * chat attachments folder (made first when missing, as their "new folder"), as a Files-screen upload of theirs (a taken
   * name or an instruction file's name gets the next free one; the upload event carries the attachment and the chat),
   * then attached as a team file. Its reference's limits are checked before anything is placed; a reference that still
   * cannot be made sends the file to the trash, so nothing is left behind for an attachment that never was.
   */
  private async createShared(userId: string, chat: ChatRow, name: string, src: string, sha256: string): Promise<Attachment> {
    const place = this.sharedChecks(userId, chat, sha256)
    if (!place.exists) {
      // another upload of the same moment may have made it just now
      try { this.files.mkdir(userId, place.folder) } catch (e) { if (!(e instanceof FileError && e.key === 'exists')) throw e }
    }
    const id = newId()
    // the bytes were checked against sha256 (the upload's own check) and moved into place as they are: what was placed is
    // known by its inode, so the reference does not read the whole file again
    const before = fs.statSync(src)
    const entry = await this.files.placeUpload(userId, place.folder, name, src, 'rename', sha256, { action: 'upload', detail: { attachment: id, chatId: chat.id } }, { taken: instructionFile })
    let placed: fs.Stats | null = null
    try { placed = fs.lstatSync(path.join(this.files.root, ...entry.path.split('/'))) } catch { /* gone already: create says so */ }
    const known = placed && placed.isFile() && placed.size === before.size ? { sha256, ino: placed.ino, dev: placed.dev, size: placed.size } : undefined
    try { return await this.refs!.create(userId, chat.id, entry.path, { id, known }) } catch (e) {
      // only the file this upload put there (not one that took its place meanwhile)
      try {
        const now = fs.lstatSync(path.join(this.files.root, ...entry.path.split('/')))
        if (placed && now.ino === placed.ino && now.dev === placed.dev) this.files.remove(userId, entry.path)
      } catch (err) { this.ctx.log.warn('an upload whose attachment failed could not go to the trash', { err }) }
      throw e
    }
  }

  /** An upload whose chip was taken out before its answer reached the box (a cancelled session, a dropped request): a
   * file it put in a shared chat's project folder goes to the trash (TeamFileRefs.discard); anything else stays. */
  discardSaved(userId: string, a: Attachment | null | undefined) {
    if (a?.source !== 'team' || !this.refs) return
    try { this.refs.discard(userId, a.id) } catch (e) { this.ctx.log.debug('a removed upload was not taken out', { err: e }) }
  }

  private row(id: string): Row | null { return this.ctx.db.query(`SELECT ${COLS} FROM attachments WHERE id = ?`).get(id) as Row | null }

  /** For component B (sending a message): the caller's attachments of that chat, in the order asked, unknown ids dropped.
   * Team-file references are looked up again with the caller's access now (unreadable ones are dropped too). */
  byIds(userId: string, chatId: string, ids: string[]): Attachment[] {
    return this.lookup(userId, chatId, ids).found
  }

  /** Like byIds, and which of the ids are the caller's own team-file references of this chat that are no longer
   * available to them (deleted, moved out of reach, access taken away): they attached those ids themselves, so
   * naming them tells nothing new; nothing about the files is said. */
  lookup(userId: string, chatId: string, ids: string[]): { found: Attachment[]; unavailable: string[] } {
    if (!ids.length) return { found: [], unavailable: [] }
    const rows = this.ctx.db.query(`SELECT ${COLS} FROM attachments WHERE user_id = ? AND chat_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(userId, chatId, ...ids) as Row[]
    const m = new Map<string, Attachment>(rows.map((r) => [r.id, toApi(r)]))
    const refs = this.refs?.byIds(userId, chatId, ids.filter((i) => !m.has(i)))
    for (const [id, a] of refs?.found ?? []) m.set(id, a)
    const seen = new Set<string>()
    const found = ids.filter((i) => (seen.has(i) ? false : (seen.add(i), true))).map((i) => m.get(i)).filter((a): a is Attachment => !!a)
    return { found, unavailable: refs?.unavailable ?? [] }
  }

  /** Thumbnail file of an own image attachment (generated, or the original when it is a small web image). */
  thumbnail(userId: string, id: string): { abs: string; name: string } | { bytes: Buffer; name: string; mime: string; etag: string } {
    const r = this.row(id)
    if (!r && this.refs?.isRef(id)) return this.refs.thumbnail(userId, id)
    if (!r || r.user_id !== userId || r.kind !== 'image') throw new HttpError('not_found')
    // the file itself may have been moved / deleted on the file screen: the person must still be able to read it
    const user = this.files.principal(userId)
    if (r.thumb_path) {
      const abs = path.join(this.ctx.config.dataDir, ...r.thumb_path.split('/'))
      // served as <name>.jpg or <name>.png, so its type is the thumbnail's (team-files/download.ts streamFile)
      try { authorize(this.files.fx, this.files.rules(), user, r.path, 'read'); checkRegular(abs); return { abs, name: `${r.name}${path.extname(r.thumb_path)}` } } catch { /* fall through */ }
    }
    const a = authorize(this.files.fx, this.files.rules(), user, r.path, 'read')
    const st = checkRegular(a.abs)
    if (/^(png|jpe?g|gif|webp)$/.test(ext(r.name)) && st.size <= 2 * 1024 * 1024) return { abs: a.abs, name: r.name }
    throw new HttpError('not_found')
  }

  /**
   * Once (THUMBS_REFRESHED_SETTING), a while after start: an image attached before transparent ones got a PNG thumbnail
   * has a JPEG one, black where the picture is see-through. Each one that can have transparency (a PNG, WebP or GIF:
   * makeThumbnail transparentOnly) is looked at again, one at a time below interactive work, while its file is still
   * the one attached (its sender may read it, the same bytes) and not on the download-only list; one with see-through
   * pixels gets thumbs/<id>.png and the JPEG one goes. Anything else keeps what it has; reads go on meanwhile. Stopped
   * by `signal` (the server closing) before it is done: the next start looks again.
   */
  async refreshThumbs(signal?: AbortSignal): Promise<{ refreshed: number } | null> {
    // no ffmpeg now (a server without it, or one being installed): not done, the next start looks again
    if (this.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(THUMBS_REFRESHED_SETTING) || !which('ffmpeg')) return null
    const rows = this.ctx.db.query("SELECT id, user_id, path, thumb_path, sha256 FROM attachments WHERE kind = 'image' AND thumb_path LIKE '%.jpg'").all() as (Pick<Row, 'id' | 'user_id' | 'path'> & { thumb_path: string; sha256: string })[]
    // the team folder empty (a share not mounted yet): not now, so none is passed over
    try { if (rows.length && !fs.readdirSync(this.files.root).length) return null } catch { return null }
    const work = path.join(this.ctx.config.dataDir, 'work')
    let refreshed = 0
    for (const r of rows) {
      await new Promise((res) => setImmediate(res)) // a row without alpha ends without waiting: requests get their turn between rows
      if (signal?.aborted) return { refreshed }
      const old = path.join(this.ctx.config.dataDir, ...r.thumb_path.split('/'))
      if (!fs.existsSync(old) || this.ctx.files.quarantine.hasHash(r.sha256)) continue
      let made: ThumbExt | null = null
      try {
        const a = authorize(this.files.fx, this.files.rules(), this.files.principal(r.user_id), r.path, 'read')
        checkRegular(a.abs)
        // its first bytes before its whole content: a JPEG or HEIC photo is not read through for nothing
        if (!mayHaveAlpha(firstBytes(a.abs)) || await hashFile(a.abs) !== r.sha256) continue
        made = await makeThumbnail(a.abs, path.join(this.thumbsDir(), r.id), 320, work, undefined, { transparentOnly: true, background: true, signal })
      } catch (e) { this.ctx.log.debug('thumbnail refresh failed', { err: e }) }
      if (made !== 'png') continue
      const png = `thumbs/${r.id}.png`
      // the attachment may have gone meanwhile (a purged chat): its new thumbnail goes too
      if (!this.ctx.db.query('UPDATE attachments SET thumb_path = ? WHERE id = ? AND thumb_path = ?').run(png, r.id, r.thumb_path).changes) {
        fs.rmSync(path.join(this.thumbsDir(), `${r.id}.png`), { force: true })
        continue
      }
      fs.rmSync(old, { force: true })
      refreshed++
    }
    if (signal?.aborted) return { refreshed }
    this.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(THUMBS_REFRESHED_SETTING, new Date().toISOString())
    if (refreshed) this.ctx.log.info('thumbnails of transparent attachments made again', { refreshed })
    return { refreshed }
  }

  /** Drop thumbnails whose attachment row is gone (chat purged). */
  sweep() {
    const dir = this.thumbsDir()
    let n = 0
    try {
      for (const f of fs.readdirSync(dir)) {
        const id = f.replace(/\.(jpg|png)$/, '')
        if (!this.ctx.db.query('SELECT 1 FROM attachments WHERE id = ?').get(id)) { fs.rmSync(path.join(dir, f), { force: true }); n++ }
      }
    } catch { /* no thumbs yet */ }
    return n
  }
}
