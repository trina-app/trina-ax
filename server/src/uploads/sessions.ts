// Chunked uploads (tab 4 "큰 업로드"): create (target, size, sha256) -> PUT 8 MB chunks in any order, resumable
// -> complete (sha256 check, then through the policy function into place). Chunks are written straight into one
// sparse part file at their offset (<data>/uploads/<id>.part), so nothing is buffered beyond one network read and
// completing needs no assembly. While chunks arrive in order the sha256 is computed on the way, so complete only
// hashes what came out of order. An unfinished session is removed 24 hours after its last chunk (a laptop that slept
// overnight resumes where it stopped), and at the latest 7 days after it started (its part file holds disk room).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { UploadComplete, UploadSession, UploadTarget } from '@mycel/shared/api'
import { UPLOAD_CHUNK_SIZE } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { badSegment } from '../policy/names'
import { assertStorageRoom } from '../system/storage'
import { fileError } from '../team-files/errors'
import { hashFile } from '../team-files/place'
import type { TeamFiles } from '../team-files/service'
import type { Attachments } from './attachments'

/** idle expiry: every accepted chunk moves expires_at to now + this */
export const SESSION_TTL_MS = 24 * 3600_000
/** absolute cap from created_at: a trickling upload can't keep its reserved disk room forever */
export const SESSION_MAX_MS = 7 * 24 * 3600_000
export const MAX_OPEN_SESSIONS = 10
/** keep this much free disk beyond the upload itself */
export const DISK_MARGIN = 1024 * 1024 * 1024

interface Row { id: string; user_id: string; target: string; size: number; sha256: string; chunk_size: number; received: string; expires_at: string; created_at: string | null; result: string | null }

/** What happens with a finished transcribe upload (component C jobs, installed by routes/jobs.ts). `chatId`: the chat
 * the voice input is for (absent: a chat not created yet). */
export type TranscribeStarter = (userId: string, file: string, name: string, chatId?: string) => string

export class UploadSessions {
  /** running sha256 over the contiguous prefix of chunks (only kept in memory; a restart re-hashes at complete) */
  private hashes = new Map<string, { hash: crypto.Hash; next: number }>()
  /** complete() in progress: a retried complete (client timed out during the hash of a big file) joins it */
  private completing = new Map<string, Promise<UploadComplete>>()
  transcribe: TranscribeStarter | null = null
  /** refuses a transcribe upload before it starts (a confidential chat's recording that would go out) */
  transcribeCheck: ((userId: string, chatId?: string) => void) | null = null

  constructor(private ctx: AppContext, private files: TeamFiles, private attachments: Attachments) {
    fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 })
  }
  dir() { return path.join(this.ctx.config.dataDir, 'uploads') }
  part(id: string) { return path.join(this.dir(), `${id}.part`) }

  private row(userId: string, id: string): Row {
    const r = this.ctx.db.query('SELECT id, user_id, target, size, sha256, chunk_size, received, expires_at, created_at, result FROM upload_sessions WHERE id = ?').get(id) as Row | null
    if (!r || r.user_id !== userId) throw new HttpError('not_found')
    if (Date.parse(r.expires_at) < Date.now() && !r.result) {
      this.drop(id)
      // the words name the limit that ended it (QA TC-230: a 7-day upload was told "24 h" seconds after a chunk)
      const started = r.created_at ? Date.parse(r.created_at) : NaN
      fileError('gone', Number.isFinite(started) && Date.now() >= started + SESSION_MAX_MS ? 'expiredMax' : 'expired')
    }
    return r
  }
  private toApi(r: Row): UploadSession {
    return { id: r.id, target: JSON.parse(r.target), size: r.size, sha256: r.sha256, chunkSize: r.chunk_size, chunkCount: chunkCount(r.size, r.chunk_size), received: JSON.parse(r.received), expiresAt: r.expires_at }
  }

  create(userId: string, target: UploadTarget, size: number, sha256: string): UploadSession {
    const db = this.ctx.db
    const open = (db.query('SELECT COUNT(*) AS n FROM upload_sessions WHERE user_id = ? AND result IS NULL AND expires_at > ?').get(userId, new Date().toISOString()) as { n: number }).n
    if (open >= MAX_OPEN_SESSIONS) fileError('rate_limited', 'tooManySessions')
    this.checkTarget(userId, target, sha256)
    let free = Infinity
    try { const s = fs.statfsSync(this.dir()); free = s.bavail * s.bsize } catch (e) { this.ctx.log.warn('statfs failed', { err: e }) }
    // part files are sparse: what unfinished sessions will still write counts as used
    const reserved = (db.query('SELECT COALESCE(SUM(size), 0) AS n FROM upload_sessions WHERE result IS NULL AND expires_at > ?').get(new Date().toISOString()) as { n: number }).n
    // the team disk near full or over the plan's limit (system/storage.ts): 507 storage_full before anything is written.
    // The hard cap counts the open sessions too, or several at once could pass it.
    assertStorageRoom(size, reserved)
    if (free < size + reserved + DISK_MARGIN) fileError('payload_too_large', 'diskFull')
    const id = newId()
    const fd = fs.openSync(this.part(id), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    try { fs.ftruncateSync(fd, size) } finally { fs.closeSync(fd) }
    const now = Date.now()
    const expires = expiry(now, now)
    db.query('INSERT INTO upload_sessions (id, user_id, target, size, sha256, chunk_size, received, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, userId, JSON.stringify(target), size, sha256, UPLOAD_CHUNK_SIZE, '[]', expires, new Date(now).toISOString())
    return this.get(userId, id)
  }

  /** Early checks (complete checks again: rules may change during a long upload). */
  private checkTarget(userId: string, t: UploadTarget, sha256: string) {
    if (t.kind === 'path') {
      const user = this.files.principal(userId)
      const r = authorize(this.files.fx, this.files.rules(), user, t.path, 'write', { mustExist: false })
      if (r.exists && (r.st!.isDirectory() || t.onExists === 'fail')) fileError('conflict', 'exists', { path: r.rel })
    } else if (t.kind === 'attachment') {
      this.attachments.assertUploadChat(userId, t.chatId, sha256)
      const bad = t.name.includes('/') ? 'names cannot contain "/"' : badSegment(t.name.normalize('NFC'))
      if (bad) fileError('validation', 'badName', { name: bad })
    } else if (!this.transcribe) {
      throw new HttpError('unavailable')
    } else {
      if (t.chatId) this.attachments.assertVoiceChat(userId, t.chatId)
      this.transcribeCheck?.(userId, t.chatId)
    }
  }

  get(userId: string, id: string): UploadSession { return this.toApi(this.row(userId, id)) }

  async putChunk(userId: string, id: string, n: number, body: AsyncIterable<Uint8Array>): Promise<{ received: number[] }> {
    const r = this.row(userId, id)
    if (r.result) return { received: JSON.parse(r.received) }
    if (this.completing.has(id)) fileError('conflict', 'completing')
    const count = chunkCount(r.size, r.chunk_size)
    if (!Number.isInteger(n) || n < 0 || n >= count) fileError('validation', 'chunkSize', { n: `chunk number must be 0..${count - 1}` })
    const already: number[] = JSON.parse(r.received)
    if (already.includes(n)) { for await (const _ of body) { /* drain */ } return { received: already } }
    const expected = n === count - 1 ? r.size - n * r.chunk_size : r.chunk_size
    const offset = n * r.chunk_size
    const h = this.hashes.get(id) ?? (n === 0 ? { hash: crypto.createHash('sha256'), next: 0 } : null)
    const inOrder = h && h.next === n ? h.hash.copy() : null
    let fh: fs.promises.FileHandle
    try { fh = await fs.promises.open(this.part(id), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      // the part file is gone (a restored DB brought the session back, the folder was cleaned): this session can
      // never finish; end it so the client starts a new one instead of retrying
      this.drop(id)
      fileError('gone', 'uploadLost')
    }
    let got = 0
    try {
      for await (const ch of body) {
        if (got + ch.byteLength > expected) fileError('validation', 'chunkSize', { body: `chunk ${n} must be ${expected} bytes` })
        let off = 0
        while (off < ch.byteLength) { const { bytesWritten } = await fh.write(ch, off, ch.byteLength - off, offset + got + off); off += bytesWritten }
        inOrder?.update(ch)
        got += ch.byteLength
      }
    } finally { await fh.close() }
    if (got !== expected) fileError('validation', 'chunkSize', { body: `chunk ${n} must be ${expected} bytes, got ${got}` })
    if (inOrder) this.hashes.set(id, { hash: inOrder, next: n + 1 })
    // read-modify-write in one synchronous transaction: concurrent chunk requests can't lose each other's updates.
    // An accepted chunk also moves the expiry (24 h idle, capped at 7 days from the start).
    const received = this.ctx.db.transaction(() => {
      const cur = this.ctx.db.query('SELECT received, created_at FROM upload_sessions WHERE id = ?').get(id) as { received: string; created_at: string | null } | null
      if (!cur) throw new HttpError('not_found')
      const set = new Set<number>(JSON.parse(cur.received))
      set.add(n)
      const list = [...set].sort((a, b) => a - b)
      const expires = expiry(Date.now(), cur.created_at ? Date.parse(cur.created_at) : NaN)
      this.ctx.db.query('UPDATE upload_sessions SET received = ?, expires_at = ? WHERE id = ?').run(JSON.stringify(list), expires, id)
      return list
    })()
    return { received }
  }

  async complete(userId: string, id: string): Promise<UploadComplete> {
    const r = this.row(userId, id)
    if (r.result) return JSON.parse(r.result)
    const running = this.completing.get(id)
    if (running) return running
    const p = this.finish(userId, r).finally(() => this.completing.delete(id))
    this.completing.set(id, p)
    return p
  }

  private async finish(userId: string, r: Row): Promise<UploadComplete> {
    const id = r.id
    const count = chunkCount(r.size, r.chunk_size)
    const received = new Set<number>(JSON.parse(r.received))
    const missing: number[] = []
    for (let i = 0; i < count && missing.length < 50; i++) if (!received.has(i)) missing.push(i)
    if (missing.length) fileError('conflict', 'missingChunks', { missing: missing.join(',') })
    const h = this.hashes.get(id)
    const sha = h && h.next === count ? h.hash.digest('hex') : await hashFile(this.part(id), h ? { hash: h.hash, offset: h.next * r.chunk_size } : undefined)
    this.hashes.delete(id)
    if (sha !== r.sha256) {
      this.ctx.db.query("UPDATE upload_sessions SET received = '[]' WHERE id = ?").run(id)
      fileError('conflict', 'checksum', { sha256: sha })
    }
    const target = JSON.parse(r.target) as UploadTarget
    let result: UploadComplete
    if (target.kind === 'path') {
      const slash = target.path.lastIndexOf('/')
      const entry = await this.files.placeUpload(userId, slash < 0 ? '' : target.path.slice(0, slash), target.path.slice(slash + 1), this.part(id), target.onExists, sha)
      result = { kind: 'path', entry }
    } else if (target.kind === 'attachment') {
      result = { kind: 'attachment', attachment: await this.attachments.create(userId, target.chatId, target.name, this.part(id), sha) }
    } else {
      if (!this.transcribe) throw new HttpError('unavailable')
      // checked again here: the chat may be gone or locked confidential during a long upload; refused, nothing of the
      // recording is kept
      try {
        if (target.chatId) this.attachments.assertVoiceChat(userId, target.chatId)
        result = { kind: 'transcribe', jobId: this.transcribe(userId, this.part(id), target.name, target.chatId) }
      } catch (e) { this.drop(id); throw e }
    }
    fs.rmSync(this.part(id), { force: true })
    this.ctx.db.query('UPDATE upload_sessions SET result = ? WHERE id = ?').run(JSON.stringify(result), id)
    return result
  }

  /** Drop an upload. An attachment's chip taken out while its file was being put in place, or just after (the person
   * never got its id): a file a shared chat put in its project folder goes to the trash once it is there
   * (TeamFileRefs.discard, which leaves anything sent, changed or attached elsewhere). */
  async cancel(userId: string, id: string) {
    const r = this.row(userId, id)
    const running = this.completing.get(id)
    if (running) {
      if ((JSON.parse(r.target) as UploadTarget).kind !== 'attachment') fileError('conflict', 'completing')
      const done = await running.catch(() => null)
      this.attachments.discardSaved(userId, done?.kind === 'attachment' ? done.attachment : null)
      return
    }
    const done = r.result ? JSON.parse(r.result) as UploadComplete : null
    if (done?.kind === 'attachment') this.attachments.discardSaved(userId, done.attachment)
    this.drop(id)
  }
  private drop(id: string) {
    this.hashes.delete(id)
    fs.rmSync(this.part(id), { force: true })
    this.ctx.db.query('DELETE FROM upload_sessions WHERE id = ?').run(id)
  }

  /** Expired sessions (expires_at: 24 h after the last chunk, at most 7 days after the start) and orphan part files. */
  sweep(now = Date.now()): number {
    let n = 0
    for (const r of this.ctx.db.query('SELECT id FROM upload_sessions WHERE expires_at <= ?').all(new Date(now).toISOString()) as { id: string }[]) {
      if (this.completing.has(r.id)) continue
      this.drop(r.id); n++
    }
    try {
      for (const f of fs.readdirSync(this.dir())) {
        const id = f.replace(/\.part$/, '')
        if (f.endsWith('.part') && !this.ctx.db.query('SELECT 1 FROM upload_sessions WHERE id = ?').get(id)) { fs.rmSync(path.join(this.dir(), f), { force: true }); n++ }
      }
    } catch { /* folder missing */ }
    return n
  }
}

export const chunkCount = (size: number, chunk: number) => (size === 0 ? 0 : Math.ceil(size / chunk))

/** When a session with chunks last accepted at `now` expires: 24 h idle, never past 7 days from `createdAt` (a row
 * from before created_at was kept has no cap). */
export function expiry(now: number, createdAt: number): string {
  const cap = Number.isFinite(createdAt) ? createdAt + SESSION_MAX_MS : Infinity
  return new Date(Math.min(now + SESSION_TTL_MS, cap)).toISOString()
}
