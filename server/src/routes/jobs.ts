// Route module "jobs" — owner: component C (docs/WORKPLAN.md).
// Implements: JOBS (get, cancel, transcribe). Contract: shared/src/api/jobs.ts. Logic: server/src/jobs/*.
// init() installs the JobService (ctx.services.jobs) that G's backup / restore / update / export also use.
import { API } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
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
  },
}
