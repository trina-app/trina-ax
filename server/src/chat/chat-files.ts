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
import type { Attachment } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { ext } from '../files/extract'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { authorize } from '../policy/authorize'
import { loadPrincipal } from '../policy/access'
import { badSegment } from '../policy/names'
import { checkRegular, hashFile, openChecked } from '../team-files/place'
import { mimeOf } from '../team-files/service'
import { attachmentKind } from '../uploads/attachments'
import { displaySize, makeThumbnail } from '../uploads/image'
import { seesChatFiles } from './chat-files-access'

/** An upload not sent in a message within a day is removed (as a room's). */
export const UNSENT_CHAT_FILE_MS = 24 * 3600_000
/** A file on disk without its row is removed after this long (a create puts the file before its row). */
const ORPHAN_MS = 3600_000
const THUMB_EXTS = ['png', 'jpg'] as const

export interface ChatFileRow {
  id: string; chat_id: string; user_id: string; name: string; size: number; mime: string; kind: Attachment['kind']
  width: number | null; height: number | null; sha256: string; thumb: string | null; copied_from: string | null; created_at: string
}

/** The attachment a message carries for a chat file: no team path (it is in no folder), source 'chat'. */
export const chatFileAttachment = (r: ChatFileRow): Attachment => ({
  id: r.id, name: r.name, path: '', size: r.size, mime: r.mime, kind: r.kind, source: 'chat',
  ...(r.width ? { width: r.width } : {}), ...(r.height ? { height: r.height } : {}),
})

const services = new WeakMap<AppContext, ChatFiles>()

export class ChatFiles {
  constructor(readonly ctx: AppContext) {}
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
    return !!this.ctx.db.query('SELECT 1 FROM messages WHERE chat_id = ? AND instr(attachments, ?) > 0 LIMIT 1').get(f.chat_id, f.id)
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
    const id = newId()
    fs.mkdirSync(this.dir(chatId), { recursive: true, mode: 0o700 })
    const dst = this.abs({ chat_id: chatId, id })
    try { fs.renameSync(src, dst) } catch { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }) }
    fs.chmodSync(dst, 0o600)
    const row = await this.record(userId, chatId, id, clean, dst, sha256, null)
    audit(this.ctx.db, { actor: userId, action: 'chat.file_add', target: chatId, detail: { size: row.size, kind: row.kind } })
    return chatFileAttachment(row)
  }

  /** The row of a file just put at `dst` (its preview made first). */
  private async record(userId: string, chatId: string, id: string, name: string, dst: string, sha256: string, copiedFrom: string | null, thumbFrom?: string | null): Promise<ChatFileRow> {
    const kind = attachmentKind(name)
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

  /**
   * The first share of a private chat (chat/people-share.ts): the creator's computer uploads in its messages (in their
   * users/<id>/.attachments/, which only they may read) are copied here and every message that carries one points to the
   * copy, so everyone in the chat sees them. An upload whose file is gone or unreadable stays as it was (its sender's
   * alone, as before). The originals stay where they are. Audited (chat.files_copied: how many). Returns how many.
   */
  async copyEarlier(chatId: string): Promise<number> {
    const db = this.ctx.db
    const chat = db.query('SELECT user_id FROM chats WHERE id = ?').get(chatId) as { user_id: string } | null
    if (!chat) return 0
    const msgs = db.query("SELECT id, author_id, attachments FROM messages WHERE chat_id = ? AND role = 'user' AND attachments IS NOT NULL AND attachments <> '[]'").all(chatId) as { id: string; author_id: string | null; attachments: string }[]
    const copies = new Map<string, Attachment | null>()
    const rules = this.ctx.files.rules()
    const copyOne = async (a: Attachment): Promise<Attachment | null> => {
      const att = db.query('SELECT id, user_id, chat_id, path, name, thumb_path, sha256 FROM attachments WHERE id = ? AND chat_id = ?').get(a.id, chatId) as { id: string; user_id: string; chat_id: string; path: string; name: string; thumb_path: string | null; sha256: string | null } | null
      if (!att) return null
      const who = loadPrincipal(db, att.user_id)
      if (!who) return null
      const id = newId()
      try {
        // the file as its sender may read it now (moved or deleted on the Files screen: left as it was)
        const src = authorize(this.ctx.files.fx, rules, who, att.path, 'read')
        fs.mkdirSync(this.dir(chatId), { recursive: true, mode: 0o700 })
        const dst = this.abs({ chat_id: chatId, id })
        // read through one descriptor opened without following links (a link put in its place is refused), never by
        // path again
        const { fd, st } = openChecked(src.abs)
        try {
          const out = fs.openSync(dst, 'wx', 0o600)
          try {
            const buf = Buffer.allocUnsafe(1024 * 1024)
            for (let pos = 0; ;) {
              const n = fs.readSync(fd, buf, 0, buf.length, pos)
              if (!n) break
              fs.writeSync(out, buf, 0, n)
              pos += n
            }
          } finally { fs.closeSync(out) }
        } finally { fs.closeSync(fd) }
        if (fs.statSync(dst).size !== st.size) throw new Error('changed while copied')
        // only the bytes that were attached: a file edited or replaced on the Files screen since stays its sender's
        const sha = await hashFile(dst)
        if (att.sha256 && sha !== att.sha256) throw new Error('changed since it was attached')
        const thumbFrom = att.thumb_path ? path.join(this.ctx.config.dataDir, ...att.thumb_path.split('/')) : null
        return chatFileAttachment(await this.record(att.user_id, chatId, id, att.name, dst, sha, att.id, thumbFrom))
      } catch (e) {
        this.removeFiles({ chat_id: chatId, id })
        this.ctx.log.debug('an earlier upload was not copied to the chat', { err: e })
        return null
      }
    }
    let n = 0
    for (const m of msgs) {
      let atts: Attachment[] = []
      try { const v = JSON.parse(m.attachments); if (Array.isArray(v)) atts = v } catch { continue }
      let changed = false
      const next: Attachment[] = []
      for (const a of atts) {
        if (a.source === 'team' || a.source === 'chat') { next.push(a); continue }
        if (!copies.has(a.id)) { const c = await copyOne(a); copies.set(a.id, c); if (c) n++ }
        const c = copies.get(a.id)
        if (c) changed = true
        next.push(c ?? a)
      }
      // the message as it is now (nothing else rewrites a question's attachments)
      if (changed) db.query('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify(next), m.id)
    }
    if (n) audit(db, { actor: chat.user_id, action: 'chat.files_copied', target: chatId, detail: { files: n } })
    return n
  }

  /** The chat was deleted for good: its folder goes (its rows went with it). */
  removeChat(chatId: string) {
    this.ctx.db.query('DELETE FROM chat_files WHERE chat_id = ?').run(chatId)
    fs.rmSync(this.dir(chatId), { recursive: true, force: true })
  }

  /** Uploads never sent (a day old), the folders of chats that are gone, and files without a row (an hour old). */
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
    let chats: string[] = []
    try { chats = fs.readdirSync(this.root()) } catch { return n }
    for (const c of chats) {
      const dir = this.dir(c)
      if (!this.ctx.db.query('SELECT 1 FROM chats WHERE id = ?').get(c)) { fs.rmSync(dir, { recursive: true, force: true }); n++; continue }
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const name of names) {
        const id = name.replace(/\.thumb\.(jpg|png)$/, '')
        if (this.ctx.db.query('SELECT 1 FROM chat_files WHERE id = ? AND chat_id = ?').get(id, c)) continue
        try { if (now - fs.statSync(path.join(dir, name)).mtimeMs < ORPHAN_MS) continue } catch { continue }
        fs.rmSync(path.join(dir, name), { force: true })
        n++
      }
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
