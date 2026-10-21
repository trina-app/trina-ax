// Chat attachments (tab 4 "첨부"): stored in the person's own folder users/<id>/.attachments/<chatId>/ (normal
// permission rules apply: nobody else, admins included, can read them), recorded in `attachments` so messages can
// refer to them by id (B: attachmentsByIds when a message is sent).
import fs from 'node:fs'
import path from 'node:path'
import type { Attachment } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { ext } from '../files/extract'
import { fileEvent } from '../files/store'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { badSegment } from '../policy/names'
import { publishChanges } from '../team-files/changes'
import { fileError } from '../team-files/errors'
import { checkRegular, freeName, installFile } from '../team-files/place'
import { mimeOf, type TeamFiles } from '../team-files/service'
import { imageSize, makeThumbnail } from './image'
import type { TeamFileRefs } from './team-refs'

export const ATTACHMENTS_DIR = '.attachments'

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

  /** The chat must belong to the caller and not be deleted. */
  assertOwnChat(userId: string, chatId: string) {
    const c = this.ctx.db.query('SELECT id FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(chatId, userId)
    if (!c) fileError('not_found', 'notChat')
  }

  /** Store an uploaded file (on disk at `src`) as an attachment of an own chat. */
  async create(userId: string, chatId: string, name: string, src: string, sha256: string): Promise<Attachment> {
    this.assertOwnChat(userId, chatId)
    const clean = name.normalize('NFC').replace(/[\u0000-\u001f]/g, '').trim()
    const bad = clean.includes('/') ? 'names cannot contain "/"' : badSegment(clean)
    if (bad) fileError('validation', 'badName', { name: bad })
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
    const kind = attachmentKind(final)
    const id = newId()
    const dims = kind === 'image' ? imageSize(head.subarray(0, headLen)) : null
    let thumb: string | null = null
    if (kind === 'image') {
      const dst = path.join(this.thumbsDir(), `${id}.jpg`)
      try { if (await makeThumbnail(r.abs, dst, 320, path.join(this.ctx.config.dataDir, 'work'))) thumb = `thumbs/${id}.jpg` } catch (e) { this.ctx.log.debug('thumbnail failed', { err: e }) }
    }
    const mime = mimeOf(final) ?? 'application/octet-stream'
    this.ctx.db.query(`INSERT INTO attachments (${COLS}, sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, chatId, r.rel, final, size, mime, kind, dims?.width ?? null, dims?.height ?? null, thumb, sha256)
    fileEvent(this.ctx.db, { turnId: null, userId, path: r.rel, action: 'upload', size, sha256, detail: { attachment: id, chatId } })
    this.files.extractText(r.rel)
    publishChanges(this.ctx, [{ path: r.rel, action: 'create', by: { id: userId, name: user.name }, turnId: null }])
    return toApi(this.row(id)!)
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
      try { authorize(this.files.fx, this.files.rules(), user, r.path, 'read'); checkRegular(abs); return { abs, name: `${r.name}.jpg` } } catch { /* fall through */ }
    }
    const a = authorize(this.files.fx, this.files.rules(), user, r.path, 'read')
    const st = checkRegular(a.abs)
    if (/^(png|jpe?g|gif|webp)$/.test(ext(r.name)) && st.size <= 2 * 1024 * 1024) return { abs: a.abs, name: r.name }
    throw new HttpError('not_found')
  }

  /** Drop thumbnails whose attachment row is gone (chat purged). */
  sweep() {
    const dir = this.thumbsDir()
    let n = 0
    try {
      for (const f of fs.readdirSync(dir)) {
        const id = f.replace(/\.jpg$/, '')
        if (!this.ctx.db.query('SELECT 1 FROM attachments WHERE id = ?').get(id)) { fs.rmSync(path.join(dir, f), { force: true }); n++ }
      }
    } catch { /* no thumbs yet */ }
    return n
  }
}
