// Component C's services for one server instance, created on first use. Other components use them through here:
//   componentC(ctx).artifacts.apply(...)      B: artifact tool calls from the engine stream
//   componentC(ctx).attachments.byIds(...)    B: attachments of a message being sent
//   componentC(ctx).files.remove(...)         anyone who needs the trash
import fs from 'node:fs'
import path from 'node:path'
import type { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { JobServiceImpl } from '../jobs/service'
import { transcribe, transcribeConfig, type TranscribeConfig } from '../jobs/transcribe'
import { Artifacts } from '../tools/artifact'
import { findConverters, MakeFile } from '../tools/make-file'
import { Attachments } from '../uploads/attachments'
import { UploadSessions } from '../uploads/sessions'
import { publishChanges } from './changes'
import { TeamFiles } from './service'

export interface ComponentC {
  files: TeamFiles
  attachments: Attachments
  uploads: UploadSessions
  artifacts: Artifacts
  makeFile: MakeFile
  jobs: JobServiceImpl
  transcribe: TranscribeConfig
  /** start a transcription job for a server-owned audio file (moved into the job; removed when it ends) */
  startTranscribe(userId: string, file: string, name: string, o?: { language?: string }): string
  /** run every retention sweep now (also runs hourly) */
  sweep(): Record<string, number>
}

const instances = new WeakMap<AppContext, ComponentC>()
export const SWEEP_EVERY_MS = 3600_000

export function componentC(ctx: AppContext): ComponentC {
  const have = instances.get(ctx)
  if (have) return have
  const files = new TeamFiles(ctx)
  const attachments = new Attachments(ctx, files)
  const uploads = new UploadSessions(ctx, files, attachments)
  const jobs = new JobServiceImpl(ctx)
  const stt = transcribeConfig(ctx.config.dataDir)
  const locale = (userId: string): Locale => ((ctx.db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale: Locale } | null)?.locale ?? 'ko')
  const c: ComponentC = {
    files, attachments, uploads, jobs,
    artifacts: new Artifacts(ctx),
    makeFile: new MakeFile(ctx, files, findConverters(ctx.engineConfig.pandoc)),
    transcribe: stt,
    startTranscribe(userId, file, name, o = {}) {
      const dir = path.join(ctx.config.dataDir, 'work')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const own = path.join(dir, `stt-in-${crypto.randomUUID()}`)
      fs.renameSync(file, own)
      return jobs.start({
        kind: 'transcribe', userId,
        run: async (h) => {
          try { return await transcribe(stt, own, name, { language: o.language, locale: locale(userId) }, h) } finally { fs.rmSync(own, { force: true }) }
        },
      })
    },
    sweep() {
      const r: Record<string, number> = {}
      const run = (k: string, f: () => number | Record<string, number>) => {
        try { const v = f(); if (typeof v === 'number') r[k] = v; else for (const [kk, vv] of Object.entries(v)) r[`${k}.${kk}`] = vv } catch (e) { ctx.log.error('sweep failed', { sweep: k, err: e }) }
      }
      run('files', () => files.sweep())
      run('uploads', () => uploads.sweep())
      run('jobs', () => jobs.sweep())
      run('thumbs', () => attachments.sweep())
      // converter work folders and spooled small uploads left behind by a crash
      run('scratch', () => {
        let n = 0
        for (const [dir, maxAge] of [[path.join(ctx.config.dataDir, 'work'), 24 * 3600_000], [path.join(ctx.config.dataDir, 'uploads', 'tmp'), 3600_000]] as const) {
          let names: string[] = []
          try { names = fs.readdirSync(dir) } catch { continue }
          for (const f of names) {
            const p = path.join(dir, f)
            try { if (Date.now() - fs.lstatSync(p).mtimeMs > maxAge) { fs.rmSync(p, { recursive: true, force: true }); n++ } } catch { /* gone */ }
          }
        }
        return n
      })
      return r
    },
  }
  uploads.transcribe = (userId, file, name) => c.startTranscribe(userId, file, name)
  // live updates for AI tool writes (stage-1 file tools emit 'changed')
  ctx.files.events.on('changed', (e: { path: string; action: 'create' | 'update'; userId: string; userName: string; turnId: string | null }) => {
    publishChanges(ctx, [{ path: e.path, action: e.action, by: { id: e.userId, name: e.userName }, turnId: e.turnId }])
  })
  instances.set(ctx, c)
  return c
}

/** Start background duties once per server: recover jobs, hourly sweeps; stop them on close. */
export function startComponentC(ctx: AppContext): ComponentC {
  const c = componentC(ctx)
  ctx.services.jobs = c.jobs
  const failed = c.jobs.recover()
  if (failed) ctx.log.info('jobs interrupted by the restart marked failed', { count: failed })
  const first = setTimeout(() => c.sweep(), 30_000)
  const timer = setInterval(() => c.sweep(), SWEEP_EVERY_MS)
  first.unref?.(); timer.unref?.()
  ctx.onClose(async () => { clearTimeout(first); clearInterval(timer); await c.jobs.close() })
  return c
}
