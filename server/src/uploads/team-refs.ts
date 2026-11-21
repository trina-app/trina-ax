// Team files attached to a chat (the composer's "Add from team files", design tab 4 "첨부" extended): a reference, not
// a copy. The row remembers which file was meant — its path, inode and content hash when it was attached — and the
// file is looked up again every time it is shown, sent or given to the AI:
//   - moves and renames on the file screen are followed from file_events (delete {movedTo} / create {movedFrom}, also
//     of a folder above it), a trashed-then-restored file from its trash id, and a rename in the same folder that
//     left no event (the Mac's Finder) by inode. The events are read in batches until none are left, and how far the
//     log was read is remembered (also for a file that is gone), so a lookup only reads the events since the last one;
//   - the person's read access is checked with today's rules through the one permission function each time
//     (authorize + visiblePath, the file screen's own test). Whatever fails — deleted, moved where they cannot read,
//     access taken away, a server folder, someone else's users/<id>/, an odd path — looks the same: "unavailable",
//     with the name, path and size blanked, and the create endpoint answers the same 404 as for a missing file.
// Reads (message history, realtime copies) keep what they learn about a reference's place in memory only; the
// database row is moved forward by sends and turns (POST paths) and when a content hash is computed. The following
// itself is uploads/ref-follow.ts, which a project room's files use too (rooms/file-refs.ts).
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { Attachment } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import type { AppContext } from '../context'
import { newId } from '../db'
import { ext } from '../files/extract'
import { HttpError } from '../http/errors'
import type { Principal } from '../policy/access'
import { authorize, visiblePath } from '../policy/authorize'
import { fileError } from '../team-files/errors'
import { openChecked } from '../team-files/place'
import { mimeOf, type TeamFiles } from '../team-files/service'
import { attachmentKind } from './attachments'
import { visibleSharedChat } from '../chat/shared'
import { otherRefTo, RefFollower } from './ref-follow'

interface RefRow {
  id: string; user_id: string; chat_id: string; path: string; path_at_attach: string; name: string; size: number; mime: string
  kind: Attachment['kind']; sha256: string; mtime_ms: number; ino: number | null; dev: number | null; event_id: number
  trash_id: string | null; trash_suffix: string | null; lost: number
  cur_sha256: string | null; cur_size: number | null; cur_mtime_ms: number | null; cur_ino: number | null
}
const COLS = 'id, user_id, chat_id, path, path_at_attach, name, size, mime, kind, sha256, mtime_ms, ino, dev, event_id, trash_id, trash_suffix, lost, cur_sha256, cur_size, cur_mtime_ms, cur_ino'

/** new references one person may make in RATE_WINDOW_MS (attaching re-reads and hashes the file) */
export const ATTACH_RATE_MAX = 120
const RATE_WINDOW_MS = 10 * 60_000
/** references one chat may hold (each message takes at most 20 attachments) */
export const CHAT_REFS_MAX = 500
/** references never sent in a message are removed after this long */
const UNSENT_TTL_MS = 7 * 24 * 3600_000

/** Where a reference points now, for one person. `moved`: its path differs from the one attached; `changed`: its
 * content differs — by hash when one was computed for this version, else by size and modification time. */
export type RefState =
  | { state: 'ok'; row: RefRow; rel: string; abs: string; st: fs.Stats; moved: boolean; changed: boolean }
  | { state: 'unavailable'; row: RefRow | null }

/** What a person who may not (or no longer) read the file sees of the reference: nothing about the file. */
export const unavailableAttachment = (id: string): Attachment => ({ id, name: '', path: '', size: 0, mime: 'application/octet-stream', kind: 'other', source: 'team', unavailable: true })

/** sha256 of the file at `abs`, read through one descriptor opened without following links, which must be the very
 * file `expect` was checked as (same inode on the same device): a file swapped for a link or another file between
 * the permission check and the read is refused instead of hashed. */
export async function hashChecked(abs: string, expect: fs.Stats): Promise<string> {
  const { fd, st } = openChecked(abs, expect)
  try {
    if (st.ino !== expect.ino || st.dev !== expect.dev) throw new Error('file changed between check and read')
    const h = crypto.createHash('sha256')
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    let pos = 0
    for (;;) {
      const n = await new Promise<number>((res, rej) => fs.read(fd, buf, 0, buf.length, pos, (err, n) => (err ? rej(err) : res(n))))
      if (!n) break
      h.update(buf.subarray(0, n))
      pos += n
    }
    return h.digest('hex')
  } finally { fs.closeSync(fd) }
}

export class TeamFileRefs {
  private follower: RefFollower
  constructor(private ctx: AppContext, private files: TeamFiles) {
    this.follower = new RefFollower(ctx.db, () => files.root, 'team_file_refs', 'id')
  }

  private row(id: string): RefRow | null { return this.ctx.db.query(`SELECT ${COLS} FROM team_file_refs WHERE id = ?`).get(id) as RefRow | null }
  private lastEvent(): number { return this.follower.lastEvent() }
  isRef(id: string): boolean { return !!this.ctx.db.query('SELECT 1 FROM team_file_refs WHERE id = ?').get(id) }

  /** The limits on new references (attaching re-reads and hashes the file, so a script must not be able to make the
   * server do it without end): 429 when this person made too many lately or the chat holds too many. Checked by create,
   * and before a computer upload into a shared chat puts anything in the project folder (uploads/shared-chat.ts). */
  assertRoom(userId: string, chatId: string) {
    const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString()
    const recent = (this.ctx.db.query('SELECT COUNT(*) AS n FROM team_file_refs WHERE user_id = ? AND created_at > ?').get(userId, since) as { n: number }).n
    if (recent >= ATTACH_RATE_MAX) throw new HttpError('rate_limited', undefined, { retryAfter: 60 })
    const inChat = (this.ctx.db.query('SELECT COUNT(*) AS n FROM team_file_refs WHERE chat_id = ?').get(chatId) as { n: number }).n
    if (inChat >= CHAT_REFS_MAX) throw new HttpError('rate_limited')
  }

  /**
   * Attach `input` (a team-relative path) to the caller's own chat. Every way of not being allowed — no read access,
   * missing, a folder, .system/, another person's users/<id>/, a link, a look-alike path — is the same 404. The same
   * unchanged file attached again to the same chat gives back the reference it already has (no new row, no hashing).
   * `id`: the new reference's id, named beforehand (a computer upload in a shared chat records it in its upload event:
   * always a new reference then). `known`: that upload's checked hash, for the file with this inode, device and size
   * (it is not read again).
   */
  async create(userId: string, chatId: string, input: string, o: { id?: string; known?: { sha256: string; ino: number; dev: number; size: number } } = {}): Promise<Attachment> {
    // the caller's own chat, or a shared project chat they see (its people continue it with team files: chat/shared.ts)
    const own = this.ctx.db.query('SELECT id FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND shared_at IS NULL').get(chatId, userId)
      ?? visibleSharedChat(this.ctx.db, this.ctx.files, userId, chatId)
    if (!own) fileError('not_found', 'notChat')
    let rel: string, abs: string, st: fs.Stats
    try {
      const user = this.files.principal(userId)
      const rules = this.files.rules()
      const r = authorize(this.files.fx, rules, user, input, 'read')
      const seen = visiblePath(this.files.fx, rules, user, r.rel)
      if (!seen) throw new Error('not visible')
      rel = r.rel; abs = r.abs; st = seen
    } catch { throw new HttpError('not_found') }
    const mtime = Math.floor(st.mtimeMs)
    const same = o.id ? null : this.ctx.db.query(`SELECT ${COLS} FROM team_file_refs WHERE user_id = ? AND chat_id = ? AND path = ? AND path_at_attach = ? AND ino = ? AND dev = ? AND size = ? AND mtime_ms = ? AND trash_id IS NULL AND lost = 0 ORDER BY created_at DESC LIMIT 1`)
      .get(userId, chatId, rel, rel, st.ino, st.dev, st.size, mtime) as RefRow | null
    if (same) return this.toAttachment(same, rel, st, false, false)
    this.assertRoom(userId, chatId)
    // the hash of this very version may be known already (attached before, or hashed for a turn)
    const known = this.ctx.db.query(`SELECT sha256 FROM team_file_refs WHERE user_id = ? AND path_at_attach = ? AND ino = ? AND dev = ? AND size = ? AND mtime_ms = ?
      UNION ALL SELECT cur_sha256 FROM team_file_refs WHERE user_id = ? AND path = ? AND cur_ino = ? AND dev = ? AND cur_size = ? AND cur_mtime_ms = ? AND cur_sha256 IS NOT NULL LIMIT 1`)
      .get(userId, rel, st.ino, st.dev, st.size, mtime, userId, rel, st.ino, st.dev, st.size, mtime) as { sha256: string } | null
    const placed = o.known && st.ino === o.known.ino && st.dev === o.known.dev && st.size === o.known.size ? o.known.sha256 : null
    let sha: string
    try { sha = known?.sha256 ?? placed ?? await hashChecked(abs, st) } catch { throw new HttpError('not_found') }
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const id = o.id ?? newId()
    this.ctx.db.query(`INSERT INTO team_file_refs (id, user_id, chat_id, path, path_at_attach, name, size, mime, kind, sha256, mtime_ms, ino, dev, event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, userId, chatId, rel, rel, name, st.size, mimeOf(name) ?? 'application/octet-stream', attachmentKind(name), sha, mtime, st.ino, st.dev, this.lastEvent())
    // like a read by the AI, attaching a team file is in the audit list (users/<id>/… is shown only to its person)
    try { audit(this.ctx.db, { actor: userId, action: 'file.attach', target: rel, detail: { size: st.size } }) } catch (e) { this.ctx.log.warn('attach audit failed', { err: e }) }
    return { id, name, path: rel, size: st.size, mime: mimeOf(name) ?? 'application/octet-stream', kind: attachmentKind(name), source: 'team', sha256: sha }
  }

  /**
   * For a send or a turn: find the reference again for `userId` (only their own) and check they may read it now.
   * When size or modification time differ from the attached version, the content hash decides whether it changed
   * (computed once per version, through the checked descriptor, and remembered). The row's place is saved.
   */
  async locate(userId: string, id: string): Promise<RefState> {
    const s = this.locateSync(userId, id, true)
    if (s.state !== 'ok' || !s.changed || this.knownHash(s.row, s.st) !== null) return s
    let sha: string
    try { sha = await hashChecked(s.abs, s.st) } catch { return { state: 'unavailable', row: s.row } }
    this.ctx.db.query('UPDATE team_file_refs SET cur_sha256 = ?, cur_size = ?, cur_mtime_ms = ?, cur_ino = ? WHERE id = ?').run(sha, s.st.size, Math.floor(s.st.mtimeMs), s.st.ino, s.row.id)
    Object.assign(s.row, { cur_sha256: sha, cur_size: s.st.size, cur_mtime_ms: Math.floor(s.st.mtimeMs), cur_ino: s.st.ino })
    return { ...s, changed: sha !== s.row.sha256 }
  }

  /** the content hash of the version `st` describes, when it is known without reading the file */
  private knownHash(row: RefRow, st: fs.Stats): string | null {
    const mtime = Math.floor(st.mtimeMs)
    if (st.size === row.size && mtime === row.mtime_ms) return row.sha256
    if (row.cur_sha256 && st.size === row.cur_size && mtime === row.cur_mtime_ms && st.ino === row.cur_ino) return row.cur_sha256
    return null
  }

  /** `persist`: save where the reference was found (POST paths); reads keep it in memory only. `anyOwner`: a reference
   * someone else made in a shared chat, checked against this person's access (viewAs, thumbnail). */
  locateSync(userId: string, id: string, persist = false, anyOwner = false): RefState {
    const row = this.row(id)
    if (!row || (row.user_id !== userId && !anyOwner)) return { state: 'unavailable', row: null }
    let user: Principal
    try { user = this.files.principal(userId) } catch { return { state: 'unavailable', row } }
    const rel = this.follow(row, persist)
    if (rel === null) return { state: 'unavailable', row }
    try {
      const rules = this.files.rules()
      const r = authorize(this.files.fx, rules, user, rel, 'read')
      const st = visiblePath(this.files.fx, rules, user, r.rel)
      if (!st) return { state: 'unavailable', row }
      const known = this.knownHash(row, st)
      return { state: 'ok', row, rel: r.rel, abs: r.abs, st, moved: r.rel !== row.path_at_attach, changed: known === null || known !== row.sha256 }
    } catch { return { state: 'unavailable', row } }
  }

  /** The current path of the referenced file, or null when it is gone (trashed, deleted, moved without a trace). */
  private follow(row: RefRow, persist: boolean): string | null { return this.follower.follow(row.id, row, persist).found }

  private toAttachment(row: RefRow, rel: string, st: fs.Stats, moved: boolean, changed: boolean): Attachment {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    return {
      id: row.id, name, path: rel, size: st.size, mime: mimeOf(name) ?? 'application/octet-stream', kind: attachmentKind(name), source: 'team',
      sha256: row.sha256, ...(moved ? { moved: true } : {}), ...(changed ? { changed: true } : {}),
    }
  }

  /** The reference as `userId` may see it now (message history, realtime events). Read-only. */
  view(userId: string, a: Pick<Attachment, 'id'>): Attachment {
    const s = this.locateSync(userId, a.id)
    return s.state === 'ok' ? this.toAttachment(s.row, s.rel, s.st, s.moved, s.changed) : unavailableAttachment(a.id)
  }

  /** A reference in a message of a shared project chat as `viewer` may see it now, whoever attached it: the file
   * followed like any reference, then checked against the viewer's own access (its name only; its content reaches the
   * AI only through a read, chat/turn.ts confirmSharedRead). Only for a chat the viewer sees. */
  viewAs(viewer: string, a: Pick<Attachment, 'id'>): Attachment {
    const row = this.row(a.id)
    if (!row || (row.user_id !== viewer && !visibleSharedChat(this.ctx.db, this.ctx.files, viewer, row.chat_id))) return unavailableAttachment(a.id)
    const s = this.locateSync(viewer, a.id, false, true)
    return s.state === 'ok' ? this.toAttachment(s.row, s.rel, s.st, s.moved, s.changed) : unavailableAttachment(a.id)
  }

  /** For a turn: like view(), with `changed` decided by the content hash; the place found is saved. */
  async check(userId: string, a: Pick<Attachment, 'id'>): Promise<Attachment> {
    const s = await this.locate(userId, a.id)
    return s.state === 'ok' ? this.toAttachment(s.row, s.rel, s.st, s.moved, s.changed) : unavailableAttachment(a.id)
  }

  /** The caller's own references of this chat (send / edit), as they are now, split into readable ones and the ones
   * that are not (any more): only the person's own ids of this chat are reported either way. */
  byIds(userId: string, chatId: string, ids: string[]): { found: Map<string, Attachment>; unavailable: string[] } {
    const found = new Map<string, Attachment>()
    const unavailable: string[] = []
    if (!ids.length) return { found, unavailable }
    const rows = this.ctx.db.query(`SELECT id FROM team_file_refs WHERE user_id = ? AND chat_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(userId, chatId, ...ids) as { id: string }[]
    for (const r of rows) {
      const s = this.locateSync(userId, r.id, true)
      if (s.state === 'ok') found.set(r.id, this.toAttachment(s.row, s.rel, s.st, s.moved, s.changed))
      else unavailable.push(r.id)
    }
    return { found, unavailable }
  }

  /** An image reference for the thumbnail endpoint: the bytes of the file itself when it is a small web image the
   * caller can read, read through one descriptor that is checked to be the file the permission check saw. */
  thumbnail(userId: string, id: string): { bytes: Buffer; name: string; mime: string; etag: string } {
    // a reference someone else made in a shared chat the caller sees: their own access to the file decides
    const row = this.row(id)
    const other = !!row && row.user_id !== userId && !!visibleSharedChat(this.ctx.db, this.ctx.files, userId, row.chat_id)
    const s = this.locateSync(userId, id, false, other)
    if (s.state !== 'ok' || !/^(png|jpe?g|gif|webp)$/.test(ext(s.rel)) || s.st.size > 2 * 1024 * 1024) throw new HttpError('not_found')
    let opened: { fd: number; st: fs.Stats }
    try { opened = openChecked(s.abs, s.st) } catch { throw new HttpError('not_found') }
    try {
      if (opened.st.ino !== s.st.ino || opened.st.dev !== s.st.dev || opened.st.size > 2 * 1024 * 1024) throw new HttpError('not_found')
      const bytes = Buffer.alloc(opened.st.size)
      let pos = 0
      while (pos < bytes.length) {
        const n = fs.readSync(opened.fd, bytes, pos, bytes.length - pos, pos)
        if (!n) break
        pos += n
      }
      const name = s.rel.slice(s.rel.lastIndexOf('/') + 1)
      return { bytes: bytes.subarray(0, pos), name, mime: mimeOf(name) ?? 'application/octet-stream', etag: `${opened.st.ino.toString(36)}-${pos.toString(36)}-${Math.floor(opened.st.mtimeMs).toString(36)}` }
    } finally { fs.closeSync(opened.fd) }
  }

  /**
   * A chip taken out of the box before its message went (DELETE /api/attachments/:id): the person's own reference of a
   * chat goes. When it is the file they uploaded from their computer into that shared chat (its upload event names this
   * reference: uploads/shared-chat.ts), not sent in any message, and still the very file put there (the same place, the
   * same inode, unchanged), the file goes to the team trash like a delete on the Files screen (restorable from Files >
   * Trash until it is purged): `trashed`. Anything else stays where it is: a team file picked from the folder, one moved,
   * renamed or edited since, one in a message, one another reference also points to. Someone else's reference, or none:
   * 404.
   */
  discard(userId: string, id: string): { trashed: boolean } {
    const row = this.row(id)
    if (!row || row.user_id !== userId) throw new HttpError('not_found')
    if (this.ctx.db.query('SELECT 1 FROM messages WHERE chat_id = ? AND instr(attachments, ?) > 0 LIMIT 1').get(row.chat_id, id)) return { trashed: false }
    const uploaded = this.ctx.db.query("SELECT 1 FROM file_events WHERE path = ? AND user_id = ? AND action = 'upload' AND json_extract(detail, '$.attachment') = ? AND json_extract(detail, '$.chatId') = ? LIMIT 1")
      .get(row.path_at_attach, userId, id, row.chat_id)
    // another reference to the very file (someone attached it from the folder meanwhile, this person in another chat,
    // or a project room shows it: room_file_refs) keeps it where it is
    const shared = otherRefTo(this.ctx.db, { table: 'team_file_refs', id }, row)
    let trashed = false
    if (uploaded && !shared) {
      const s = this.locateSync(userId, id, true)
      if (s.state === 'ok' && !s.moved && !s.changed && s.st.ino === row.ino && s.st.dev === row.dev) {
        try { this.files.remove(userId, s.rel); trashed = true } catch (e) { this.ctx.log.warn('a removed chip\'s upload could not go to the trash', { err: e }) }
      }
    }
    this.ctx.db.query('DELETE FROM team_file_refs WHERE id = ?').run(id)
    this.follower.forget(id)
    return { trashed }
  }

  /** References never sent in a message, older than a week (the composer was closed without sending). */
  sweep(now = Date.now()): number {
    const before = new Date(now - UNSENT_TTL_MS).toISOString()
    const gone = this.ctx.db.query(`SELECT r.id FROM team_file_refs r WHERE r.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = r.chat_id AND instr(m.attachments, r.id) > 0)`).all(before) as { id: string }[]
    const del = this.ctx.db.query('DELETE FROM team_file_refs WHERE id = ?')
    for (const g of gone) { del.run(g.id); this.follower.forget(g.id) }
    return gone.length
  }
}
