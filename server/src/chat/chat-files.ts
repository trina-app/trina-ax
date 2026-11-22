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
import { CHAT_FILE_AI_MAX, SMALL_UPLOAD_MAX, type Attachment, type ChatFileVersion } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { ext } from '../files/extract'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { authorize } from '../policy/authorize'
import { loadPrincipal } from '../policy/access'
import { badSegment } from '../policy/names'
import { checkRegular, openChecked } from '../team-files/place'
import { mimeOf } from '../team-files/service'
import { attachmentKind } from '../uploads/attachments'
import { displaySize, makeThumbnail } from '../uploads/image'
import { cleanImage, imageFormat, PHOTO, plainPicture } from '../uploads/metadata'
import { assertStorageRoom, assertStorageRoomForAI } from '../system/storage'
import { turnWriteLimits } from '../files/turn-write-limits'
import { writeLimitText } from '../policy/refusal'
import { ToolError } from '../policy/errors'
import { fileError } from '../team-files/errors'
import { safeOpsEnabled } from '../safe-ops/runner'
import { personLocale } from '../files/media-text'
import { tr } from './i18n'
import { seesChatFiles } from './chat-files-access'
import { answerRecord, withheldFrom } from './shared-answers'

/** An upload not sent in a message within a day is removed (as a room's). */
export const UNSENT_CHAT_FILE_MS = 24 * 3600_000
/** A file on disk without its row is set aside after this long (a create puts the file before its row) */
const ORPHAN_MS = 3600_000
/** Set-aside files (chat-files-orphans/) are kept this long, as room files' (a database restored from an older backup) */
export const CHAT_FILE_ORPHAN_KEEP_MS = 30 * 86400_000
/** At most this big in a chat shared with people (the multipart attachment limit; a chunked upload too) */
export const CHAT_FILE_MAX = SMALL_UPLOAD_MAX
/** The rows a chain keeps (putVersion): the root (the chain's id, which messages carry) and the newest versions, at
 * most this many in all; the head is never pruned */
export const CHAT_FILE_VERSIONS_KEPT = 20
const THUMB_EXTS = ['png', 'jpg'] as const

/**
 * A chat file's row. Versions (migration 432, putVersion): root_id is the chain's first file (NULL on the root, whose id
 * is the chain's id: messages, links and the AI's file_id name it), replaces the head a version was written over,
 * version its number in the chain (NULL = 1, a root), origin 'ai' for a version the AI wrote.
 */
export interface ChatFileRow {
  id: string; chat_id: string; user_id: string; name: string; size: number; mime: string; kind: Attachment['kind']
  width: number | null; height: number | null; sha256: string; thumb: string | null; copied_from: string | null; created_at: string
  root_id?: string | null; replaces?: string | null; version?: number | null; origin?: string | null
}

/** A chain as one person may see it (ChatFiles.visibleTo): its id (the root's), the root and the newest version */
export interface VisibleChatFile { id: string; root: ChatFileRow; head: ChatFileRow; versions: number }
/** What a version save tells its caller: the new head, the head it was written over, and `beside` when that head is not
 * the one the caller read (someone saved in between: the new one is a version beside theirs, nothing is lost) */
export interface PutVersionResult { row: ChatFileRow; replaced: ChatFileRow; beside: boolean; pruned: number[] }
/** putVersion's bytes: in memory, or a descriptor the caller opened and checked (team-files/place.ts openChecked), read
 * from offset 0 to st.size and never closed here */
export type VersionSource = { bytes: Uint8Array } | { fd: number; st: Pick<fs.Stats, 'size'> }
export interface PutVersionOptions {
  /** the AI writes it: 'ai' ("Trina for <person>"); a person's save or restore: absent */
  origin?: 'ai'
  /** a turn writes it: its write limits count it (files/turn-write-limits.ts), as for a team file. `chatVersionsMade`
   * (the AI's saves of this answer): a save over a head this same answer wrote takes that head's place (the same
   * version number) instead of adding one, so an answer that edits a file several times leaves one version and never
   * pushes people's versions out of CHAT_FILE_VERSIONS_KEPT */
  turn?: { bytesWritten: number; filesWritten: Set<string>; chatVersionsMade?: Map<string, string> }
  /** the head's id the caller read; another head now makes the result `beside` */
  expectHead?: string
  /** audit action ('chat.file_version', or 'chat.file_restore') */
  action?: string
  /** the caller's own gate (a chat shared with people or personal, not a project chat, not a k turn, the person may
   * continue the chat), called synchronously right before the row is inserted: the bytes took time, and the chat may
   * have changed meanwhile. A throw refuses the save; the written bytes are removed. */
  recheck?: () => void
}

/** A chain's id for a row (the root's file_id) */
export const chainIdOf = (f: Pick<ChatFileRow, 'id'> & { root_id?: string | null }) => f.root_id ?? f.id

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

  /** The chain id of a file id (its root's; the id itself for a root or a file that is not a chat file's) */
  private chainOf(f: Pick<ChatFileRow, 'id'> & { root_id?: string | null }): string {
    if (f.root_id !== undefined) return chainIdOf(f)
    return (this.ctx.db.query('SELECT root_id FROM chat_files WHERE id = ?').get(f.id) as { root_id: string | null } | null)?.root_id ?? f.id
  }
  /** A chain's rows, oldest first */
  chain(rootId: string): ChatFileRow[] {
    return this.ctx.db.query('SELECT * FROM chat_files WHERE id = ? OR root_id = ? ORDER BY COALESCE(version, 1), rowid').all(rootId, rootId) as ChatFileRow[]
  }
  /** A chain's newest version (the root when it has none) */
  headOf(rootId: string): ChatFileRow | null {
    return this.ctx.db.query('SELECT * FROM chat_files WHERE id = ? OR root_id = ? ORDER BY COALESCE(version, 1) DESC, rowid DESC LIMIT 1').get(rootId, rootId) as ChatFileRow | null
  }

  /** The messages of its chat that carry the file's chain (its root's id: a message never names a version) */
  private carriers(f: Pick<ChatFileRow, 'id' | 'chat_id'> & { root_id?: string | null }): string[] {
    return (this.ctx.db.query("SELECT DISTINCT m.id FROM messages m, json_each(m.attachments) j WHERE m.chat_id = ? AND json_valid(m.attachments) AND json_extract(j.value, '$.id') = ?").all(f.chat_id, this.chainOf(f)) as { id: string }[]).map((m) => m.id)
  }

  /** Was the file sent in a message of its chat (any branch)? Until then it is its sender's alone. A version counts as
   * sent when its root is: the messages carry the root. */
  sent(f: Pick<ChatFileRow, 'id' | 'chat_id'> & { root_id?: string | null }): boolean {
    return !!this.ctx.db.query("SELECT 1 FROM messages m, json_each(m.attachments) j WHERE m.chat_id = ? AND json_valid(m.attachments) AND json_extract(j.value, '$.id') = ? LIMIT 1").get(f.chat_id, this.chainOf(f))
  }

  /** Does an answer of its chat that carries the file's chain have a k group (chat/shared-answers.ts: a connection's
   * answer, hidden from people who join later and may not use that connection)? Such bytes keep that protection: they
   * are never "everyone here already has them" (chat-file-tool.ts chatFileCopyOf). By the chain (a version's id is never
   * carried). */
  kCarried(f: Pick<ChatFileRow, 'id' | 'chat_id'> & { root_id?: string | null }): boolean {
    return this.carriers(f).some((id) => (answerRecord(this.ctx.db, id)?.reads ?? []).some((g) => g.k))
  }

  /** Every message of its chat that carries the file's root is an answer hidden from `userId` (a question never is). */
  private onlyOnHidden(userId: string, f: Pick<ChatFileRow, 'id' | 'chat_id'> & { root_id?: string | null }, hidden?: () => Set<string>): boolean {
    const carriers = this.carriers(f)
    if (!carriers.length) return false
    const h = hidden ? hidden() : withheldFrom(this.ctx.db, this.ctx.files.rules(), f.chat_id, userId)
    return carriers.every((id) => h.has(id))
  }

  /** May `userId` open the chain of `root` (a root row): sent and not only on answers hidden from them, or the
   * uploader's own unsent upload (only a root's uploader: replaces IS NULL). The chat itself is the caller's check. */
  private mayOpen(userId: string, root: ChatFileRow, hidden?: () => Set<string>): boolean {
    if (root.replaces || root.root_id) return false
    if (root.user_id === userId) return true
    return this.sent(root) && !this.onlyOnHidden(userId, root, hidden)
  }

  /** The root of the chain a file id of this chat belongs to (a root's id or a version's), or null */
  private rootIn(chatId: string, fileId: string): ChatFileRow | null {
    const f = this.ctx.db.query('SELECT * FROM chat_files WHERE id = ? AND chat_id = ?').get(fileId, chatId) as ChatFileRow | null
    if (!f) return null
    if (!f.root_id) return f
    return this.ctx.db.query('SELECT * FROM chat_files WHERE id = ? AND chat_id = ? AND root_id IS NULL').get(f.root_id, chatId) as ChatFileRow | null
  }

  /**
   * The one filtered list of a chat's files for `userId` (list, grep and the name lookup; the resolver's chat:files/):
   * one entry per chain, its head, newest change first. Nothing when they do not see the chat now. A chain sent only on
   * answers hidden from them, or someone else's upload not sent yet, is not in it: such a name never shows.
   */
  visibleTo(userId: string, chatId: string): VisibleChatFile[] {
    if (!this.seesChat(userId, chatId)) return []
    const roots = this.ctx.db.query('SELECT * FROM chat_files WHERE chat_id = ? AND root_id IS NULL').all(chatId) as ChatFileRow[]
    let hidden: Set<string> | null = null
    const hiddenOnce = () => (hidden ??= withheldFrom(this.ctx.db, this.ctx.files.rules(), chatId, userId))
    const out: VisibleChatFile[] = []
    for (const root of roots) {
      if (!this.mayOpen(userId, root, hiddenOnce)) continue
      const rows = this.chain(root.id)
      out.push({ id: root.id, root, head: rows[rows.length - 1] ?? root, versions: rows.length })
    }
    return out.sort((a, b) => (a.head.created_at < b.head.created_at ? 1 : a.head.created_at > b.head.created_at ? -1 : 0))
  }

  /** A chat file `userId` may open now, by its chain id, a version's id, or (`byName`) its exact name (the newest chain
   * of that name), through visibleTo: the chain's entry (its head), or null. */
  find(userId: string, chatId: string, ref: string, byName = false): VisibleChatFile | null {
    const want = ref.trim().replace(/^file_id=/, '')
    const seen = this.visibleTo(userId, chatId)
    const byId = seen.find((v) => v.id === want) ?? (() => {
      const r = this.row(want)
      return r && r.chat_id === chatId && r.root_id ? seen.find((v) => v.id === r.root_id) : undefined
    })()
    if (byId) return byId
    if (!byName) return null
    const name = want.normalize('NFC')
    return seen.find((v) => v.head.name === name || v.root.name === name) ?? null
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

  /**
   * The AI's file for its answer in a chat shared with people (chat/work-file-tool.ts, save_work_file): `src` is a
   * server-only temp file it made (moved here, never read whole except a picture, whose metadata is cut out first as an
   * upload's), at most CHAT_FILE_AI_MAX, with room in the team's storage. `userId` is the person whose turn it is (the
   * file is theirs as an upload would be). The caller puts it into the answer's attachments at once (sent()). Audited.
   * ToolError with plain words for the AI.
   */
  async createFromAi(userId: string, chatId: string, name: string, src: string, sha256: string): Promise<Attachment> {
    const clean = name.normalize('NFC').replace(/[\u0000-\u001f]/g, '').trim()
    const bad = !clean || clean.includes('/') || clean.includes('\\') ? 'not a file name' : badSegment(clean)
    if (bad) throw new ToolError(`'${clean}' cannot be a file name here: ${bad}`, 'bad_name')
    const size = fs.statSync(src).size
    if (size > CHAT_FILE_AI_MAX) throw new ToolError(`the file is ${(size / 1024 ** 2).toFixed(0)} MB; a file attached to an answer may be at most ${CHAT_FILE_AI_MAX / 1024 ** 3} GB. Make it smaller (a lower bitrate or a shorter cut)`, 'too_large')
    assertStorageRoomForAI(size)
    let stored = sha256
    let kind = attachmentKind(clean)
    if (kind === 'image') {
      // a picture is read whole to be cleaned: at most an upload's size (a 1 GB ".png" never sits in memory)
      if (size > SMALL_UPLOAD_MAX) throw new ToolError(`this picture is ${(size / 1024 ** 2).toFixed(0)} MB; a picture attached to an answer may be at most ${SMALL_UPLOAD_MAX / 1024 ** 2} MB. Make it smaller`, 'too_large')
      // a picture: its place and camera cut out, as an upload's (a picture that cannot be cleaned is not attached)
      const pic = cleanPicture(clean, new Uint8Array(fs.readFileSync(src)), this.ctx.files.quarantine.hasHash(sha256))
      if (!pic) throw new ToolError('this picture could not be read, so it was not attached', 'unreadable')
      kind = pic.kind
      if (pic.changed) { fs.writeFileSync(src, pic.bytes); stored = createHash('sha256').update(pic.bytes).digest('hex') }
    }
    const id = newId()
    fs.mkdirSync(this.dir(chatId), { recursive: true, mode: 0o700 })
    const dst = this.abs({ chat_id: chatId, id })
    try { fs.renameSync(src, dst) } catch { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }) }
    fs.chmodSync(dst, 0o600)
    const t = new Date()
    fs.utimesSync(dst, t, t)
    const row = await this.record(userId, chatId, id, clean, dst, stored, null, kind)
    audit(this.ctx.db, { actor: userId, action: 'chat.file_add', target: chatId, detail: { size: row.size, kind: row.kind, by: 'ai' } })
    return { ...chatFileAttachment(row), origin: 'ai' }
  }

  /** A copy of a file the chat made in its creator's own folder (chat/chat-files-share.ts copyMade: its bytes read and
   * checked there), kept as a file of this chat sent by `userId`; the caller attaches it to the answer that made it. */
  async keepCopy(userId: string, chatId: string, name: string, src: { file: string } | { bytes: Uint8Array }, kind: Attachment['kind']): Promise<ChatFileRow> {
    const id = newId()
    await fs.promises.mkdir(this.dir(chatId), { recursive: true, mode: 0o700 })
    const dst = this.abs({ chat_id: chatId, id })
    try {
      let sha: string
      if ('bytes' in src) {
        await fs.promises.writeFile(dst, src.bytes, { flag: 'wx', mode: 0o600 })
        sha = createHash('sha256').update(src.bytes).digest('hex')
      } else {
        // a checked temp file (up to the copy cap): moved into place, hashed by streaming
        try { await fs.promises.rename(src.file, dst) } catch { await fs.promises.copyFile(src.file, dst, fs.constants.COPYFILE_EXCL) }
        await fs.promises.chmod(dst, 0o600)
        const t = new Date()
        await fs.promises.utimes(dst, t, t)
        const h = createHash('sha256')
        for await (const chunk of fs.createReadStream(dst)) h.update(chunk as Buffer)
        sha = h.digest('hex')
      }
      return await this.record(userId, chatId, id, name, dst, sha, null, kind)
    } catch (e) { this.removeFiles({ chat_id: chatId, id }); throw e }
  }

  /** The row of a file just put at `dst` (its preview made first). */
  private async record(userId: string, chatId: string, id: string, name: string, dst: string, sha256: string, copiedFrom: string | null, kind: Attachment['kind'], thumbFrom?: string | null, chain?: { rootId: string; origin: 'ai' | null; check: () => void; coalesce?: string; coalesced?: ChatFileRow; made?: Map<string, string> }): Promise<ChatFileRow> {
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
    // a version: over the head as it is now (looked up in the same synchronous step as the insert), the next number
    // and the writer may still write it (checked again here: the bytes and the preview took time)
    chain?.check()
    const head = chain ? this.headOf(chain.rootId) : null
    if (chain && !head) throw new Error('the chain is gone')
    // one version per answer: the head is still the version this same answer (the AI, for this person) wrote, so the new
    // row takes its place, with its number and the head it replaced; anyone's save in between made another head, and
    // then this is a new version as always. A new row id, so a person's editor opened on the old one saves `beside`.
    const over = chain?.coalesce && head && head.id === chain.coalesce && head.root_id && head.origin === 'ai' && head.user_id === userId ? head : null
    const insert = () => this.ctx.db.query(`INSERT INTO chat_files (id, chat_id, user_id, name, size, mime, kind, width, height, sha256, thumb, copied_from, created_at, root_id, replaces, version, origin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, chatId, userId, name, size, mimeOf(name) ?? 'application/octet-stream', kind, dims?.width ?? null, dims?.height ?? null, sha256, thumb, copiedFrom, nowIso(),
      chain?.rootId ?? null, over ? over.replaces ?? null : head?.id ?? null, over ? over.version ?? null : head ? (head.version ?? 1) + 1 : null, chain?.origin ?? null)
    if (over) {
      this.ctx.db.transaction(() => {
        this.ctx.db.query('DELETE FROM chat_files WHERE id = ? AND root_id = ?').run(over.id, over.root_id!)
        insert()
      })()
      chain!.coalesced = over
    } else insert()
    // in the same step as the insert: the answer's next save knows this head
    chain?.made?.set(chain.rootId, id)
    // the replaced head's bytes: the new row is in, so a failure here only leaves a file for the sweep to set aside
    if (over) { try { this.removeFiles(over) } catch (e) { this.ctx.log.warn('chat file version: old bytes not removed', { err: e }) } }
    return this.row(id)!
  }

  /** The caller's own files of this chat among `ids` (sending or editing a message of theirs), by id. */
  ownByIds(userId: string, chatId: string, ids: readonly string[]): Map<string, Attachment> {
    if (!ids.length) return new Map()
    // roots only: a message carries a chain by its root's id, never a version's
    const rows = this.ctx.db.query(`SELECT * FROM chat_files WHERE chat_id = ? AND user_id = ? AND root_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`).all(chatId, userId, ...ids) as ChatFileRow[]
    return new Map(rows.map((r) => [r.id, chatFileAttachment(r)]))
  }

  /**
   * The file for `userId`, who sees its chat (the caller checked the chat: chatFor 'view', or seesChat): of that chat,
   * and sent in a message or their own upload not sent yet; else 404, the same as a missing one. thumb: the small
   * preview (or the picture itself when it is a small web image). quarantined: its bytes are on the team's
   * download-only list (the route then sends it only as a download).
   */
  open(userId: string, chatId: string, fileId: string, thumb: boolean, opts: { version?: number } = {}): { abs: string; name: string; quarantined: boolean; sha256: string; row: ChatFileRow; root: ChatFileRow } {
    // any id of a chain (its root's, a version's) opens the chain, checked on its root: the messages carry the root
    const root = this.rootIn(chatId, fileId)
    if (!root) return fail('not_found')
    // not sent: its sender's alone (the root's uploader only, never a version's writer). A file carried only by answers
    // hidden from this person (chat/shared-answers.ts: a copy of a file such an answer made,
    // docs/decisions/20261121-share-chat-files.md): not theirs to open, as the answer is not (review M1)
    if (!this.mayOpen(userId, root)) fail('not_found')
    // the newest version, or the one asked for
    const f = opts.version === undefined ? this.headOf(root.id) : this.chain(root.id).find((r) => (r.version ?? 1) === opts.version) ?? null
    if (!f) return fail('not_found')
    const quarantined = this.ctx.files.quarantine.hasHash(f.sha256)
    if (thumb) {
      if (f.thumb === 'jpg' || f.thumb === 'png') {
        const t = `${this.thumbBase(f)}.${f.thumb}`
        try { checkRegular(t); return { abs: t, name: `${f.name}.${f.thumb}`, quarantined, sha256: f.sha256, row: f, root } } catch { /* the original below */ }
      }
      if (quarantined || f.kind !== 'image' || !/^(png|jpe?g|gif|webp)$/.test(ext(f.name)) || f.size > 2 * 1024 * 1024) fail('not_found')
    }
    const abs = this.abs(f)
    try { checkRegular(abs) } catch { fail('not_found') }
    return { abs, name: f.name, quarantined, sha256: f.sha256, row: f, root }
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
    if (!f || f.root_id || f.user_id !== userId || this.sent(f)) return false
    this.removeChain(f)
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
    if (!src.st?.isFile() || src.st.nlink > 1) throw new Error('not a plain file')
    // the very file the check saw (team-files/place.ts openChecked), read from that one descriptor
    const { fd, st } = openChecked(src.abs, src.st)
    let bytes: Uint8Array
    let key = ''
    try {
      if (st.size > CHAT_FILE_MAX) throw new Error('too large')
      assertStorageRoom(st.size)
      key = earlierKey({ abs: src.abs, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }, att)
      // known not to go in this very state: not read again
      if (this.earlier.get(key) === false) throw new Error('known not to be copied')
      const buf = Buffer.alloc(st.size)
      let off = 0
      while (off < buf.length) {
        const n = await new Promise<number>((res, rej) => fs.read(fd, buf, off, buf.length - off, off, (err, k) => (err ? rej(err) : res(k))))
        if (!n) break
        off += n
      }
      if (off !== st.size) throw new Error('changed while read')
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } finally { fs.closeSync(fd) }
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

  /** A root and its versions go (rows and bytes): an upload never sent, swept or discarded. How many rows went. */
  private removeChain(root: Pick<ChatFileRow, 'id' | 'chat_id'>): number {
    const rows = this.ctx.db.query('SELECT id, chat_id FROM chat_files WHERE id = ? OR root_id = ?').all(root.id, root.id) as Pick<ChatFileRow, 'id' | 'chat_id'>[]
    this.ctx.db.query('DELETE FROM chat_files WHERE id = ? OR root_id = ?').run(root.id, root.id)
    for (const r of rows) this.removeFiles(r)
    return rows.length
  }

  /**
   * A new version of a chat file: the ONLY code that writes one (the AI's write and edit on chat:files/<name>, the web's
   * save, a restore). `fileId` is any id of the chain (its root's, which messages and links carry, or a version's);
   * `userId` must see the chat and may open the chain (ChatFiles.open's rule). The bytes are streamed to the chat's
   * folder (never read in full, except a picture's, whose place and camera are cut out as for an upload), at most
   * CHAT_FILE_AI_MAX for the AI's and CHAT_FILE_MAX for a person's, counted in the team's storage
   * (assertStorageRoomForAI) and, in a turn, against its write limits. The new row replaces the head as it is at the
   * moment of the insert (one synchronous step); a head other than `expectHead` makes the result `beside`. The chain
   * then keeps CHAT_FILE_VERSIONS_KEPT rows (prune). Audited (chat.file_version: the chat, size, version, who; never
   * the name).
   */
  async putVersion(userId: string, chatId: string, fileId: string, src: VersionSource, opts: PutVersionOptions = {}): Promise<PutVersionResult> {
    return this.writeVersionOf(userId, chatId, fileId, src, opts, opts.origin === 'ai' ? CHAT_FILE_AI_MAX : CHAT_FILE_MAX)
  }

  /** May `userId` write a version in this chat now: sees it, the chat not in the trash, not read-only (safe operations
   * on: a shared chat is read-only, as for an upload), and may open the chain. The chain's root, or 404 / 409. */
  private writable(userId: string, chatId: string, fileId: string): ChatFileRow {
    if (!this.seesChat(userId, chatId)) return fail('not_found')
    if ((this.ctx.db.query('SELECT deleted_at FROM chats WHERE id = ?').get(chatId) as { deleted_at: string | null } | null)?.deleted_at) return fail('not_found')
    if (safeOpsEnabled()) fileError('conflict', 'sharedChatSafeOps', undefined, { reason: 'safe_ops' })
    return this.open(userId, chatId, fileId, false).root
  }

  private async writeVersionOf(userId: string, chatId: string, fileId: string, src: VersionSource, opts: PutVersionOptions, max: number): Promise<PutVersionResult> {
    const root = this.writable(userId, chatId, fileId)
    const size = 'bytes' in src ? src.bytes.byteLength : src.st.size
    if (size > max) fileError('payload_too_large', 'chatFileTooLarge', undefined, { reason: 'chat_file_too_large' })
    const key = `chat:files/${root.id}`
    // a turn's limits: counted at once (two writes of one turn at the same time both count), given back on a failure
    const turn = opts.turn
    let counted: { bytes: number; key: boolean } | null = null
    if (turn) {
      const lim = turnWriteLimits(this.ctx.engineConfig, this.ctx.db, userId)
      if (turn.bytesWritten + size > lim.bytes) throw new ToolError(writeLimitText('bytes', lim.bytes, root.name))
      if (!turn.filesWritten.has(key) && turn.filesWritten.size >= lim.files) throw new ToolError(writeLimitText('files', lim.files, root.name))
    }
    // the AI's (a turn's) storage refusal is words for the AI; a person's save is the HTTP storage_full
    if (opts.origin === 'ai' || turn) assertStorageRoomForAI(size)
    else assertStorageRoom(size)
    if (turn) { counted = { bytes: size, key: !turn.filesWritten.has(key) }; turn.bytesWritten += size; turn.filesWritten.add(key) }
    const id = newId()
    let inserted = false
    try {
      await fs.promises.mkdir(this.dir(chatId), { recursive: true, mode: 0o700 })
      const dst = this.abs({ chat_id: chatId, id })
      let sha = await this.writeVersion(dst, src, size)
      let kind = attachmentKind(root.name)
      if (kind === 'image') {
        const pic = cleanPicture(root.name, new Uint8Array(await fs.promises.readFile(dst)), this.ctx.files.quarantine.hasHash(sha))
        if (!pic) return fail('validation', tr('roomPhotoUnreadable', personLocale(this.ctx.db, userId)))
        kind = pic.kind
        if (pic.changed) { await fs.promises.writeFile(dst, pic.bytes); sha = createHash('sha256').update(pic.bytes).digest('hex') }
      }
      const before = this.headOf(root.id)
      const check = () => { if (this.writable(userId, chatId, root.id).id !== root.id) fail('not_found'); opts.recheck?.() }
      // the AI's save (not a restore) over the head this same answer wrote: that head's place (record)
      const made = opts.origin === 'ai' && !opts.action ? turn?.chatVersionsMade : undefined
      const chain: { rootId: string; origin: 'ai' | null; check: () => void; coalesce?: string; coalesced?: ChatFileRow; made?: Map<string, string> } = { rootId: root.id, origin: opts.origin ?? null, check, ...(made ? { made } : {}), ...(made?.has(root.id) ? { coalesce: made.get(root.id)! } : {}) }
      const row = await this.record(userId, chatId, id, root.name, dst, sha, null, kind, null, chain)
      // the row is in: from here on the version exists, so nothing below may remove its bytes or say it was not saved
      // (scenario QA review of TC-7039: a refusal must match the real state)
      inserted = true
      const replaced = (row.replaces ? this.row(row.replaces) : null) ?? before ?? root
      let pruned: number[] = []
      try { pruned = this.prune(root.id) } catch (e) { this.ctx.log.warn('chat file version: older versions not pruned', { err: e }) }
      try {
        audit(this.ctx.db, { actor: userId, action: opts.action ?? 'chat.file_version', target: chatId, detail: { size: row.size, version: row.version, ...(opts.origin ? { origin: opts.origin } : {}), ...(chain.coalesced ? { sameAnswer: true } : {}) } })
      } catch (e) { this.ctx.log.error('chat file version: audit line not written', { err: e, chat: chatId }) }
      // a save over this answer's own head is beside nothing when that head is the one the caller read
      const read = chain.coalesced ? chain.coalesced.id : replaced.id
      return { row, replaced, beside: !!opts.expectHead && opts.expectHead !== read, pruned }
    } catch (e) {
      if (!inserted) {
        this.removeFiles({ chat_id: chatId, id })
        if (turn && counted) { turn.bytesWritten -= counted.bytes; if (counted.key) turn.filesWritten.delete(key) }
      }
      throw e
    }
  }

  /** putVersion's bytes to `dst` (a new file, 0600), hashed as they go; a descriptor is read from 0 to exactly `size` */
  private async writeVersion(dst: string, src: VersionSource, size: number): Promise<string> {
    const h = createHash('sha256')
    if ('bytes' in src) {
      await fs.promises.writeFile(dst, src.bytes, { flag: 'wx', mode: 0o600 })
      return h.update(src.bytes).digest('hex')
    }
    const out = await fs.promises.open(dst, 'wx', 0o600)
    try {
      const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)))
      let off = 0
      while (off < size) {
        const n = await new Promise<number>((res, rej) => fs.read(src.fd, buf, 0, Math.min(buf.length, size - off), off, (err, k) => (err ? rej(err) : res(k))))
        if (!n) break
        h.update(buf.subarray(0, n))
        await out.write(buf, 0, n)
        off += n
      }
      if (off !== size) throw new Error('changed while read')
    } finally { await out.close() }
    return h.digest('hex')
  }

  /** A chain keeps CHAT_FILE_VERSIONS_KEPT rows: its root (the chain's id) and the newest; the head is never removed.
   * Older versions go, rows and bytes. The rest go with the chat. Their version numbers, oldest first (the restore's
   * notice says which went, QA TC-6949). */
  private prune(rootId: string): number[] {
    const rows = this.chain(rootId)
    const over = rows.length - CHAT_FILE_VERSIONS_KEPT
    if (over <= 0) return []
    const head = rows[rows.length - 1]!
    const drop = rows.filter((r) => r.id !== rootId && r.id !== head.id).slice(0, over)
    for (const r of drop) {
      this.ctx.db.query('DELETE FROM chat_files WHERE id = ? AND root_id = ?').run(r.id, rootId)
      this.removeFiles(r)
    }
    return drop.map((r) => r.version ?? 1)
  }

  /** The versions of a chain `userId` may open, oldest first (read {versions}, the web's history panel); [] when they
   * may not. No hash, no path: what a client may know. */
  versions(userId: string, chatId: string, fileId: string): ChatFileVersion[] {
    if (!this.seesChat(userId, chatId)) return []
    let root: ChatFileRow
    try { root = this.open(userId, chatId, fileId, false).root } catch { return [] }
    const rows = this.chain(root.id)
    const head = rows[rows.length - 1]
    return rows.map((r) => chatFileVersion(this.ctx.db, r, r.id === head?.id))
  }

  /** Version `n` of a chain for `userId` (read's version: n): as open, or 404 */
  openVersion(userId: string, chatId: string, fileId: string, n: number) {
    if (!this.seesChat(userId, chatId)) return fail('not_found')
    return this.open(userId, chatId, fileId, false, { version: n })
  }

  /** Restore = a new head with version `n`'s bytes (putVersion: limits, storage, pruning). Nothing is overwritten. */
  async restore(userId: string, chatId: string, fileId: string, n: number, opts: Omit<PutVersionOptions, 'action'> = {}): Promise<PutVersionResult> {
    const o = this.openVersion(userId, chatId, fileId, n)
    if (o.quarantined) fail('not_found')
    const st = checkRegular(o.abs)
    const fd = fs.openSync(o.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      if (fs.fstatSync(fd).ino !== st.ino) fail('not_found')
      // the bytes are the chain's own: a person may restore a version the AI wrote (up to CHAT_FILE_AI_MAX)
      const cap = Math.max(opts.origin === 'ai' ? CHAT_FILE_AI_MAX : CHAT_FILE_MAX, Math.min(st.size, CHAT_FILE_AI_MAX))
      return await this.writeVersionOf(userId, chatId, o.root.id, { fd, st: { size: st.size } }, { ...opts, action: 'chat.file_restore' }, cap)
    } finally { fs.closeSync(fd) }
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
    // roots only: a version is sent when its root is, and goes only with its root (or the chat)
    const old = this.ctx.db.query('SELECT id, chat_id, root_id FROM chat_files WHERE created_at < ? AND root_id IS NULL').all(cutoff) as Pick<ChatFileRow, 'id' | 'chat_id' | 'root_id'>[]
    let n = 0
    for (const f of old) {
      if (this.sent(f)) continue
      n += this.removeChain(f)
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

/** A version as a client gets it (ChatFiles.versions): never a hash, a path or where a copy came from */
export function chatFileVersion(db: AppContext['db'], r: ChatFileRow, head: boolean): ChatFileVersion {
  return {
    id: r.id, version: r.version ?? 1, name: r.name, size: r.size, mime: r.mime, createdAt: r.created_at, by: r.user_id,
    byName: (db.query('SELECT name FROM users WHERE id = ?').get(r.user_id) as { name: string } | null)?.name ?? '',
    ...(r.origin === 'ai' ? { ai: true } : {}), ...(head ? { head: true } : {}),
  }
}

export { seesChatFiles }
