// Route module "jobs" — owner: component C (docs/WORKPLAN.md).
// Implements: JOBS (get, cancel, transcribe). Contract: shared/src/api/jobs.ts. Logic: server/src/jobs/*.
// init() installs the JobService (ctx.services.jobs) that G's backup / restore / update / export also use.
import { API } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
import { JobFailure } from '../jobs/service'
import { MeetingGone, MeetingInFlight, PieceTooFast } from '../jobs/meeting-piece'
import { mapErrors } from '../team-files/errors'
import { componentC, startComponentC } from '../team-files/component'
import type { RouteModule } from './module'

export const jobsRoutes: RouteModule = {
  name: 'jobs',
  owner: 'C',
  init(ctx) { startComponentC(ctx) },
  register(kit, ctx) {
    const C = componentC(ctx)
    /** own jobs only (design tab 4 "본인 작업만": a transcription result is that person's words); jobs that belong to
     * nobody (system backups, updates) are the owner's */
    const visible = (id: string, auth: { user: { id: string; role: string } }) => {
      const owner = C.jobs.ownerOf(id)
      if (owner === undefined || (owner === null ? auth.user.role !== 'owner' : owner !== auth.user.id)) throw new HttpError('not_found')
    }
    kit.handle(API.getJob, ({ params, auth }) => {
      visible(params.id, auth)
      return C.jobs.get(params.id)!
    })
    kit.handle(API.cancelJob, ({ params, auth }) => {
      visible(params.id, auth)
      C.jobs.cancel(params.id)
      return C.jobs.get(params.id)!
    })
    kit.handle(API.transcribe, ({ c, body, auth }) => mapErrors(c.get('locale'), async () => {
      const chatId = body.fields.chatId
      if (chatId) C.attachments.assertVoiceChat(auth.user.id, chatId)
      // a confidential chat's recording never goes to OpenRouter: refused before it is written anywhere
      C.checkTranscribe(auth.user.id, chatId)
      const name = body.file.name || 'audio.webm'
      // the recording is on disk already (http/multipart.ts); the job takes the file over, or the kit removes it
      return { jobId: C.startTranscribe(auth.user.id, body.file.path, name, { language: body.fields.language, chatId }) }
    }))
    // a piece's refusal as the apps read it (desktop meeting notes, web voice input): 429 in_flight / too_fast and 503
    // busy / not_ready are sent again after retryAfter; 409 (off, no_key, too_slow), 403 confidential and 429 free_used
    // stop with the sentence
    const pieceError = (locale: Parameters<typeof mapErrors>[0], e: unknown): never => {
      if (e instanceof MeetingInFlight) throw new HttpError('rate_limited', undefined, { params: { reason: 'in_flight' }, retryAfter: 2 })
      if (e instanceof PieceTooFast) throw new HttpError('rate_limited', undefined, { params: { reason: 'too_fast' }, retryAfter: e.retryAfter })
      if (e instanceof MeetingGone) throw new HttpError('bad_request')
      if (e instanceof JobFailure) {
        const again = e.reason === 'busy' || e.reason === 'not_ready'
        throw new HttpError(e.code, e.messages[locale], { ...(e.reason ? { params: { reason: e.reason } } : {}), ...(again ? { retryAfter: 5 } : {}) })
      }
      throw e
    }
    // meeting notes (desktop app): a piece of a meeting's sound, answered at once
    kit.handle(API.meetingStatus, () => C.meetingStatus())
    kit.handle(API.meetingPiece, ({ c, body, auth }) => mapErrors(c.get('locale'), async () => {
      try {
        return await C.meetingPiece(auth.user.id, body.file.path, { language: body.fields.language, signal: c.req.raw.signal })
      } catch (e) { return pieceError(c.get('locale'), e) }
    }))
    // voice input while recording (web app): the chat is checked as for a whole recording, before the piece is read
    kit.handle(API.transcribePiece, ({ c, body, auth }) => mapErrors(c.get('locale'), async () => {
      const chatId = body.fields.chatId
      if (chatId) C.attachments.assertVoiceChat(auth.user.id, chatId)
      C.checkTranscribe(auth.user.id, chatId)
      try {
        return await C.voicePiece(auth.user.id, body.file.path, { language: body.fields.language, signal: c.req.raw.signal })
      } catch (e) { return pieceError(c.get('locale'), e) }
    }))
  },
}
