// Minimal JobService over the jobs table, used by component G's long operations (backup, restore, update, export)
// only while component C's JobService (server/src/jobs/*) is not installed in ctx.services.jobs. Same contract:
// a jobs row, job.progress / job.done events to the person who started it, result at GET /api/jobs/:id (C).
import type { ApiErrorBody, Job, JobKind, JobStatus } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import type { AppContext } from '../context'
import { HttpError } from '../http/errors'
import type { JobHandle, JobService } from '../services'

interface JobRow { id: string; kind: JobKind; status: JobStatus; progress: number | null; message: string | null; result: string | null; error: string | null; created_at: string; finished_at: string | null }

export function jobFromRow(r: JobRow): Job {
  return {
    id: r.id, kind: r.kind, status: r.status, progress: r.progress, message: r.message,
    result: r.result ? JSON.parse(r.result) : null,
    error: r.error ? JSON.parse(r.error) as ApiErrorBody : null,
    createdAt: r.created_at, finishedAt: r.finished_at,
  }
}

export class LocalJobService implements JobService {
  private running = new Map<string, AbortController>()
  constructor(private ctx: AppContext) {}

  get(id: string): Job | null {
    const r = this.ctx.db.query('SELECT id, kind, status, progress, message, result, error, created_at, finished_at FROM jobs WHERE id = ?').get(id) as JobRow | null
    return r ? jobFromRow(r) : null
  }

  start(o: { kind: JobKind; userId: string | null; run: (h: JobHandle) => Promise<unknown> }): string {
    const id = uuidv7()
    const db = this.ctx.db
    db.query("INSERT INTO jobs (id, user_id, kind, status, progress) VALUES (?, ?, ?, 'queued', NULL)").run(id, o.userId, o.kind)
    const ac = new AbortController()
    this.running.set(id, ac)
    const publish = (ev: Parameters<AppContext['services']['realtime']['publish']>[1]) => { if (o.userId) this.ctx.services.realtime.publish(o.userId, ev) }
    let lastAt = 0
    const handle: JobHandle = {
      id, signal: ac.signal,
      progress: (p, message = null) => {
        const now = Date.now()
        if (now - lastAt < 250 && p !== 1) return
        lastAt = now
        const prog = p === null ? null : Math.max(0, Math.min(1, p))
        db.query('UPDATE jobs SET progress = ?, message = ? WHERE id = ?').run(prog, message, id)
        publish({ type: 'job.progress', data: { jobId: id, kind: o.kind, progress: prog, message } })
      },
    }
    const log = this.ctx.log.child({ job: id, kind: o.kind })
    queueMicrotask(async () => {
      db.query("UPDATE jobs SET status = 'running' WHERE id = ?").run(id)
      try {
        const result = await o.run(handle)
        db.query("UPDATE jobs SET status = 'done', progress = 1, result = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(JSON.stringify(result ?? null), id)
      } catch (e) {
        const canceled = ac.signal.aborted
        const err: ApiErrorBody = e instanceof HttpError ? e.body('ko') : { code: 'internal', message: (e as Error).message }
        db.query("UPDATE jobs SET status = ?, error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(canceled ? 'canceled' : 'failed', JSON.stringify(err), id)
        log.warn('job failed', { err: e })
      } finally {
        this.running.delete(id)
        const job = this.get(id)
        if (job) publish({ type: 'job.done', data: { job } })
      }
    })
    return id
  }

  cancel(id: string): boolean {
    const ac = this.running.get(id)
    if (!ac) return false
    ac.abort()
    return true
  }
}
