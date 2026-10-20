// Route module "jobs" — owner: component C (docs/WORKPLAN.md).
// Implements: JOBS (get, cancel, transcribe). Contract: shared/src/api/jobs.ts. Logic: server/src/jobs/*.
// init() installs the JobService (ctx.services.jobs) that G's backup / restore / update / export also use.
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
import { mapErrors } from '../team-files/errors'
import { componentC, startComponentC } from '../team-files/component'
import { writeTemp } from '../team-files/place'
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
      if (body.fields.chatId) C.attachments.assertOwnChat(auth.user.id, body.fields.chatId)
      const name = body.file.name || 'audio.webm'
      const p = await writeTemp(path.join(ctx.config.dataDir, 'work'), body.file)
      try {
        return { jobId: C.startTranscribe(auth.user.id, p, name, { language: body.fields.language }) }
      } catch (e) { fs.rmSync(p, { force: true }); throw e }
    }))
  },
}
