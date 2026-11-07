// Component C's services for one server instance, created on first use. Other components use them through here:
//   componentC(ctx).artifacts.apply(...)      B: artifact tool calls from the engine stream
//   componentC(ctx).attachments.byIds(...)    B: attachments of a message being sent
//   componentC(ctx).files.remove(...)         anyone who needs the trash
import { sweepMedia } from '../integrations/connections/media'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { HwpPreviews } from '../files/hwp-preview'
import { pluginsOf } from '../plugins/manager'
import path from 'node:path'
import { DEFAULT_LOCALE, type Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { JobServiceImpl } from '../jobs/service'
import { transcribe, type TranscribeConfig } from '../jobs/transcribe'
import { cleanMediaWork, localModelName, recordLocalSpeed } from '../files/media'
import { SPEECH_CONFIDENTIAL, SPEECH_NO_KEY, SPEECH_OFF, transcribeOpenRouter } from '../jobs/openrouter-stt'
import { confidentialDictation } from '../safe-ops/confidential'
import { HttpError } from '../http/errors'
import { getTeamSettings, installId, teamDefaultLocale } from '../admin/settings'
import { limitsActive } from '../system/limits'
import { credentialsOf } from '../credentials/store'
import { readHostedSpeechKey, readSpeechKey, speechKeySource } from '../credentials/speech-key'
import { HOSTED_SPEECH_MODEL, hostedSpeechLeft, hostedSpeechMeter } from '../credentials/hosted-speech'
import { Artifacts } from '../tools/artifact'
import { findConverters, MakeFile } from '../tools/make-file'
import { Attachments } from '../uploads/attachments'
import { TeamFileRefs } from '../uploads/team-refs'
import { UploadSessions } from '../uploads/sessions'
import { publishChanges } from './changes'
import { atLeast, loadPrincipal, RuleSet } from '../policy/access'
import { TeamFiles } from './service'

export interface ComponentC {
  hwp: HwpPreviews
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
  /** Voice input for `chatId` (absent: a chat not created yet) may not start: a confidential chat's recording while
   * the speech provider is OpenRouter. Throws a 403 with the person's note; the job checks again when it runs. */
  checkTranscribe(userId: string, chatId?: string): void
  startTranscribe(userId: string, file: string, name: string, o?: { language?: string; chatId?: string }): string
  /** run every retention sweep now (also runs hourly) */
  sweep(): Record<string, number>
}

const instances = new WeakMap<AppContext, ComponentC>()
export const SWEEP_EVERY_MS = 3600_000

/** When the background remake of older document text (OfficeCache.upgradeOld) starts after a start: 20 s; where the
 * limits apply (Linux, a plan: many teams on one host restart together after an update) 10 minutes plus 0–5 minutes
 * from the install id, so the teams of a host do not all start at once. */
export function upgradeStartMs(id: string): number {
  if (!limitsActive()) return 20_000
  return 10 * 60_000 + (createHash('sha256').update(id).digest().readUInt16BE(0) % 300) * 1000
}

export function componentC(ctx: AppContext): ComponentC {
  const have = instances.get(ctx)
  if (have) return have
  const files = new TeamFiles(ctx)
  const teamRefs = new TeamFileRefs(ctx, files)
  const attachments = new Attachments(ctx, files, teamRefs)
  const uploads = new UploadSessions(ctx, files, attachments)
  const jobs = new JobServiceImpl(ctx)
  // one speech configuration for voice input jobs and the AI's video / audio reads (files/media.ts)
  const stt = ctx.files.speech
  ctx.files.speechKey = () => readSpeechKey(credentialsOf(ctx))
  // the hosting service's key: its requests count against the month's free hours (credentials/hosted-speech.ts)
  stt.meter = hostedSpeechMeter(ctx.db, () => readHostedSpeechKey(credentialsOf(ctx)))
  ctx.files.speechFree = () => (speechKeySource(ctx.db) === 'hosted' ? { leftSec: hostedSpeechLeft(ctx.db) } : null)
  const locale = (userId: string): Locale => ((ctx.db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale: Locale } | null)?.locale ?? DEFAULT_LOCALE)
  const c: ComponentC = {
    // the renderer of the HWP Preview plugin while it is usable, otherwise every page is refused ('disabled')
    hwp: new HwpPreviews(files, () => pluginsOf(ctx).hwpEngine()),
    files, attachments, teamRefs, uploads, jobs,
    artifacts: new Artifacts(ctx),
    makeFile: new MakeFile(ctx, files, findConverters(ctx.engineConfig.pandoc)),
    transcribe: stt,
    checkTranscribe(userId, chatId) {
      if (getTeamSettings(ctx.db).speechProvider === 'openrouter' && confidentialDictation(ctx.db, chatId)) {
        throw new HttpError('forbidden', SPEECH_CONFIDENTIAL().messages[locale(userId)], { params: { reason: 'confidential' } })
      }
    },
    startTranscribe(userId, file, name, o = {}) {
      // a confidential chat's recording never goes out (refused here before it is kept, and again when the job runs:
      // the chat may be locked, or the provider changed, while it waits)
      c.checkTranscribe(userId, o.chatId)
      const sendable = () => !confidentialDictation(ctx.db, o.chatId)
      const dir = path.join(ctx.config.dataDir, 'work')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const own = path.join(dir, `stt-in-${crypto.randomUUID()}`)
      fs.renameSync(file, own)
      return jobs.start({
        kind: 'transcribe', userId,
        run: async (h) => {
          try {
            // the team's speech provider when the job runs (Admin > Team settings): off (default), OpenRouter, this server
            const opts = { language: o.language, locale: locale(userId) }
            const s = getTeamSettings(ctx.db)
            // voice input also tells how fast whisper.cpp is here, before the first video read needs it
            if (s.speechProvider === 'local') return await transcribe(stt, own, name, { ...opts, onTimed: (ms, sec) => { if (sec > 0) recordLocalSpeed(ctx.db, localModelName(stt.model), stt.threads, ms, sec) } }, h)
            if (s.speechProvider !== 'openrouter') throw SPEECH_OFF()
            if (!sendable()) throw SPEECH_CONFIDENTIAL()
            const key = readSpeechKey(credentialsOf(ctx))
            if (!key) throw SPEECH_NO_KEY()
            // the hosting service's key is for its one model (its guardrail at OpenRouter refuses any other)
            const model = speechKeySource(ctx.db) === 'hosted' ? HOSTED_SPEECH_MODEL : s.speechModel
            // a long recording heard in an unlikely language goes once more told the team's (jobs/speech-language.ts);
            // that, or a provider failure's second try, sends the recording again only while voice input is still on
            // OpenRouter and the chat has not become confidential
            return await transcribeOpenRouter(stt, key, model, own, name, { ...opts, team: teamDefaultLocale(ctx.db), again: () => getTeamSettings(ctx.db).speechProvider === 'openrouter' && sendable() }, h)
          } finally { fs.rmSync(own, { force: true }) }
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
      // transcripts of video and audio reads: 30 days, 200 MB (files/media.ts TranscriptCache)
      run('mediacache', () => ctx.files.transcripts.prune())
      // images and files connections returned inline, kept a day for save_url (integrations/connections/media.ts)
      run('connectionMedia', () => sweepMedia(ctx.config.dataDir))
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
  uploads.transcribe = (userId, file, name, chatId) => c.startTranscribe(userId, file, name, { chatId })
  uploads.transcribeCheck = (userId, chatId) => c.checkTranscribe(userId, chatId)
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
  ctx.files.events.on('hwp-invalidate', () => c.hwp.invalidate())
  ctx.onClose(() => { c.hwp.invalidate() })
  instances.set(ctx, c)
  return c
}

/** Start background duties once per server: recover jobs, hourly sweeps; stop them on close. */
export function startComponentC(ctx: AppContext): ComponentC {
  const c = componentC(ctx)
  ctx.services.jobs = c.jobs
  const failed = c.jobs.recover()
  if (failed) ctx.log.info('jobs interrupted by the restart marked failed', { count: failed })
  // no video or audio read survives a restart: their copies (up to 1 GB each) go now, not with the 24 h scratch sweep
  const left = cleanMediaWork(path.join(ctx.config.dataDir, 'work'))
  if (left) ctx.log.info('work folders of interrupted video reads removed', { count: left })
  const first = setTimeout(() => c.sweep(), 30_000)
  const timer = setInterval(() => c.sweep(), SWEEP_EVERY_MS)
  first.unref?.(); timer.unref?.()
  // the text of documents kept from the previous cache format is made again in the background (files/search.ts
  // OfficeCache.upgradeOld; grep uses the old text meanwhile), starting after upgradeStartMs
  const stopUpgrade = new AbortController()
  const upgrade = process.env.NODE_ENV === 'test' ? null : setTimeout(() => {
    const t0 = Date.now()
    void ctx.files.office.upgradeOld({ signal: stopUpgrade.signal })
      .then((n) => { if (n) ctx.log.info('document text made again in the new format', { files: n, ms: Date.now() - t0 }) })
      .catch((e) => ctx.log.warn('document text upgrade stopped', { err: String(e) }))
  }, upgradeStartMs(installId(ctx.db)))
  upgrade?.unref?.()
  ctx.onClose(async () => { clearTimeout(first); clearInterval(timer); if (upgrade) clearTimeout(upgrade); stopUpgrade.abort(); await c.jobs.close() })
  return c
}
