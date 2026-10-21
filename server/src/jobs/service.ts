// Long-running work (tab 4 "오래 걸리는 작업"): the starting request answers 202 { jobId } at once; the job runs in
// the background and reports over WebSocket (job.progress, job.done); GET /api/jobs/:id has the result.
// - one job of a kind at a time for CPU / disk heavy kinds (transcribe, backup, restore, update, export)
// - progress is throttled (DB + event at most every 500 ms; the final state always goes out)
// - cancel: queued -> canceled at once; running -> the job's AbortSignal fires, the job settles as canceled
// - server start: queued / running jobs of the previous process become failed ("서버가 다시 시작되어 중단됨")
// - finished jobs are deleted after 7 days (with their work folder <data>/jobs/<id>)
import fs from 'node:fs'
import path from 'node:path'
import type { ApiErrorBody, Job, JobKind, JobStatus, Locale } from '@mycel/shared/api'
import { errorMessage, Job as JobSchema } from '@mycel/shared/api'
import { teamDefaultLocale } from '../admin/settings'
import type { AppContext } from '../context'
import { newId } from '../db'
import { HttpError } from '../http/errors'
import type { JobHandle, JobService } from '../services'

/** A job failure with a message for the person (in their language). */
export class JobFailure extends Error {
  constructor(readonly code: ApiErrorBody['code'], readonly messages: Record<Locale, string>) {
    super(messages.en)
    this.name = 'JobFailure'
  }
}

const SINGLE: ReadonlySet<JobKind> = new Set(['transcribe', 'backup', 'restore', 'update', 'export'])
export const JOB_KEEP_MS = 7 * 86_400_000
const PROGRESS_EVERY_MS = 500
const INTERRUPTED: Record<Locale, string> = {
  ko: '서버가 다시 시작되어 작업이 중단되었습니다. 다시 시도해 주세요.',
  en: 'The server restarted and the job was interrupted. Please try again.',
  id: 'Server dimulai ulang dan pekerjaan terhenti. Silakan coba lagi.',
}

interface Row { id: string; user_id: string | null; kind: JobKind; status: JobStatus; progress: number | null; message: string | null; result: string | null; error: string | null; created_at: string; finished_at: string | null }

interface Running { id: string; kind: JobKind; userId: string | null; abort: AbortController; run: (h: JobHandle) => Promise<unknown>; discard?: () => void; done: () => void }

export class JobServiceImpl implements JobService {
  private queue: Running[] = []
  private active = new Map<string, Running>()
  private lastProgress = new Map<string, number>()
  /** resolves when a job settles (tests, shutdown) */
  private settled = new Map<string, Promise<void>>()

  constructor(private ctx: AppContext) {}

  dir(id: string) { return path.join(this.ctx.config.dataDir, 'jobs', id) }

  /** Mark jobs of a previous process as failed (call once at start). */
  recover(): number {
    const err: ApiErrorBody = { code: 'unavailable', message: INTERRUPTED.en }
    const rows = this.ctx.db.query("SELECT id, user_id FROM jobs WHERE status IN ('queued','running')").all() as { id: string; user_id: string | null }[]
    for (const r of rows) {
      const loc = this.locale(r.user_id)
      this.ctx.db.query("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(JSON.stringify({ ...err, message: INTERRUPTED[loc] }), new Date().toISOString(), r.id)
    }
    return rows.length
  }

  start(o: { kind: JobKind; userId: string | null; run: (h: JobHandle) => Promise<unknown>; discard?: () => void }): string {
    const id = newId()
    this.ctx.db.query("INSERT INTO jobs (id, user_id, kind, status, progress, message, created_at) VALUES (?,?,?,'queued',NULL,NULL,?)").run(id, o.userId, o.kind, new Date().toISOString())
    let done = () => {}
    this.settled.set(id, new Promise<void>((res) => { done = res }).then(() => { this.settled.delete(id) }))
    const r: Running = { id, kind: o.kind, userId: o.userId, abort: new AbortController(), run: o.run, discard: o.discard, done }
    this.queue.push(r)
    queueMicrotask(() => this.pump())
    return id
  }

  /** Wait until a job has finished (any final status). */
  async wait(id: string): Promise<Job | null> {
    await this.settled.get(id)
    return this.get(id)
  }

  private pump() {
    for (const r of [...this.queue]) {
      if (SINGLE.has(r.kind) && [...this.active.values()].some((a) => a.kind === r.kind)) continue
      this.queue.splice(this.queue.indexOf(r), 1)
      this.active.set(r.id, r)
      void this.execute(r)
    }
  }

  private async execute(r: Running) {
    const db = this.ctx.db
    db.query("UPDATE jobs SET status = 'running' WHERE id = ?").run(r.id)
    const handle: JobHandle = {
      id: r.id,
      signal: r.abort.signal,
      progress: (p, message) => this.progress(r, p, message ?? null),
    }
    let status: JobStatus = 'done'
    let result: unknown = null
    let error: ApiErrorBody | null = null
    try {
      fs.mkdirSync(this.dir(r.id), { recursive: true, mode: 0o700 })
      result = await r.run(handle)
      if (r.abort.signal.aborted) status = 'canceled'
    } catch (e) {
      if (r.abort.signal.aborted) status = 'canceled'
      else {
        status = 'failed'
        const loc = this.locale(r.userId)
        if (e instanceof JobFailure) error = { code: e.code, message: e.messages[loc] }
        else if (e instanceof HttpError) error = e.body(loc)
        else {
          this.ctx.log.error('job failed', { job: r.id, kind: r.kind, err: e })
          error = { code: 'internal', message: errorMessage('internal', loc) }
        }
      }
    }
    if (status !== 'done') result = null
    db.query('UPDATE jobs SET status = ?, progress = ?, result = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, status === 'done' ? 1 : null, result === null || result === undefined ? null : JSON.stringify(result), error ? JSON.stringify(error) : null, new Date().toISOString(), r.id)
    this.active.delete(r.id)
    this.lastProgress.delete(r.id)
    fs.rmSync(this.dir(r.id), { recursive: true, force: true })
    const job = this.get(r.id)
    if (job && r.userId) this.ctx.services.realtime.publish(r.userId, { type: 'job.done', data: { job } })
    r.done()
    this.pump()
  }

  private progress(r: Running, p: number | null, message: string | null) {
    const now = Date.now()
    const last = this.lastProgress.get(r.id) ?? 0
    if (now - last < PROGRESS_EVERY_MS && p !== 1) return
    this.lastProgress.set(r.id, now)
    const v = p === null ? null : Math.max(0, Math.min(1, p))
    this.ctx.db.query('UPDATE jobs SET progress = ?, message = ? WHERE id = ?').run(v, message, r.id)
    if (r.userId) this.ctx.services.realtime.publish(r.userId, { type: 'job.progress', data: { jobId: r.id, kind: r.kind, progress: v, message } })
  }

  cancel(id: string): boolean {
    const q = this.queue.find((r) => r.id === id)
    if (q) {
      this.queue.splice(this.queue.indexOf(q), 1)
      this.ctx.db.query("UPDATE jobs SET status = 'canceled', finished_at = ? WHERE id = ?").run(new Date().toISOString(), id)
      this.discard(q)
      const job = this.get(id)
      if (job && q.userId) this.ctx.services.realtime.publish(q.userId, { type: 'job.done', data: { job } })
      q.done()
      return true
    }
    const a = this.active.get(id)
    if (a) { a.abort.abort(); return true }
    return false
  }

  /** a job that will never run gives back what was set aside for it */
  private discard(r: Running) {
    try { r.discard?.() } catch (e) { this.ctx.log.warn('job discard failed', { job: r.id, kind: r.kind, err: e }) }
  }

  get(id: string): Job | null {
    const r = this.ctx.db.query('SELECT id, user_id, kind, status, progress, message, result, error, created_at, finished_at FROM jobs WHERE id = ?').get(id) as Row | null
    return r ? toJob(r) : null
  }
  ownerOf(id: string): string | null | undefined {
    const r = this.ctx.db.query('SELECT user_id FROM jobs WHERE id = ?').get(id) as { user_id: string | null } | null
    return r ? r.user_id : undefined
  }

  private locale(userId: string | null): Locale {
    const u = userId ? (this.ctx.db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale: Locale } | null) : null
    return u?.locale ?? teamDefaultLocale(this.ctx.db)
  }

  /** Delete finished jobs older than 7 days and stray work folders. */
  sweep(now = Date.now()): number {
    const cutoff = new Date(now - JOB_KEEP_MS).toISOString()
    const n = this.ctx.db.query("DELETE FROM jobs WHERE status IN ('done','failed','canceled') AND finished_at < ?").run(cutoff).changes
    try {
      for (const d of fs.readdirSync(path.join(this.ctx.config.dataDir, 'jobs'))) if (!this.active.has(d) && !this.queue.some((q) => q.id === d)) fs.rmSync(path.join(this.ctx.config.dataDir, 'jobs', d), { recursive: true, force: true })
    } catch { /* none */ }
    return n
  }

  /** Abort everything (server shutdown). */
  async close() {
    for (const q of this.queue.splice(0)) { this.discard(q); q.done() }
    for (const a of this.active.values()) a.abort.abort()
    await Promise.all([...this.settled.values()])
  }
}

function toJob(r: Row): Job {
  const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T } catch { return null } }
  const job = {
    id: r.id, kind: r.kind, status: r.status, progress: r.progress, message: r.message,
    result: parse<Job['result']>(r.result), error: parse<ApiErrorBody>(r.error), createdAt: r.created_at, finishedAt: r.finished_at,
  }
  // a result that doesn't fit the contract is reported as missing rather than breaking the response
  const ok = JobSchema.safeParse(job)
  return ok.success ? ok.data : { ...job, result: null }
}
