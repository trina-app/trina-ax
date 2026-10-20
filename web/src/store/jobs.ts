// Long-running work (202 { jobId }): progress over WebSocket job.progress / job.done, with a REST poll as a
// fallback when the socket is down (GET /api/jobs/:id).
import { create } from 'zustand'
import type { Job, JobKind } from '@mycel/shared/api'
import { api, API } from '../lib/api'

export interface JobView {
  id: string
  kind: JobKind | null
  status: Job['status']
  progress: number | null
  message: string | null
  job: Job | null
}

interface JobsState {
  jobs: Record<string, JobView>
  progress: (jobId: string, kind: JobKind, progress: number | null, message: string | null) => void
  done: (job: Job) => void
}

const waiters = new Map<string, Set<(j: Job) => void>>()

export const useJobs = create<JobsState>((set) => ({
  jobs: {},
  progress(jobId, kind, progress, message) {
    set((s) => {
      const cur = s.jobs[jobId]
      if (cur?.job) return s // already finished
      return { jobs: { ...s.jobs, [jobId]: { id: jobId, kind, status: 'running', progress, message, job: null } } }
    })
  },
  done(job) {
    set((s) => ({ jobs: { ...s.jobs, [job.id]: { id: job.id, kind: job.kind, status: job.status, progress: job.progress, message: job.message, job } } }))
    const ws = waiters.get(job.id)
    waiters.delete(job.id)
    ws?.forEach((fn) => fn(job))
  },
}))

const FINISHED = new Set<Job['status']>(['done', 'failed', 'canceled'])

/**
 * Resolve when the job finishes. Listens for job.done and polls every `pollMs` in case the event is missed
 * (socket down, page loaded after the job ended). Rejects on abort.
 */
export function waitForJob(jobId: string, o: { signal?: AbortSignal; pollMs?: number; fetchJob?: (id: string) => Promise<Job> } = {}): Promise<Job> {
  const fetchJob = o.fetchJob ?? ((id: string) => api.call(API.getJob, { params: { id } }))
  return new Promise<Job>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (j: Job) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      waiters.get(jobId)?.delete(finish)
      resolve(j)
    }
    const known = useJobs.getState().jobs[jobId]?.job
    if (known) return finish(known)
    let set = waiters.get(jobId)
    if (!set) waiters.set(jobId, (set = new Set()))
    set.add(finish)
    const poll = async () => {
      if (settled) return
      try {
        const j = await fetchJob(jobId)
        if (FINISHED.has(j.status)) return finish(j)
      } catch { /* keep waiting; the event may still come */ }
      if (!settled) timer = setTimeout(poll, o.pollMs ?? 3000)
    }
    timer = setTimeout(poll, o.pollMs ?? 3000)
    o.signal?.addEventListener('abort', () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      waiters.get(jobId)?.delete(finish)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
}
