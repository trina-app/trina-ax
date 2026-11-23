// The MP4 of a promo video (docs/DECISIONS.md "V"): the same composition the chat plays, rendered with the HyperFrames
// CLI (headless Chrome + FFmpeg). Where this server can do it:
// - a Linux team server (hosted, install-linux.sh, Docker with the video group; any mode) with the list's video group
//   (scripts/system/packages.json: node in /opt/trina/node, the pinned CLI in /opt/trina/hyperframes/current, installed by
//   packages.sh pk_video_install) and the browser and media groups (chrome-headless-shell, ffmpeg). The CLI runs in the
//   converters' isolation (bwrap: no network, the system read-only, only its work folder writable), in a cgroup leaf of
//   its own in production (system/cgroups.ts S/video), with one worker (docs/decisions/20261123-linux-video-mp4.md);
// - a development server on macOS (`mode: "dev"`, not office mode, not hosted) with the pinned CLI installed by
//   `bun scripts/promo-video/install-hyperframes.ts` (a vendored tool folder with its own lock file, outside the
//   repository's dependencies: ~/.cache/mycel/hyperframes-<version>, or MYCEL_HYPERFRAMES_DIR) and Node 22 or newer.
// Anywhere else the info says why (mp4.why), and the panel says so instead of the button.
// The render is built from the checked slots in promo_videos (never from the artifact's HTML, which `artifact update`
// could change): the pictures are copied out of the team folder with the chat owner's own permissions at render time,
// the font and the sounds from the repository. One render at a time on the server; a finished MP4 is kept next to the data and given
// again until the video changes. It goes when its chat is purged (chat/forget.ts → forgetPromoVideos).
// The CLI runs in a process group of its own; at the time limit, and when the server shuts down, that group and the
// group of every process under it (Chrome starts in its own) are killed by process id, never by a name pattern.
import { componentC } from '../team-files/component'
import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from '../system/kill-tree'
import { killPrintLeaf, makeVideoLeaf, videoCgroupState } from '../system/cgroups'
import { browserHome, findPdfBrowser, trustedBrowser } from '../files/html-pdf'
import { isolatedCommand, isolation, type IsolationKind } from '../tools/isolate'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PromoMp4State, PromoVideoInfo } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { REPO_ROOT } from '../app-config'
import { HttpError } from '../http/errors'
import { chatFor } from '../chat/shared'
import { getChatRuntime } from '../chat/runtime'
import { authorize } from '../policy/authorize'
import { readRegular } from '../files/store'
import { AUDIO_DIR, audioCues, soundDuration } from './audio'
import { DURATION, type VideoDoc } from './layout'
import { pictureExt, teamPathOf } from './spec'
import { PROMO_FONT_FILE, renderDocument } from './template'

/** The pinned HyperFrames release (versions.json "hyperframes"; scripts/promo-video/hyperframes/package-lock.json). */
export const HYPERFRAMES_VERSION = '0.9.15'
export const PROMO_FONT_PATH = path.join(REPO_ROOT, 'resources', 'promo-video', 'fonts', PROMO_FONT_FILE)
/** the time limit: 4 minutes on a Mac; 8 on Linux, where a small team VM renders with one worker on two cores */
const defaultTimeout = () => (process.platform === 'linux' ? 8 : 4) * 60_000
let renderTimeoutMs: number | null = null
/** Tests shorten the time limit (null: back to the default). */
export function setRenderTimeoutForTests(ms: number | null) { renderTimeoutMs = ms }

/** Where the list's video group puts node and the CLI on Linux (scripts/system/packages.sh pk_node_install,
 * pk_video_install): root's, one per machine. */
export const LINUX_NODE = '/opt/trina/node/bin/node'
export const LINUX_HYPERFRAMES = '/opt/trina/hyperframes/current'
export const hyperframesDir = (platform: NodeJS.Platform = process.platform) => process.env.MYCEL_HYPERFRAMES_DIR
  || (platform === 'linux' ? LINUX_HYPERFRAMES : path.join(os.homedir(), '.cache', 'mycel', `hyperframes-${HYPERFRAMES_VERSION}`))
const cliIn = (dir: string) => path.join(dir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')

/** What runs a render here: node, the CLI (real paths), the tree it is in, and on Linux the browser and the isolation. */
export interface RenderTools { node: string; cli: string; dir: string; browser: string | null; isolated: boolean }
export type Mp4Why = 'not_installed' | 'too_small' | 'unsupported'
/** a file the server may run: it and every folder above it are root's or the server's, and nobody else can write them
 * (html-pdf.ts trustedBrowser: the CLI tree and node are root's in /opt/trina) */
const trusted = (p: string) => { try { return fs.statSync(p).isFile() && trustedBrowser(p) } catch { return false } }
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return null } }

/** The tools of a render on this server, or why there is none. Read for every info answer (an install or a removal
 * shows without a restart); `platform` and `env` for the tests. */
export function renderTools(ctx: Pick<AppContext, 'config'>, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; isolation?: IsolationKind; uid?: number; ffmpeg?: readonly string[] } = {}): { tools: RenderTools } | { why: Mp4Why } {
  const platform = o.platform ?? process.platform, env = o.env ?? process.env
  if (!fs.existsSync(PROMO_FONT_PATH) || !fs.existsSync(AUDIO_DIR)) return { why: 'unsupported' }
  if (platform === 'darwin') {
    // a development Mac only: the CLI runs without isolation there, as the developer
    if (ctx.config.mode !== 'dev' || ctx.config.office || ctx.config.deployment === 'hosted') return { why: 'unsupported' }
    const node = Bun.which('node'), dir = env.MYCEL_HYPERFRAMES_DIR || hyperframesDir(platform)
    if (!node || !fs.existsSync(cliIn(dir))) return { why: 'not_installed' }
    return { tools: { node, cli: cliIn(dir), dir, browser: env.HYPERFRAMES_BROWSER_PATH || null, isolated: false } }
  }
  if (platform !== 'linux' || ctx.config.office) return { why: 'unsupported' }
  // the browser runs without a sandbox of its own (HyperFrames starts it with --no-sandbox): only inside bwrap, never as
  // root (html-pdf.ts htmlPdfUnavailable, the same rule)
  if ((o.isolation ?? isolation()) !== 'bwrap' || (o.uid ?? process.getuid?.()) === 0) return { why: 'unsupported' }
  if (videoCgroupState() === 'too_small') return { why: 'too_small' }
  const node = real(env.MYCEL_HYPERFRAMES_NODE || LINUX_NODE), dir = real(env.MYCEL_HYPERFRAMES_DIR || hyperframesDir(platform))
  const cli = dir ? real(cliIn(dir)) : null
  if (!node || !trusted(node) || !dir || !cli || !cli.startsWith(dir + '/') || !trusted(cli)) return { why: 'not_installed' }
  const browser = findPdfBrowser(env, 'linux')
  // ffmpeg from the media group (the CLI finds it on the isolation's PATH, /usr/bin:/bin)
  if (!browser || !(o.ffmpeg ?? ['/usr/bin/ffmpeg', '/bin/ffmpeg']).some((f) => fs.existsSync(f))) return { why: 'not_installed' }
  return { tools: { node, cli, dir, browser, isolated: true } }
}

interface Row { artifact_id: string; chat_id: string; user_id: string; owner_id: string; spec: string; mp4_state: PromoMp4State; mp4_ms: number | null; mp4_bytes: number | null; created_at: string }
export interface StoredSpec { title: string; sources: string[]; doc: VideoDoc }

/** Can this server make the MP4? (Read for every info answer: an install or a removal shows without a restart.) */
export function mp4Available(ctx: Pick<AppContext, 'config'>): boolean {
  return 'tools' in renderTools(ctx)
}
/** The reason in the AI's words (promo_video's result, save_promo_video's refusal). */
export function noFileReason(why: Mp4Why): string {
  return why === 'not_installed' ? 'the video tools are not installed on this server yet; the next server update installs them'
    : why === 'too_small' ? 'this server has too little memory to make a video file'
    : 'this kind of server does not make video files'
}
/** Why this server cannot make the MP4, or null when it can. */
export function mp4Why(ctx: Pick<AppContext, 'config'>): Mp4Why | null {
  const t = renderTools(ctx)
  return 'why' in t ? t.why : null
}

const videoDir = (ctx: AppContext) => path.join(ctx.engineConfig.dataDir, 'promo-videos')
const videoFile = (ctx: AppContext, id: string) => path.join(videoDir(ctx), `${id}.mp4`)

/** A promo video (by its artifact id) for someone who may open its chat (chat/shared.ts chatFor 'view': the owner, or a
 * person a shared chat is shared with; QA TC-r2a-06: they play it, so they may download it too), or 404. Anyone but
 * the chat's owner also needs to open every picture it shows themselves: the MP4 is made with the owner's permissions
 * (renderNow), and their own player shows only the pictures they may open. */
function rowFor(ctx: AppContext, userId: string, id: string): Row {
  const r = ctx.db.query(`SELECT p.artifact_id, p.chat_id, p.user_id, c.user_id AS owner_id, p.spec, p.mp4_state, p.mp4_ms, p.mp4_bytes, p.created_at
    FROM promo_videos p JOIN chats c ON c.id = p.chat_id WHERE p.artifact_id = ? AND c.deleted_at IS NULL`).get(id) as Row | null
  if (!r) throw new HttpError('not_found')
  // a version an answer hidden from this person made (Artifacts.hiddenVersions; review of batch 2): not theirs to play
  // or save, the chat's owner included (a shared chat's later member's hidden answer)
  if (componentC(ctx).artifacts.hiddenVersions(userId, r.chat_id).has(r.artifact_id)) throw new HttpError('not_found')
  if (r.owner_id === userId) return r
  try { chatFor(getChatRuntime(ctx), userId, r.chat_id, 'view') } catch { throw new HttpError('not_found') }
  const user = ctx.files.principal(userId)
  const d = (JSON.parse(r.spec) as StoredSpec).doc
  for (const p of [d.logo, d.promise.picture, d.work.picture, d.proof.picture]) {
    if (!p) continue
    // (mustExist false: a picture gone since is left out of the owner's render too, never a reason to refuse)
    try { authorize(ctx.files.fx, ctx.files.rules(), user, teamPathOf(p.src), 'read', { mustExist: false }) } catch { throw new HttpError('not_found') }
  }
  return r
}

function info(ctx: AppContext, r: Row): PromoVideoInfo {
  const spec = JSON.parse(r.spec) as StoredSpec
  // a render that a restart cut off is not running any more
  const why = mp4Why(ctx)
  const state: PromoMp4State = r.mp4_state === 'rendering' && !running.has(r.artifact_id) ? 'failed' : r.mp4_state === 'done' && !fs.existsSync(videoFile(ctx, r.artifact_id)) ? 'none' : r.mp4_state
  return {
    artifactId: r.artifact_id, chatId: r.chat_id, title: spec.title, style: spec.doc.family, duration: DURATION,
    mp4: { available: why === null, why, state, seconds: r.mp4_ms === null ? null : Math.round(r.mp4_ms / 100) / 10, bytes: r.mp4_bytes },
  }
}

export const promoVideoInfo = (ctx: AppContext, userId: string, id: string) => info(ctx, rowFor(ctx, userId, id))

const running = new Set<string>()
let queue: Promise<void> = Promise.resolve()
/** the CLI processes running now, each with the end of its exit */
const live = new Map<ChildProcess, Promise<void>>()
const hooked = new WeakSet<object>()
/** servers shutting down: renders still waiting in the queue do not start */
const stopping = new WeakSet<object>()

/** Start the MP4 (one render at a time on the server); a finished one is kept. */
export function renderPromoVideo(ctx: AppContext, userId: string, id: string): PromoVideoInfo {
  const r = rowFor(ctx, userId, id)
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
  const found = renderTools(ctx)
  if (!('tools' in found)) {
    ctx.db.query("UPDATE promo_videos SET mp4_state = 'failed', mp4_error = ?, mp4_ms = 0 WHERE artifact_id = ?").run(`no render here (${found.why})`, r.artifact_id)
    return
  }
  const spec = JSON.parse(r.spec) as StoredSpec
  fs.mkdirSync(videoDir(ctx), { recursive: true })
  const work = fs.mkdtempSync(path.join(videoDir(ctx), 'work-'))
  const part = `${videoFile(ctx, r.artifact_id)}.part.mp4`
  // a failed render leaves no part file behind
  const fail = (why: string) => { fs.rmSync(part, { force: true }); return ctx.db.query("UPDATE promo_videos SET mp4_state = 'failed', mp4_error = ?, mp4_ms = ? WHERE artifact_id = ?").run(why.slice(0, 500), Date.now() - started, r.artifact_id) }
  try {
    // the pictures, read now with the chat owner's own permissions (a picture they can no longer read is left out);
    // the owner of the chat, not whoever's turn made the video (the same person today; a shared room may differ)
    const user = ctx.files.principal(r.owner_id)
    fs.mkdirSync(path.join(work, 'img'))
    fs.mkdirSync(path.join(work, 'fonts'))
    fs.copyFileSync(PROMO_FONT_PATH, path.join(work, 'fonts', PROMO_FONT_FILE))
    let n = 0
    const local = (src: string): string | null => {
      try {
        const a = authorize(ctx.files.fx, ctx.files.rules(), user, teamPathOf(src), 'read', { mustExist: true })
        const name = `img/${++n}.${pictureExt(a.rel)}`
        fs.writeFileSync(path.join(work, name), readRegular(a.abs, 20 * 1024 * 1024, a.st).bytes)
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
    fs.rmSync(part, { force: true })
    // written inside the work folder (on Linux the only place the isolated CLI may write), then moved next to the data
    const made = path.join(work, 'out.mp4')
    const code = await runCli(found.tools, work, ['render', work, '--output', made, '--fps', '30', '--quiet', ...(found.tools.isolated ? ['--workers', '1'] : [])], ctx)
    let ok = false
    try { const st = fs.lstatSync(made); ok = st.isFile() && st.size > 0 } catch { /* none */ }
    if (code !== 0 || !ok) return void fail(`hyperframes exit ${code}`)
    fs.copyFileSync(made, part)
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

const QUIET_ENV = { HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_SKIP_SKILLS: '1' }

/** The CLI with Node, its output to the log only (the last lines on a failure). On Linux inside bwrap (isolatedCommand:
 * HOME and TMPDIR in the work folder, no network; the tree, node and the browser's folder read-only) and in a leaf of
 * S/video when the server has cgroups; on a development Mac as the developer, as before. */
async function runCli(t: RenderTools, work: string, args: string[], ctx: AppContext): Promise<number | null> {
  const timeoutMs = renderTimeoutMs ?? defaultTimeout()
  let argv: string[], env: Record<string, string>, cwd: string
  let leaf: string | null = null
  if (t.isolated) {
    try { leaf = makeVideoLeaf() } catch (e) { ctx.log.warn('promo video cgroup leaf not made', { err: e }); return null }
    const c = isolatedCommand({
      cmd: t.node, args: [t.cli, ...args], workDir: work,
      // the tree, node's own folder (bin/ and lib/) and the browser's folder (its libraries and resources)
      readPaths: [...new Set([t.dir, path.dirname(path.dirname(t.node)), ...(t.browser ? [browserHome(t.browser)] : [])])],
      env: { ...QUIET_ENV, ...(t.browser ? { HYPERFRAMES_BROWSER_PATH: t.browser } : {}) },
      timeoutMs, background: false, cpuThreads: Math.max(1, os.availableParallelism()),
      ...(leaf ? { cgroupLeaf: { dir: leaf, oomScoreAdj: 900 } } : {}),
    })
    argv = c.argv; env = c.env; cwd = work
  } else {
    argv = [t.node, t.cli, ...args]
    env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.homedir(), ...QUIET_ENV, ...(t.browser ? { HYPERFRAMES_BROWSER_PATH: t.browser } : {}) }
    cwd = t.dir
  }
  try { return await spawnCli(argv, env, cwd, timeoutMs, ctx) } finally { if (leaf) await killPrintLeaf(leaf) }
}

function spawnCli(argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number, ctx: AppContext): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(argv[0]!, argv.slice(1), {
      cwd, env,
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
      ctx.log.warn('hyperframes render timed out', { ms: timeoutMs })
      if (p.pid) killTree(p.pid)
    }, timeoutMs)
    p.on('close', (code) => {
      if (code !== 0) ctx.log.warn('hyperframes render failed', { code, tail: tail.slice(-1500) })
      end(code)
    })
    p.on('error', () => end(null))
  })
}

/** Kill a process and everything under it, by process id (system/kill-tree.ts; the HTML print uses it too). */
export { killTree }

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

/** The finished MP4 of a promo video the caller may open (rowFor). */
export function promoVideoFile(ctx: AppContext, userId: string, id: string): { abs: string; name: string } {
  const r = rowFor(ctx, userId, id)
  const abs = videoFile(ctx, id)
  if (r.mp4_state !== 'done' || !fs.existsSync(abs)) throw new HttpError('not_found')
  const title = (JSON.parse(r.spec) as StoredSpec).title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'promo'
  return { abs, name: `${title}.mp4` }
}
