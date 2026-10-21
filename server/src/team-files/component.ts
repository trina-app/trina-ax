// Component C's services for one server instance, created on first use. Other components use them through here:
//   componentC(ctx).artifacts.apply(...)      B: artifact tool calls from the engine stream
//   componentC(ctx).attachments.byIds(...)    B: attachments of a message being sent
//   componentC(ctx).files.remove(...)         anyone who needs the trash
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_LOCALE, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { JobServiceImpl } from '../jobs/service'
import { transcribe, transcribeConfig, type TranscribeConfig } from '../jobs/transcribe'
import { Artifacts } from '../tools/artifact'
import { findConverters, MakeFile } from '../tools/make-file'
import { Attachments } from '../uploads/attachments'
import { TeamFileRefs } from '../uploads/team-refs'
import { UploadSessions } from '../uploads/sessions'
import { publishChanges } from './changes'
import { atLeast, loadPrincipal, RuleSet } from '../policy/access'
import { TeamFiles } from './service'

export interface ComponentC {
  files: TeamFiles
  attachments: Attachments
  /** team files attached to chats by reference (the composer's "Add from team files") */
  teamRefs: TeamFileRefs
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
  const teamRefs = new TeamFileRefs(ctx, files)
  const attachments = new Attachments(ctx, files, teamRefs)
  const uploads = new UploadSessions(ctx, files, attachments)
  const jobs = new JobServiceImpl(ctx)
  const stt = transcribeConfig(ctx.config.dataDir)
  const locale = (userId: string): Locale => ((ctx.db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale: Locale } | null)?.locale ?? DEFAULT_LOCALE)
  const c: ComponentC = {
    files, attachments, teamRefs, uploads, jobs,
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
        // canceled while waiting for the transcription before it: the recording goes now, not with tomorrow's sweep
        discard: () => fs.rmSync(own, { force: true }),
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
      run('teamRefs', () => teamRefs.sweep())
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
  // conflict copies (file screen saves and AI tool writes): both people are told (design tab 4 PUT content), each only
  // after checking again that they can read both the file and the copy now (the copy's name carries the saver's name;
  // someone who lost access learns nothing). No content in the event.
  ctx.files.events.on('conflict', (e: { path: string; copy: string; by?: string; users: string[] }) => {
    try {
      const rules = RuleSet.load(ctx.db)
      const segs = (p: string) => (p === '' ? [] : p.split('/'))
      const byRow = e.by ? (ctx.db.query('SELECT id, name FROM users WHERE id = ?').get(e.by) as { id: string; name: string } | null) : null
      for (const id of new Set(e.users)) {
        const who = loadPrincipal(ctx.db, id)
        if (!who) continue
        if (!atLeast(rules.access(who, segs(e.path)), 'read') || !atLeast(rules.access(who, segs(e.copy)), 'read')) continue
        ctx.services.realtime.publish(id, { type: 'files.conflict', data: { path: e.path, copyPath: e.copy, by: byRow ? { id: byRow.id, name: byRow.name } : null } })
      }
    } catch (err) { ctx.log.warn('files.conflict publish failed', { err }) }
  })
  // B reads a message's attachments back by id through this service (services.ts AttachmentStore)
  ctx.services.attachments = {
    get: (userId, chatId, ids) => attachments.byIds(userId, chatId, ids),
    lookup: (userId, chatId, ids) => attachments.lookup(userId, chatId, ids),
    view: (userId, atts) => atts.map((a) => (a.source === 'team' ? teamRefs.view(userId, a) : a)),
    check: (userId, atts) => Promise.all(atts.map((a) => (a.source === 'team' ? teamRefs.check(userId, a) : a))),
  }
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
