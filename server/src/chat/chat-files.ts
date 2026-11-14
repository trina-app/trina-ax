// Files from the computer in a chat shared with people and groups (docs/DECISIONS.md "Files from the computer in a chat
// shared with people", QA TC-1413; plan docs/AGENTS/plan/20261114-shared-chats-everywhere.md S6). Such a chat has no
// folder its people can all read, and a computer upload normally lands in its sender's own users/<id>/.attachments/,
// which nobody else may read. So the file belongs to the chat instead: kept by the server in
// <team>/.system/chat-files/<chat id>/<file id> (0700 / 0600; .system/ is closed to every person, the AI's file tools
// and the owner's export, and it is in every backup of the team folder, as room files are), recorded in chat_files
// (migration 400), and reached only through the chat:
//   - GET /api/chats/:id/files/:fileId (chatFor 'view': whoever sees the chat now) and the attachment thumbnail by id
//     (the same check through the file's chat). A file not sent in a message yet is its sender's alone.
//   - the AI of whoever runs a turn in the chat reads it with the chat_file tool (chat/chat-file-tool.ts), as that
//     person, while they are in the chat; what it read joins the chat's read scope as {type:'chat'} (its people).
// No folder rule changes and no exception under users/<id>/ is made anywhere. Removing someone from the chat, or making
// it private again, takes the files away from them with the chat (the same check). Deleting the chat for good removes
// its rows (ON DELETE CASCADE) and its folder (removeChat; the sweep removes what a purge elsewhere left).
// At the first share of a private chat the creator's earlier computer uploads in it are copied here (copyEarlier) and
// the messages point to the copies, so everyone in the chat sees them; the originals stay in the creator's folder.
// Limits are the chat attachments' (≤ 50 MB a file, the storage check, the download-only list); the bytes are counted in
// the team's storage (system/storage.ts counts .system/chat-files with the team folder).
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SMALL_UPLOAD_MAX, type Attachment } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { ext } from '../files/extract'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { authorize } from '../policy/authorize'
import { loadPrincipal } from '../policy/access'
import { badSegment } from '../policy/names'
import { checkRegular } from '../team-files/place'
import { mimeOf } from '../team-files/service'
import { attachmentKind } from '../uploads/attachments'
import { displaySize, makeThumbnail } from '../uploads/image'
import { cleanImage, imageFormat, PHOTO, plainPicture } from '../uploads/metadata'
import { assertStorageRoom } from '../system/storage'
import { fileError } from '../team-files/errors'
import { personLocale } from '../files/media-text'
import { tr } from './i18n'
import { seesChatFiles } from './chat-files-access'

/** An upload not sent in a message within a day is removed (as a room's). */
export const UNSENT_CHAT_FILE_MS = 24 * 3600_000
/** A file on disk without its row is set aside after this long (a create puts the file before its row) */
const ORPHAN_MS = 3600_000
/** Set-aside files (chat-files-orphans/) are kept this long, as room files' (a database restored from an older backup) */
export const CHAT_FILE_ORPHAN_KEEP_MS = 30 * 86400_000
/** At most this big in a chat shared with people (the multipart attachment limit; a chunked upload too) */
export const CHAT_FILE_MAX = SMALL_UPLOAD_MAX
const THUMB_EXTS = ['png', 'jpg'] as const

export interface ChatFileRow {
  id: string; chat_id: string; user_id: string; name: string; size: number; mime: string; kind: Attachment['kind']
  width: number | null; height: number | null; sha256: string; thumb: string | null; copied_from: string | null; created_at: string
}

/**
 * A picture's metadata (the place it was taken, the camera) cut out before other people get it, as a room's
 * (uploads/metadata.ts PHOTO keeps the colours, an animation and which way up it is). `kind` is the attachment kind by
 * its bytes: a picture that can be neither cleaned nor shown as it is (a TIFF, bytes that are not what the name says)
 * goes as a plain file. null: a picture whose metadata could not be cut out (not shared).
 */
export function cleanPicture(name: string, bytes: Uint8Array, quarantined: boolean): { bytes: Uint8Array; kind: Attachment['kind']; changed: boolean } | null {
  const head = bytes.subarray(0, 64 * 1024)
  const fmt = imageFormat(head)
  const named = attachmentKind(name)
  const kind = named === 'image' && !fmt && !plainPicture(head, name) ? 'other' : named
  if (kind !== 'image' || quarantined || !fmt) return { bytes, kind, changed: false }
  const cleaned = cleanImage(bytes, PHOTO)
  if (!(cleaned instanceof Uint8Array)) return null
  return { bytes: cleaned, kind, changed: true }
}

/** A computer upload of a chat's question (attachments row) that a first share copies (ChatFiles.copyEarlier) */
type EarlierRow = { id: string; user_id: string; path: string; name: string; size: number; thumb_path: string | null; sha256: string | null; created_at: string }
/** At most this many bytes are read in full by one Share check (earlierUploads); a file past it that would need reading
 * is not counted (the count never says more than will go) */
export const EARLIER_CHECK_BYTES = 100 * 1024 * 1024
/** The verdicts of earlier uploads read in full, by file and its state (path, inode, size, mtime): a Share check asked
 * again, and the save after it, read a file once */
const EARLIER_VERDICT_MAX = 500

/** The attachment a message carries for a chat file: no team path (it is in no folder), source 'chat'. */
export const chatFileAttachment = (r: ChatFileRow): Attachment => ({
  id: r.id, name: r.name, path: '', size: r.size, mime: r.mime, kind: r.kind, source: 'chat',
  ...(r.width ? { width: r.width } : {}), ...(r.height ? { height: r.height } : {}),
})

const services = new WeakMap<AppContext, ChatFiles>()

/** A file's state for the verdict cache: the same path, inode, size and mtime, and the bytes it must match */
const earlierKey = (st: { abs: string; ino: number; size: number; mtimeMs: number }, att: Pick<EarlierRow, 'sha256'>) => `${st.abs}\0${st.ino}\0${st.size}\0${st.mtimeMs}\0${att.sha256 ?? ''}`

export class ChatFiles {
  constructor(readonly ctx: AppContext) {}
  /** earlierVerdict: `${abs}\0${ino}\0${size}\0${mtimeMs}\0${sha256}` -> would it be copied (read in full) */
  private earlier = new Map<string, boolean>()
  root() { return path.join(this.ctx.files.fx.root, PRODUCT.systemDir, 'chat-files') }
  private dir(chatId: string) { return path.join(this.root(), chatId) }
  private abs(f: Pick<ChatFileRow, 'chat_id' | 'id'>) { return path.join(this.dir(f.chat_id), f.id) }
  private thumbBase(f: Pick<ChatFileRow, 'chat_id' | 'id'>) { return path.join(this.dir(f.chat_id), `${f.id}.thumb`) }
  private removeFiles(f: Pick<ChatFileRow, 'chat_id' | 'id'>) {
    fs.rmSync(this.abs(f), { force: true })
    for (const e of THUMB_EXTS) fs.rmSync(`${this.thumbBase(f)}.${e}`, { force: true })
  }

  row(id: string): ChatFileRow | null { return this.ctx.db.query('SELECT * FROM chat_files WHERE id = ?').get(id) as ChatFileRow | null }
  /** Is this id a chat file's? */
  has(id: string): boolean { return !!this.ctx.db.query('SELECT 1 FROM chat_files WHERE id = ?').get(id) }
  /** Does the chat hold any chat file (its AI gets chat_file then)? */
  inChat(chatId: string): boolean { return !!this.ctx.db.query('SELECT 1 FROM chat_files WHERE chat_id = ? LIMIT 1').get(chatId) }

  /** Was the file sent in a message of its chat (any branch)? Until then it is its sender's alone. */
  sent(f: Pick<ChatFileRow, 'id' | 'chat_id'>): boolean {
    return !!this.ctx.db.query("SELECT 1 FROM messages m, json_each(m.attachments) j WHERE m.chat_id = ? AND json_valid(m.attachments) AND json_extract(j.value, '$.id') = ? LIMIT 1").get(f.chat_id, f.id)
  }

  /** Does `userId` see the chat of a chat file now: one shared with people they are in (not in the trash, unless it is
   * theirs), or their own chat (one made private again keeps its files for its creator; the trash too)? The same rule
   * as chatFor 'view' with deleted chats allowed for their creator. */
  seesChat(userId: string, chatId: string): boolean { return seesChatFiles(this.ctx.db, userId, chatId) }

  /**
   * Keep an uploaded temp file (moved, not copied) as a file of this chat, sent by `userId`. The caller checked that the
   * chat is shared with people and `userId` is in it (uploads/attachments.ts). Audited (chat.file_add: the chat, the
   * size and kind; never the name).
   */
  async create(userId: string, chatId: string, name: string, src: string, sha256: string): Promise<Attachment> {
    const clean = name.normalize('NFC').replace(/[\u0000-\u001f]/g, '').trim()
    const bad = clean.includes('/') || clean.includes('\\') ? 'names cannot contain "/"' : badSegment(clean)
    if (bad) fail('validation', undefined, { fields: { 'body.name': bad } })
    // the multipart limit for a chunked upload too (it may be up to 20 GB elsewhere)
    const received = fs.statSync(src).size
    if (received > CHAT_FILE_MAX) fileError('payload_too_large', 'chatFileTooLarge', undefined, { reason: 'chat_file_too_large' })
    const pic = cleanPicture(clean, new Uint8Array(fs.readFileSync(src)), this.ctx.files.quarantine.hasHash(sha256))
    if (!pic) { fs.rmSync(src, { force: true }); return fail('validation', tr('roomPhotoUnreadable', personLocale(this.ctx.db, userId))) }
    let stored = sha256
    if (pic.changed) { fs.writeFileSync(src, pic.bytes); stored = createHash('sha256').update(pic.bytes).digest('hex') }
    const id = newId()
    fs.mkdirSync(this.dir(chatId), { recursive: true, mode: 0o700 })
    const dst = this.abs({ chat_id: chatId, id })
    try { fs.renameSync(src, dst) } catch { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }) }
    fs.chmodSync(dst, 0o600)
    // its time is now (a rename keeps the temp file's): the sweep sets a row-less file aside only an hour after this
    const t = new Date()
    fs.utimesSync(dst, t, t)
    const row = await this.record(userId, chatId, id, clean, dst, stored, null, pic.kind)
    audit(this.ctx.db, { actor: userId, action: 'chat.file_add', target: chatId, detail: { size: row.size, kind: row.kind } })
    // the sender checks the upload arrived whole against what was received, not against the cleaned picture (QA TC-2023)
    return { ...chatFileAttachment(row), ...(row.size !== received ? { receivedSize: received } : {}) }
  }

  /** The row of a file just put at `dst` (its preview made first). */
  private async record(userId: string, chatId: string, id: string, name: string, dst: string, sha256: string, copiedFrom: string | null, kind: Attachment['kind'], thumbFrom?: string | null): Promise<ChatFileRow> {
    const quarantined = this.ctx.files.quarantine.hasHash(sha256)
    const size = fs.statSync(dst).size
    let dims: { width: number; height: number } | null = null
    let thumb: string | null = null
    if (kind === 'image' && !quarantined) {
      const fd = fs.openSync(dst, 'r')
      const head = Buffer.alloc(64 * 1024)
      let n = 0
      try { n = fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
      dims = displaySize(head.subarray(0, n))
      const base = this.thumbBase({ chat_id: chatId, id })
      // an earlier upload's thumbnail is copied as it is (the same bytes); else one is made
      if (thumbFrom) {
        const e = path.extname(thumbFrom).slice(1)
        if (e === 'jpg' || e === 'png') { try { fs.copyFileSync(thumbFrom, `${base}.${e}`); fs.chmodSync(`${base}.${e}`, 0o600); thumb = e } catch { /* made below */ } }
      }
      if (!thumb) {
        try { thumb = await makeThumbnail(dst, base, 320, path.join(this.ctx.config.dataDir, 'work')) } catch (e) { this.ctx.log.debug('chat file thumbnail failed', { err: e }) }
      }
    }
    this.ctx.db.query(`INSERT INTO chat_files (id, chat_id, user_id, name, size, mime, kind, width, height, sha256, thumb, copied_from, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, chatId, userId, name, size, mimeOf(name) ?? 'application/octet-stream', kind, dims?.width ?? null, dims?.height ?? null, sha256, thumb, copiedFrom, nowIso())
    return this.row(id)!
  }

  /** The caller's own files of this chat among `ids` (sending or editing a message of theirs), by id. */
  ownByIds(userId: string, chatId: string, ids: readonly string[]): Map<string, Attachment> {
    if (!ids.length) return new Map()
    const rows = this.ctx.db.query(`SELECT * FROM chat_files WHERE chat_id = ? AND user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(chatId, userId, ...ids) as ChatFileRow[]
    return new Map(rows.map((r) => [r.id, chatFileAttachment(r)]))
  }

  /**
   * The file for `userId`, who sees its chat (the caller checked the chat: chatFor 'view', or seesChat): of that chat,
   * and sent in a message or their own upload not sent yet; else 404, the same as a missing one. thumb: the small
   * preview (or the picture itself when it is a small web image). quarantined: its bytes are on the team's
   * download-only list (the route then sends it only as a download).
   */
  open(userId: string, chatId: string, fileId: string, thumb: boolean): { abs: string; name: string; quarantined: boolean; sha256: string; row: ChatFileRow } {
    const f = this.ctx.db.query('SELECT * FROM chat_files WHERE id = ? AND chat_id = ?').get(fileId, chatId) as ChatFileRow | null
    if (!f) return fail('not_found')
    if (f.user_id !== userId && !this.sent(f)) fail('not_found')
    const quarantined = this.ctx.files.quarantine.hasHash(f.sha256)
    if (thumb) {
      if (f.thumb === 'jpg' || f.thumb === 'png') {
        const t = `${this.thumbBase(f)}.${f.thumb}`
        try { checkRegular(t); return { abs: t, name: `${f.name}.${f.thumb}`, quarantined, sha256: f.sha256, row: f } } catch { /* the original below */ }
      }
      if (quarantined || f.kind !== 'image' || !/^(png|jpe?g|gif|webp)$/.test(ext(f.name)) || f.size > 2 * 1024 * 1024) fail('not_found')
    }
    const abs = this.abs(f)
    try { checkRegular(abs) } catch { fail('not_found') }
    return { abs, name: f.name, quarantined, sha256: f.sha256, row: f }
  }

  /** The attachment thumbnail by id alone (GET /api/attachments/:id/thumbnail): checked through the file's chat. */
  thumbnail(userId: string, id: string): { abs: string; name: string } {
    const f = this.row(id)
    if (!f || f.kind !== 'image' || !this.seesChat(userId, f.chat_id)) return fail('not_found')
    const o = this.open(userId, f.chat_id, id, true)
    if (o.quarantined) fail('not_found')
    return { abs: o.abs, name: o.name }
  }

  /** A chip taken out before its message went: the caller's own upload, not sent, goes (row and bytes). Anything else:
   * false (someone else's, a sent one, none). */
  discard(userId: string, id: string): boolean {
    const f = this.row(id)
    if (!f || f.user_id !== userId || this.sent(f)) return false
    this.ctx.db.query('DELETE FROM chat_files WHERE id = ?').run(id)
    this.removeFiles(f)
    return true
  }

  /** The computer uploads in this chat's questions (in their sender's own folder) that a first share would copy here
   * (copyEarlier): how many, for the Share check ("N files you attached will be visible to them"). Only the ones that
   * would go, by copyEarlier's rule (QA TC-2022): gone, not a plain file, too large, no storage room, edited since it was
   * attached, or a picture that cannot be cleaned is not counted. Without reading a file when its state says enough: a
   * file that is not a picture, of the size it was attached with and not written since it was attached, is the same
   * bytes. Others (a picture, a file written since) are read in full, at most EARLIER_CHECK_BYTES for the whole check,
   * and the verdict is kept by the file's state for the save (copyEarlier) and a check asked again; one past the limit
   * is not counted. */
  async earlierUploads(chatId: string): Promise<number> {
    const rows = this.earlierRows(chatId)
    if (!rows.length) return 0
    const rules = this.ctx.files.rules()
    let n = 0
    let budget = EARLIER_CHECK_BYTES
    for (const att of rows) {
      try {
        const st = await this.statEarlier(att, rules)
        const picture = attachmentKind(att.name) === 'image'
        const untouched = st.size === att.size && st.mtimeMs <= Date.parse(att.created_at)
        if (!picture && untouched && att.sha256) { n++; continue }
        const known = this.earlier.get(earlierKey(st, att))
        if (known !== undefined) { if (known) n++; continue }
        if (st.size > budget) continue
        budget -= st.size
        await this.readEarlier(att, rules)
        n++
      } catch { /* would not be copied */ }
    }
    return n
  }

  /** The earlier upload's file as its sender may read it now (moved or deleted on the Files screen: left as it was): a
   * plain file, at most CHAT_FILE_MAX, room for it in the team's storage. Throws when it would not be copied. */
  private async statEarlier(att: EarlierRow, rules: ReturnType<AppContext['files']['rules']>): Promise<{ abs: string; ino: number; size: number; mtimeMs: number }> {
    const who = loadPrincipal(this.ctx.db, att.user_id)
    if (!who) throw new Error('sender gone')
    const src = authorize(this.ctx.files.fx, rules, who, att.path, 'read')
    const st = await fs.promises.lstat(src.abs)
    if (!st.isFile() || st.nlink > 1) throw new Error('not a plain file')
    if (st.size > CHAT_FILE_MAX) throw new Error('too large')
    assertStorageRoom(st.size)
    return { abs: src.abs, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }
  }

  /** An earlier upload as copyEarlier copies it: read as its sender may read it now, the bytes that were attached (not
   * one edited or replaced since), at most CHAT_FILE_MAX, room for it in the team's storage, a picture's metadata cut
   * out. Throws when it would not be copied. The verdict is kept by the file's state (earlierUploads). */
  private async readEarlier(att: EarlierRow, rules: ReturnType<AppContext['files']['rules']>): Promise<NonNullable<ReturnType<typeof cleanPicture>>> {
    const who = loadPrincipal(this.ctx.db, att.user_id)
    if (!who) throw new Error('sender gone')
    // the file as its sender may read it now (moved or deleted on the Files screen: left as it was)
    const src = authorize(this.ctx.files.fx, rules, who, att.path, 'read')
    const h = await fs.promises.open(src.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let bytes: Uint8Array
    let key = ''
    try {
      const st = await h.stat()
      if (!st.isFile() || st.nlink > 1) throw new Error('not a plain file')
      if (st.size > CHAT_FILE_MAX) throw new Error('too large')
      assertStorageRoom(st.size)
      key = earlierKey({ abs: src.abs, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }, att)
      // known not to go in this very state: not read again
      if (this.earlier.get(key) === false) throw new Error('known not to be copied')
      bytes = new Uint8Array(await h.readFile())
      if (bytes.byteLength !== st.size) throw new Error('changed while read')
    } finally { await h.close() }
    const keep = (ok: boolean) => {
      if (this.earlier.size >= EARLIER_VERDICT_MAX) this.earlier.delete(this.earlier.keys().next().value!)
      this.earlier.set(key, ok)
    }
    // only the bytes that were attached: a file edited or replaced on the Files screen since stays its sender's
    if (att.sha256 && createHash('sha256').update(bytes).digest('hex') !== att.sha256) { keep(false); throw new Error('changed since it was attached') }
    const pic = cleanPicture(att.name, bytes, this.ctx.files.quarantine.hasHash(att.sha256 ?? ''))
    keep(!!pic)
    if (!pic) throw new Error('picture metadata not removable')
    return pic
  }
  private earlierRows(chatId: string): EarlierRow[] {
    const ids = new Set<string>()
    const msgs = this.ctx.db.query("SELECT attachments FROM messages WHERE chat_id = ? AND role = 'user' AND attachments IS NOT NULL AND attachments <> '[]'").all(chatId) as { attachments: string }[]
    for (const m of msgs) {
      try { for (const a of JSON.parse(m.attachments) as Attachment[]) if (a.source !== 'team' && a.source !== 'chat') ids.add(a.id) } catch { /* none */ }
    }
    if (!ids.size) return []
    return this.ctx.db.query(`SELECT id, user_id, path, name, size, thumb_path, sha256, created_at FROM attachments WHERE chat_id = ? AND id IN (${[...ids].map(() => '?').join(',')})`).all(chatId, ...ids) as EarlierRow[]
  }

  /**
   * The first share of a private chat (chat/people-share.ts): the creator's computer uploads in its messages (in their
   * users/<id>/.attachments/, which only they may read) are copied here and every message that carries one points to the
   * copy, so everyone in the chat sees them. Read and written without blocking the server (one descriptor that follows
   * no link), a picture's metadata cut out as for an upload here. Not copied, and so still its sender's alone as before:
   * one gone, unreadable, edited or replaced since it was attached (another sha256), over CHAT_FILE_MAX, a picture that
   * cannot be cleaned, or one the team's storage has no room for (`notCopied` counts these, for the creator). The
   * originals stay where they are. Audited (chat.files_copied: how many of each).
   */
  async copyEarlier(chatId: string): Promise<{ copied: number; notCopied: number }> {
    const db = this.ctx.db
    const chat = db.query('SELECT user_id FROM chats WHERE id = ?').get(chatId) as { user_id: string } | null
    if (!chat) return { copied: 0, notCopied: 0 }
    const rows = this.earlierRows(chatId)
    if (!rows.length) return { copied: 0, notCopied: 0 }
    const rules = this.ctx.files.rules()
    const copies = new Map<string, Attachment>()
    let notCopied = 0
    for (const att of rows) {
      const id = newId()
      try {
        const pic = await this.readEarlier(att, rules)
        const sha = createHash('sha256').update(pic.bytes).digest('hex')
        await fs.promises.mkdir(this.dir(chatId), { recursive: true, mode: 0o700 })
        const dst = this.abs({ chat_id: chatId, id })
        await fs.promises.writeFile(dst, pic.bytes, { flag: 'wx', mode: 0o600 })
        // the old thumbnail shows the same pixels (cleaning keeps them)
        const thumbFrom = att.thumb_path ? path.join(this.ctx.config.dataDir, ...att.thumb_path.split('/')) : null
        copies.set(att.id, chatFileAttachment(await this.record(att.user_id, chatId, id, att.name, dst, sha, att.id, pic.kind, thumbFrom)))
      } catch (e) {
        this.removeFiles({ chat_id: chatId, id })
        notCopied++
        this.ctx.log.debug('an earlier upload was not copied to the chat', { err: e })
      }
    }
    // the messages that carry one point to its copy (nothing else rewrites a question's attachments)
    if (copies.size) {
      const msgs = db.query("SELECT id, attachments FROM messages WHERE chat_id = ? AND role = 'user' AND attachments IS NOT NULL AND attachments <> '[]'").all(chatId) as { id: string; attachments: string }[]
      db.transaction(() => {
        for (const m of msgs) {
          let atts: Attachment[] = []
          try { const v = JSON.parse(m.attachments); if (Array.isArray(v)) atts = v } catch { continue }
          const mine = (a: Attachment) => a.source !== 'team' && a.source !== 'chat' && copies.has(a.id)
          if (!atts.some(mine)) continue
          db.query('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify(atts.map((a) => (mine(a) ? copies.get(a.id)! : a))), m.id)
        }
      })()
    }
    audit(db, { actor: chat.user_id, action: 'chat.files_copied', target: chatId, detail: { files: copies.size, ...(notCopied ? { notCopied } : {}) } })
    return { copied: copies.size, notCopied }
  }

  /** The chat was deleted for good: its folder goes (its rows went with it). */
  removeChat(chatId: string) {
    this.ctx.db.query('DELETE FROM chat_files WHERE chat_id = ?').run(chatId)
    fs.rmSync(this.dir(chatId), { recursive: true, force: true })
  }

  private orphansRoot() { return path.join(this.ctx.files.fx.root, PRODUCT.systemDir, 'chat-files-orphans') }

  /**
   * Uploads never sent (a day old) go. Nothing else is deleted on a guess: the folder of a chat that is gone and a file
   * without its row (an hour old: a create puts the file a moment before its row) are set aside in
   * .system/chat-files-orphans/<time>-<pid>-<n>/<chat id>/ (a database restored from an older backup than the folder:
   * going back stays possible), and such batches go after CHAT_FILE_ORPHAN_KEEP_MS, as room files' (rooms/files.ts).
   */
  sweep(now = Date.now()): number {
    const cutoff = new Date(now - UNSENT_CHAT_FILE_MS).toISOString()
    const old = this.ctx.db.query('SELECT id, chat_id FROM chat_files WHERE created_at < ?').all(cutoff) as Pick<ChatFileRow, 'id' | 'chat_id'>[]
    let n = 0
    for (const f of old) {
      if (this.sent(f)) continue
      this.ctx.db.query('DELETE FROM chat_files WHERE id = ?').run(f.id)
      this.removeFiles(f)
      n++
    }
    let batch: string | null = null
    const aside = (chatId: string, name: string | null) => {
      if (!batch) {
        const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
        for (let i = 0; ; i++) { batch = path.join(this.orphansRoot(), `${stamp}-${process.pid}-${i}`); if (!fs.existsSync(batch)) break }
      }
      const to = path.join(batch!, chatId)
      fs.mkdirSync(name ? to : batch!, { recursive: true, mode: 0o700 })
      fs.renameSync(name ? path.join(this.dir(chatId), name) : this.dir(chatId), name ? path.join(to, name) : to)
      n++
    }
    let chats: string[] = []
    try { chats = fs.readdirSync(this.root()) } catch { chats = [] }
    for (const c of chats) {
      try {
        if (!this.ctx.db.query('SELECT 1 FROM chats WHERE id = ?').get(c)) { aside(c, null); continue }
        for (const name of fs.readdirSync(this.dir(c))) {
          const id = name.replace(/\.thumb\.(jpg|png)$/, '')
          if (this.ctx.db.query('SELECT 1 FROM chat_files WHERE id = ? AND chat_id = ?').get(id, c)) continue
          if (now - fs.statSync(path.join(this.dir(c), name)).mtimeMs < ORPHAN_MS) continue
          aside(c, name)
        }
      } catch (e) { this.ctx.log.debug('chat files sweep passed a folder over', { err: e }) }
    }
    // batches set aside long enough ago, by their folder's time (a clock set back keeps them)
    let batches: string[] = []
    try { batches = fs.readdirSync(this.orphansRoot()) } catch { /* none */ }
    for (const b of batches) {
      try {
        const p = path.join(this.orphansRoot(), b)
        if (now - fs.statSync(p).mtimeMs >= CHAT_FILE_ORPHAN_KEEP_MS) { fs.rmSync(p, { recursive: true, force: true }); n++ }
      } catch { /* gone meanwhile */ }
    }
    return n
  }
}

export function chatFilesOf(ctx: AppContext): ChatFiles {
  let s = services.get(ctx)
  if (!s) { s = new ChatFiles(ctx); services.set(ctx, s) }
  return s
}

export { seesChatFiles }
