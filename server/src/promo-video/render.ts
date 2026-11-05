// The MP4 of a promo video (docs/DECISIONS.md "V"): the same composition the chat plays, rendered with the HyperFrames
// CLI (headless Chrome + FFmpeg). Where this server can do it:
// - a development server on macOS (`mode: "dev"`, not office mode, not hosted) with the pinned CLI installed by
//   `bun scripts/promo-video/install-hyperframes.ts` (a vendored tool folder with its own lock file, outside the
//   repository's dependencies: ~/.cache/mycel/hyperframes-<version>, or MYCEL_HYPERFRAMES_DIR) and Node 22 or newer;
// - nowhere else yet: on a Linux team server the render belongs in the srt dev environment as a queued job, once its
//   image carries chrome-headless-shell and the CLI (the handoff in DECISIONS "V"). Until then the button is not shown.
// The render is built from the checked slots in promo_videos (never from the artifact's HTML, which `artifact update`
// could change): the pictures are copied out of the team folder with the chat owner's own permissions at render time,
// the font from the repository. One render at a time on the server; a finished MP4 is kept next to the data and given
// again until the video changes.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PromoMp4State, PromoStyle, PromoVideoInfo } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { REPO_ROOT } from '../app-config'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { readRegular } from '../files/store'
import { sceneTimes, type PromoDoc } from './layout'
import { pictureExt, teamPathOf } from './spec'
import { PROMO_FONT_FILE, renderDocument } from './template'

/** The pinned HyperFrames release (versions.json "hyperframes"; scripts/promo-video/hyperframes/package-lock.json). */
export const HYPERFRAMES_VERSION = '0.9.15'
export const PROMO_FONT_PATH = path.join(REPO_ROOT, 'resources', 'promo-video', 'fonts', PROMO_FONT_FILE)
const RENDER_TIMEOUT_MS = 4 * 60_000

export const hyperframesDir = () => process.env.MYCEL_HYPERFRAMES_DIR || path.join(os.homedir(), '.cache', 'mycel', `hyperframes-${HYPERFRAMES_VERSION}`)
const cliPath = () => path.join(hyperframesDir(), 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')

interface Row { artifact_id: string; chat_id: string; user_id: string; spec: string; mp4_state: PromoMp4State; mp4_ms: number | null; mp4_bytes: number | null; created_at: string }
export interface StoredSpec { title: string; sources: string[]; doc: PromoDoc }

/** Can this server make the MP4? (Read for every info answer: an install or a removal shows without a restart.) */
export function mp4Available(ctx: Pick<AppContext, 'config'>): boolean {
  if (ctx.config.mode !== 'dev' || ctx.config.office || ctx.config.deployment === 'hosted') return false
  if (process.platform !== 'darwin') return false
  return !!Bun.which('node') && fs.existsSync(cliPath()) && fs.existsSync(PROMO_FONT_PATH)
}

const videoDir = (ctx: AppContext) => path.join(ctx.engineConfig.dataDir, 'promo-videos')
const videoFile = (ctx: AppContext, id: string) => path.join(videoDir(ctx), `${id}.mp4`)

/** The caller's own promo video (by its artifact id), or 404. */
function ownRow(ctx: AppContext, userId: string, id: string): Row {
  const r = ctx.db.query(`SELECT p.artifact_id, p.chat_id, p.user_id, p.spec, p.mp4_state, p.mp4_ms, p.mp4_bytes, p.created_at
    FROM promo_videos p JOIN chats c ON c.id = p.chat_id WHERE p.artifact_id = ? AND c.user_id = ? AND c.deleted_at IS NULL`).get(id, userId) as Row | null
  if (!r) throw new HttpError('not_found')
  return r
}

function info(ctx: AppContext, r: Row): PromoVideoInfo {
  const spec = JSON.parse(r.spec) as StoredSpec
  // a render that a restart cut off is not running any more
  const state: PromoMp4State = r.mp4_state === 'rendering' && !running.has(r.artifact_id) ? 'failed' : r.mp4_state === 'done' && !fs.existsSync(videoFile(ctx, r.artifact_id)) ? 'none' : r.mp4_state
  return {
    artifactId: r.artifact_id, chatId: r.chat_id, title: spec.title, style: spec.doc.style as PromoStyle, duration: sceneTimes().duration,
    mp4: { available: mp4Available(ctx), state, seconds: r.mp4_ms === null ? null : Math.round(r.mp4_ms / 100) / 10, bytes: r.mp4_bytes },
  }
}

export const promoVideoInfo = (ctx: AppContext, userId: string, id: string) => info(ctx, ownRow(ctx, userId, id))

const running = new Set<string>()
let queue: Promise<void> = Promise.resolve()

/** Start the MP4 (one render at a time on the server); a finished one is kept. */
export function renderPromoVideo(ctx: AppContext, userId: string, id: string): PromoVideoInfo {
  const r = ownRow(ctx, userId, id)
  if (!mp4Available(ctx)) throw new HttpError('not_found')
  const now = info(ctx, r)
  if (now.mp4.state === 'done' || now.mp4.state === 'rendering') return now
  ctx.db.query("UPDATE promo_videos SET mp4_state = 'rendering', mp4_error = NULL WHERE artifact_id = ?").run(id)
  running.add(id)
  queue = queue.then(() => renderNow(ctx, r)).catch(() => {}).finally(() => running.delete(id))
  return promoVideoInfo(ctx, userId, id)
}

async function renderNow(ctx: AppContext, r: Row): Promise<void> {
  const started = Date.now()
  const spec = JSON.parse(r.spec) as StoredSpec
  fs.mkdirSync(videoDir(ctx), { recursive: true })
  const work = fs.mkdtempSync(path.join(videoDir(ctx), 'work-'))
  const fail = (why: string) => ctx.db.query("UPDATE promo_videos SET mp4_state = 'failed', mp4_error = ?, mp4_ms = ? WHERE artifact_id = ?").run(why.slice(0, 500), Date.now() - started, r.artifact_id)
  try {
    // the pictures, read now with the chat owner's own permissions (a picture they can no longer read is left out)
    const user = ctx.files.principal(r.user_id)
    fs.mkdirSync(path.join(work, 'img'))
    fs.mkdirSync(path.join(work, 'fonts'))
    fs.copyFileSync(PROMO_FONT_PATH, path.join(work, 'fonts', PROMO_FONT_FILE))
    let n = 0
    const local = (src: string): string | null => {
      try {
        const a = authorize(ctx.files.fx, ctx.files.rules(), user, teamPathOf(src), 'read', { mustExist: true })
        const name = `img/${++n}.${pictureExt(a.rel)}`
        fs.writeFileSync(path.join(work, name), readRegular(a.abs, 20 * 1024 * 1024).bytes)
        return name
      } catch { return null }
    }
    const doc: PromoDoc = {
      ...spec.doc,
      logo: spec.doc.logo ? (() => { const s = local(spec.doc.logo!.src); return s ? { ...spec.doc.logo!, src: s } : null })() : null,
      scenes: spec.doc.scenes.map((s) => {
        if (!s.picture) return s
        const src = local(s.picture.src)
        return { ...s, picture: src ? { ...s.picture, src } : null }
      }),
    }
    fs.writeFileSync(path.join(work, 'index.html'), renderDocument(doc, `fonts/${PROMO_FONT_FILE}`))
    const out = videoFile(ctx, r.artifact_id)
    const part = `${out}.part.mp4`
    fs.rmSync(part, { force: true })
    const code = await runCli(['render', work, '--output', part, '--fps', '30', '--quiet'], ctx)
    if (code !== 0 || !fs.existsSync(part)) return void fail(`hyperframes exit ${code}`)
    fs.renameSync(part, out)
    ctx.db.query("UPDATE promo_videos SET mp4_state = 'done', mp4_ms = ?, mp4_bytes = ?, rendered_at = ? WHERE artifact_id = ?")
      .run(Date.now() - started, fs.statSync(out).size, new Date().toISOString(), r.artifact_id)
    ctx.log.info('promo video rendered', { artifact: r.artifact_id, ms: Date.now() - started })
  } catch (err) {
    ctx.log.warn('promo video render failed', { err })
    fail(err instanceof Error ? err.message : 'error')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** The CLI with Node, its output to the log only (the last lines on a failure). */
function runCli(args: string[], ctx: AppContext): Promise<number | null> {
  return new Promise((resolve) => {
    const node = Bun.which('node')!
    const p = spawn(node, [cliPath(), ...args], {
      cwd: hyperframesDir(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.homedir(), HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_SKIP_SKILLS: '1', ...(process.env.HYPERFRAMES_BROWSER_PATH ? { HYPERFRAMES_BROWSER_PATH: process.env.HYPERFRAMES_BROWSER_PATH } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    const keep = (b: Buffer) => { tail = (tail + b.toString('utf8')).slice(-4000) }
    p.stdout.on('data', keep)
    p.stderr.on('data', keep)
    const timer = setTimeout(() => p.kill('SIGKILL'), RENDER_TIMEOUT_MS)
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) ctx.log.warn('hyperframes render failed', { code, tail: tail.slice(-1500) })
      resolve(code)
    })
    p.on('error', () => { clearTimeout(timer); resolve(null) })
  })
}

/** The finished MP4 of the caller's promo video. */
export function promoVideoFile(ctx: AppContext, userId: string, id: string): { abs: string; name: string } {
  const r = ownRow(ctx, userId, id)
  const abs = videoFile(ctx, id)
  if (r.mp4_state !== 'done' || !fs.existsSync(abs)) throw new HttpError('not_found')
  const title = (JSON.parse(r.spec) as StoredSpec).title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'promo'
  return { abs, name: `${title}.mp4` }
}
