// The MP4 of a promo video (docs/DECISIONS.md "V"): the same composition the chat plays, rendered with the HyperFrames
// CLI (headless Chrome + FFmpeg). Where this server can do it:
// - a development server on macOS (`mode: "dev"`, not office mode, not hosted) with the pinned CLI installed by
//   `bun scripts/promo-video/install-hyperframes.ts` (a vendored tool folder with its own lock file, outside the
//   repository's dependencies: ~/.cache/mycel/hyperframes-<version>, or MYCEL_HYPERFRAMES_DIR) and Node 22 or newer;
// - nowhere else yet: on a Linux team server the render belongs in the srt dev environment as a queued job, once its
//   image carries chrome-headless-shell and the CLI (the handoff in DECISIONS "V"). Until then the button is not shown.
// The render is built from the checked slots in promo_videos (never from the artifact's HTML, which `artifact update`
// could change): the pictures are copied out of the team folder with the chat owner's own permissions at render time,
// the font and the sounds from the repository. One render at a time on the server; a finished MP4 is kept next to the data and given
// again until the video changes. It goes when its chat is purged (chat/forget.ts → forgetPromoVideos).
// The CLI runs in a process group of its own; at the time limit, and when the server shuts down, that group and the
// group of every process under it (Chrome starts in its own) are killed by process id, never by a name pattern.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PromoMp4State, PromoVideoInfo } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { REPO_ROOT } from '../app-config'
import { HttpError } from '../http/errors'
import { authorize } from '../policy/authorize'
import { readRegular } from '../files/store'
import { AUDIO_DIR, audioCues, soundDuration } from './audio'
import { DURATION, type VideoDoc } from './layout'
import { pictureExt, teamPathOf } from './spec'
import { PROMO_FONT_FILE, renderDocument } from './template'

/** The pinned HyperFrames release (versions.json "hyperframes"; scripts/promo-video/hyperframes/package-lock.json). */
export const HYPERFRAMES_VERSION = '0.9.15'
export const PROMO_FONT_PATH = path.join(REPO_ROOT, 'resources', 'promo-video', 'fonts', PROMO_FONT_FILE)
let renderTimeoutMs = 4 * 60_000
/** Tests shorten the time limit (null: back to 4 minutes). */
export function setRenderTimeoutForTests(ms: number | null) { renderTimeoutMs = ms ?? 4 * 60_000 }

export const hyperframesDir = () => process.env.MYCEL_HYPERFRAMES_DIR || path.join(os.homedir(), '.cache', 'mycel', `hyperframes-${HYPERFRAMES_VERSION}`)
const cliPath = () => path.join(hyperframesDir(), 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')

interface Row { artifact_id: string; chat_id: string; user_id: string; spec: string; mp4_state: PromoMp4State; mp4_ms: number | null; mp4_bytes: number | null; created_at: string }
export interface StoredSpec { title: string; sources: string[]; doc: VideoDoc }

/** Can this server make the MP4? (Read for every info answer: an install or a removal shows without a restart.) */
export function mp4Available(ctx: Pick<AppContext, 'config'>): boolean {
  if (ctx.config.mode !== 'dev' || ctx.config.office || ctx.config.deployment === 'hosted') return false
  if (process.platform !== 'darwin') return false
  return !!Bun.which('node') && fs.existsSync(cliPath()) && fs.existsSync(PROMO_FONT_PATH) && fs.existsSync(AUDIO_DIR)
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
    artifactId: r.artifact_id, chatId: r.chat_id, title: spec.title, style: spec.doc.family, duration: DURATION,
    mp4: { available: mp4Available(ctx), state, seconds: r.mp4_ms === null ? null : Math.round(r.mp4_ms / 100) / 10, bytes: r.mp4_bytes },
  }
}

export const promoVideoInfo = (ctx: AppContext, userId: string, id: string) => info(ctx, ownRow(ctx, userId, id))

const running = new Set<string>()
let queue: Promise<void> = Promise.resolve()
/** the CLI processes running now, each with the end of its exit */
const live = new Map<ChildProcess, Promise<void>>()
const hooked = new WeakSet<object>()
/** servers shutting down: renders still waiting in the queue do not start */
const stopping = new WeakSet<object>()

/** Start the MP4 (one render at a time on the server); a finished one is kept. */
export function renderPromoVideo(ctx: AppContext, userId: string, id: string): PromoVideoInfo {
  const r = ownRow(ctx, userId, id)
  if (!mp4Available(ctx)) throw new HttpError('not_found')
  const now = info(ctx, r)
  if (now.mp4.state === 'done' || now.mp4.state === 'rendering') return now
  // a shutdown ends a render and its browser with the server (they run in process groups of their own)
  if (!hooked.has(ctx)) {
    hooked.add(ctx)
    ctx.onClose(async () => {
      stopping.add(ctx)
      const exits = [...live.entries()].map(([p, done]) => { if (p.pid) killTree(p.pid); return done })
      await Promise.race([Promise.all(exits), Bun.sleep(3000)])
    })
  }
  ctx.db.query("UPDATE promo_videos SET mp4_state = 'rendering', mp4_error = NULL WHERE artifact_id = ?").run(id)
  running.add(id)
  queue = queue.then(() => renderNow(ctx, r)).catch(() => {}).finally(() => running.delete(id))
  return promoVideoInfo(ctx, userId, id)
}

async function renderNow(ctx: AppContext, r: Row): Promise<void> {
  // the server is shutting down: left as it is (after a restart the row reads as failed, nothing runs it)
  if (stopping.has(ctx)) return
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
    const pic = <T extends { src: string }>(p: T | null): T | null => { if (!p) return null; const src = local(p.src); return src ? { ...p, src } : null }
    const d = spec.doc
    const doc: VideoDoc = {
      ...d,
      logo: pic(d.logo),
      promise: { ...d.promise, picture: pic(d.promise.picture) },
      work: { ...d.work, picture: pic(d.work.picture) },
      proof: { ...d.proof, picture: pic(d.proof.picture) },
    }
    // the sounds this video uses, from the repository
    const cues = audioCues(doc)
    fs.mkdirSync(path.join(work, 'audio'))
    for (const name of new Set(cues.map((c) => c.file))) fs.copyFileSync(path.join(AUDIO_DIR, `${name}.m4a`), path.join(work, 'audio', `${name}.m4a`))
    fs.writeFileSync(path.join(work, 'index.html'), renderDocument(doc, `fonts/${PROMO_FONT_FILE}`, { cues, url: (f) => `audio/${f}.m4a`, durationOf: soundDuration }))
    const out = videoFile(ctx, r.artifact_id)
    const part = `${out}.part.mp4`
    fs.rmSync(part, { force: true })
    const code = await runCli(['render', work, '--output', part, '--fps', '30', '--quiet'], ctx)
    if (code !== 0 || !fs.existsSync(part)) return void fail(`hyperframes exit ${code}`)
    fs.renameSync(part, out)
    const saved = ctx.db.query("UPDATE promo_videos SET mp4_state = 'done', mp4_ms = ?, mp4_bytes = ?, rendered_at = ? WHERE artifact_id = ?")
      .run(Date.now() - started, fs.statSync(out).size, new Date().toISOString(), r.artifact_id)
    // its chat was purged meanwhile: nothing would ever give or remove this file
    if (!saved.changes) fs.rmSync(out, { force: true })
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
      // its own process group: the time limit and a shutdown end it with everything it started
      detached: true,
    })
    let tail = ''
    const keep = (b: Buffer) => { tail = (tail + b.toString('utf8')).slice(-4000) }
    p.stdout?.on('data', keep)
    p.stderr?.on('data', keep)
    let exited!: () => void
    live.set(p, new Promise<void>((r) => { exited = r }))
    const end = (code: number | null) => {
      clearTimeout(timer)
      live.delete(p)
      exited()
      resolve(code)
    }
    const timer = setTimeout(() => {
      ctx.log.warn('hyperframes render timed out', { ms: renderTimeoutMs })
      if (p.pid) killTree(p.pid)
    }, renderTimeoutMs)
    p.on('close', (code) => {
      if (code !== 0) ctx.log.warn('hyperframes render failed', { code, tail: tail.slice(-1500) })
      end(code)
    })
    p.on('error', () => end(null))
  })
}

/** Kill a process and everything under it, by process id: its own group (it was started detached) and the group of
 * each process under it that leads one (puppeteer starts Chrome in a group of its own, so killing the CLI's group
 * alone would leave the browser running), then each of those processes. The tree is read once, before any kill (a
 * killed parent's children move to init and could not be found after). Never by a name pattern. */
export function killTree(pid: number): void {
  const tree = descendants(pid)
  const groups = new Set([pid, ...tree.filter((x) => x.pgid === x.pid).map((x) => x.pid)])
  for (const g of groups) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } }
  for (const x of [{ pid }, ...tree]) { try { process.kill(x.pid, 'SIGKILL') } catch { /* gone */ } }
}

/** Every process under `root` (children, their children…), from one `ps` listing. */
function descendants(root: number): { pid: number; pgid: number }[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5000 })
  if (r.status !== 0 || !r.stdout) return []
  const byParent = new Map<number, { pid: number; pgid: number }[]>()
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (!pid || ppid === undefined || pgid === undefined || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue
    const kids = byParent.get(ppid)
    if (kids) kids.push({ pid, pgid })
    else byParent.set(ppid, [{ pid, pgid }])
  }
  const out: { pid: number; pgid: number }[] = []
  const seen = new Set([root])
  for (let i = -1; i < out.length; i++) {
    for (const c of byParent.get(i < 0 ? root : out[i]!.pid) ?? []) if (!seen.has(c.pid)) { seen.add(c.pid); out.push(c) }
  }
  return out
}

/** What purged chats left of their promo videos (chat/forget.ts, after their rows are gone: a promo_videos row goes
 * with its artifact and its chat): every MP4, and a cut-off render's part file, whose row is not there any more. A
 * render running now keeps its files; one that ends after its chat went removes its MP4 itself (renderNow). */
export function forgetPromoVideos(ctx: AppContext): void {
  const dir = videoDir(ctx)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return }
  const known = ctx.db.query('SELECT 1 FROM promo_videos WHERE artifact_id = ?')
  for (const name of names) {
    const id = /^(.+?)\.mp4(?:\.part\.mp4)?$/.exec(name)?.[1]
    if (!id || running.has(id) || known.get(id)) continue
    try { fs.rmSync(path.join(dir, name), { force: true }) } catch (err) { ctx.log.warn('promo video file not removed', { name, err }) }
  }
}

/** The finished MP4 of the caller's promo video. */
export function promoVideoFile(ctx: AppContext, userId: string, id: string): { abs: string; name: string } {
  const r = ownRow(ctx, userId, id)
  const abs = videoFile(ctx, id)
  if (r.mp4_state !== 'done' || !fs.existsSync(abs)) throw new HttpError('not_found')
  const title = (JSON.parse(r.spec) as StoredSpec).title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'promo'
  return { abs, name: `${title}.mp4` }
}
