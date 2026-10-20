// Long-running work (tab 4 "업로드와 오래 걸리는 작업"). Owner: C (server/src/routes/jobs.ts, server/src/jobs/*).
// Starting endpoints answer 202 { jobId } at once; progress over WebSocket job.progress / job.done.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { JobAccepted, SMALL_UPLOAD_MAX } from './common'
import { endpoint, multipart } from './endpoint'
import { Job } from './entities'

export const TranscribeFields = z.object({
  /** language hint (ISO 639-1), default: auto */
  language: z.string().regex(/^[a-z]{2}$/).optional(),
  /** chat the voice input belongs to (optional; for the composer) */
  chatId: Uuid7.optional(),
})

export const JOBS = {
  getJob: endpoint({ method: 'GET', path: '/api/jobs/:id', auth: 'user', owner: 'C', response: Job, summary: 'Own job (owner: any job). Result when done.' }),
  cancelJob: endpoint({ method: 'POST', path: '/api/jobs/:id/cancel', auth: 'user', owner: 'C', response: Job, summary: 'Cancel a queued or running own job.' }),
  transcribe: endpoint({ method: 'POST', path: '/api/transcribe', auth: 'user', owner: 'C', status: 202, body: multipart(TranscribeFields, SMALL_UPLOAD_MAX), response: JobAccepted, summary: 'Voice input / recordings up to 50 MB (larger: upload session with target transcribe). Result: TranscribeResult.' }),
} as const
