// Office mode automatic updates (docs/OFFICE.md "자동 업데이트"). The third LaunchAgent of an installation,
// <label>.update (app.team-ax.office.update), runs `office.js update run` every night at the chosen time (default 03:00)
// and when someone asks (`teamax update now`, Admin > System "지금 업데이트": a request file + launchctl kickstart):
//
//   1. GET <feed>/office/<channel>.json (the only address contacted, https://updates.treesoop.com), verify the Ed25519
//      signature with a key baked into this build (./release.ts), the channel, no downgrade, not below minFrom
//   2. download the office zip, check its size and SHA-256, unpack it into update/staging/
//   3. the new bundle's own installer with --check-only, wait until no answer is running (10 min at most), a database
//      backup (admin.js backup --scope db --kind pre-update)
//   4. the new bundle's own installer with --update: it stops the agents, copies its app/ next to the old one, keeps
//      the old one as app.previous, swaps, starts the server and cloudflared again
//   5. /api/health on 127.0.0.1 must answer with the new version (and still after 15 s); otherwise roll back: stop
//      the agents, app -> app.failed, app.previous -> app, the old version's `office.js install`, wait for the old
//      version; that version is not tried again by the nightly run (`teamax update now` tries again)
//   6. the release's Windows desktop installer + latest.yml into data/downloads (index.json), so the desks' app
//      (electron-updater, generic provider) updates from the clinic's own Mac
//
// data/, team/, tls/ and config/ are never touched by an update (the installer keeps them; the rollback moves only
// app folders). The updater's own files live in <home>/update/: settings.json (channel, time, paused), state.json
// (what the web and `teamax update status` show), request.json (an "update now" waiting for the agent), lock, the
// download and the unpacked bundle. Its log is logs/update.log.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareVersions } from '../system/update'
import { CHANNELS, decide, DEFAULT_FEED, manifestUrl, OFFICE_RELEASE_KEYS, ReleaseError, verifyRelease, VERSION_RE, type Channel, type OfficeRelease, type ReleaseFile } from './release'
import { addInstaller, readIndex } from './desktop'
import { loadSettings, officePaths, type OfficeSettings } from './settings'
import { PRODUCT } from '@mycel/shared'

// ---- settings and state ------------------------------------------------------------------------------------------

export interface UpdateSettings {
  channel: Channel
  /** local time of the nightly check, HH:MM */
  time: string
  paused: boolean
  /** tests only: a feed on this Mac (http://127.0.0.1:<port>); anything else is ignored */
  feed?: string
}
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { channel: 'stable', time: '03:00', paused: false }
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export type UpdateStep = 'check' | 'download' | 'unpack' | 'precheck' | 'wait-idle' | 'backup' | 'install' | 'verify' | 'rollback'
export type ResultKind = 'up-to-date' | 'updated' | 'available' | 'rolled-back' | 'failed' | 'refused' | 'paused' | 'skipped'
export interface UpdateState {
  lastCheckAt: string | null
  /** what the last run (or check) found */
  last: { kind: ResultKind; at: string; version: string | null; message: string | null } | null
  /** a newer version on the feed that is not installed yet */
  available: { version: string; channel: Channel; notes: string; publishedAt: string } | null
  /** the last install attempt */
  lastUpdate: { from: string; to: string; at: string; result: 'updated' | 'rolled-back' | 'failed'; error: string | null } | null
  /** versions that failed and were rolled back: the nightly run does not try them again */
  failed: Record<string, { at: string; reason: string }>
  /** an update in progress (the agent's pid); step is what the web shows in the person's language */
  running: { pid: number; since: string; step: UpdateStep; phase: string; target: string | null } | null
  /** the Windows desktop app last put into data/downloads */
  desktop: { version: string; at: string } | null
}
const emptyState = (): UpdateState => ({ lastCheckAt: null, last: null, available: null, lastUpdate: null, failed: {}, running: null, desktop: null })

export interface UpdatePaths { dir: string; settings: string; state: string; request: string; lock: string; download: string; staging: string; log: string }
export function updatePaths(home: string): UpdatePaths {
  const dir = path.join(path.resolve(home), 'update')
  return {
    dir, settings: path.join(dir, 'settings.json'), state: path.join(dir, 'state.json'), request: path.join(dir, 'request.json'),
    lock: path.join(dir, 'lock'), download: path.join(dir, 'download'), staging: path.join(dir, 'staging'), log: path.join(path.resolve(home), 'logs', 'update.log'),
  }
}

function writeJson(file: string, v: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}
function readJson(file: string): unknown { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

/** a feed override is only honoured for this Mac (tests): the clinic's Mac never contacts anything but the feed */
export function feedOf(s: Pick<UpdateSettings, 'feed'>): string {
  const f = s.feed
  if (f && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(f)) return f
  return DEFAULT_FEED
}

export function readUpdateSettings(home: string): UpdateSettings {
  const raw = readJson(updatePaths(home).settings) as Partial<UpdateSettings> | null
  const s = { ...DEFAULT_UPDATE_SETTINGS }
  if (raw && typeof raw === 'object') {
    if (CHANNELS.includes(raw.channel as Channel)) s.channel = raw.channel as Channel
    if (typeof raw.time === 'string' && TIME_RE.test(raw.time)) s.time = raw.time
    if (typeof raw.paused === 'boolean') s.paused = raw.paused
    if (typeof raw.feed === 'string') s.feed = raw.feed
  }
  return s
}

export function writeUpdateSettings(home: string, patch: Partial<UpdateSettings>): UpdateSettings {
  if (patch.channel !== undefined && !CHANNELS.includes(patch.channel)) throw new Error(`channel must be stable or beta (got ${patch.channel})`)
  if (patch.time !== undefined && !TIME_RE.test(patch.time)) throw new Error(`time must be HH:MM, e.g. 03:00 (got ${patch.time})`)
  const next = { ...readUpdateSettings(home), ...patch }
  writeJson(updatePaths(home).settings, next)
  return next
}

export function readUpdateState(home: string): UpdateState {
  const raw = readJson(updatePaths(home).state) as Partial<UpdateState> | null
  const s = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) }
  if (!s.failed || typeof s.failed !== 'object') s.failed = {}
  // a run whose process is gone (power cut, killed) is not running any more
  if (s.running && !pidAlive(s.running.pid)) s.running = null
  return s
}

export function patchUpdateState(home: string, f: (s: UpdateState) => void): UpdateState {
  const s = readUpdateState(home)
  f(s)
  writeJson(updatePaths(home).state, s)
  return s
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The next nightly window after `now` (local time), or null while paused. */
export function nextWindow(time: string, now = new Date(), paused = false): Date | null {
  if (paused) return null
  const m = TIME_RE.exec(time) ?? TIME_RE.exec(DEFAULT_UPDATE_SETTINGS.time)!
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d
}

export const installedVersion = (home: string): string | null => {
  try { const v = fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim(); return v || null } catch { return null }
}

// ---- the LaunchAgent ---------------------------------------------------------------------------------------------

export const updateLabel = (s: Pick<OfficeSettings, 'label'>) => `${s.label}.update`

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The update agent: not kept alive, not run at load, a normal process (Background throttles disk I/O: unpacking the
 * zip took a minute, and "update now" is waited for); launchd starts it at the nightly time (and after a wake if the
 * Mac slept through it) and when kickstarted. PATH has Claude Code's folder (the new installer checks it). */
export function updatePlist(s: OfficeSettings, time: string, envPath: string): string {
  const m = TIME_RE.exec(time) ?? TIME_RE.exec(DEFAULT_UPDATE_SETTINGS.time)!
  const p = officePaths(s.home)
  const args = [path.join(s.home, 'app', 'bin', 'bun'), path.join(s.home, 'app', 'server', 'src', 'office.js'), 'update', 'run', '--home', s.home]
  const env: Record<string, string> = { PATH: envPath, HOME: os.homedir(), LANG: 'ko_KR.UTF-8', NO_COLOR: '1', TEAMAX_HOME: s.home, ...(s.claudeBin ? { TEAMAX_CLAUDE_BIN: s.claudeBin } : {}) }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(updateLabel(s))}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(s.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${Number(m[1])}</integer><key>Minute</key><integer>${Number(m[2])}</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>${xml(path.join(p.logs, 'update.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(p.logs, 'update.log'))}</string>
</dict>
</plist>
`
}

// ---- status (web, CLI) ---------------------------------------------------------------------------------------------

export interface OfficeUpdateView {
  current: string
  channel: Channel
  paused: boolean
  time: string
  nextWindowAt: string | null
  lastCheckAt: string | null
  last: UpdateState['last']
  available: UpdateState['available']
  lastUpdate: UpdateState['lastUpdate']
  running: { since: string; step: UpdateStep; phase: string; target: string | null } | null
  requested: boolean
  agentInstalled: boolean
  desktop: UpdateState['desktop']
}

export function updateView(home: string, o: { now?: Date; agentInstalled?: boolean } = {}): OfficeUpdateView {
  const set = readUpdateSettings(home)
  const st = readUpdateState(home)
  const current = installedVersion(home) ?? '?'
  const available = st.available && compareVersions(st.available.version, current) > 0 ? st.available : null
  const s = (() => { try { return loadSettings(home) } catch { return null } })()
  const agentInstalled = o.agentInstalled ?? (s ? fs.existsSync(officePaths(home).plist(updateLabel(s))) : false)
  const next = nextWindow(set.time, o.now ?? new Date(), set.paused)
  return {
    current, channel: set.channel, paused: set.paused, time: set.time, nextWindowAt: agentInstalled && next ? next.toISOString() : null,
    lastCheckAt: st.lastCheckAt, last: st.last, available, lastUpdate: st.lastUpdate,
    running: st.running ? { since: st.running.since, step: st.running.step ?? 'check', phase: st.running.phase, target: st.running.target } : null,
    requested: fs.existsSync(updatePaths(home).request), agentInstalled, desktop: st.desktop,
  }
}

/** "update now": a request file the agent takes on its next start (now, through launchctl kickstart). */
export function requestUpdate(home: string, by: string) {
  writeJson(updatePaths(home).request, { action: 'now', by: by.slice(0, 100), at: new Date().toISOString() })
}

/** take (and remove) a waiting request; requests older than a day are dropped */
export function takeRequest(home: string): { by: string; at: string } | null {
  const f = updatePaths(home).request
  const r = readJson(f) as { action?: string; by?: string; at?: string } | null
  fs.rmSync(f, { force: true })
  if (!r || r.action !== 'now' || typeof r.at !== 'string' || Date.now() - Date.parse(r.at) > 24 * 3600_000) return null
  return { by: String(r.by ?? ''), at: r.at }
}

// ---- the run -------------------------------------------------------------------------------------------------------

export interface Exec { code: number; out: string }
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
export interface UpdateDeps {
  fetch: FetchLike
  /** run a program; output goes to the log (and is returned when `capture`) */
  exec(cmd: string[], o: { cwd?: string; env?: Record<string, string>; capture?: boolean; timeoutMs?: number }): Promise<Exec>
  /** the version /api/health reports on 127.0.0.1:<port>, null when it does not answer */
  health(port: number): Promise<string | null>
  /** stop the server and cloudflared agents (rollback) */
  stopAgents(s: OfficeSettings): Promise<void>
  sleep(ms: number): Promise<void>
  log(line: string): void
  now(): Date
}

export const defaultDeps = (): UpdateDeps => ({
  fetch: (url, init) => fetch(url, init),
  async exec(cmd, o) {
    const p = Bun.spawn(cmd, { cwd: o.cwd, env: o.env, stdin: 'ignore', stdout: o.capture ? 'pipe' : 'inherit', stderr: o.capture ? 'pipe' : 'inherit' })
    const timer = o.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), o.timeoutMs) : null
    const [code, out, err] = await Promise.all([p.exited, o.capture ? new Response(p.stdout as ReadableStream).text() : '', o.capture ? new Response(p.stderr as ReadableStream).text() : ''])
    if (timer) clearTimeout(timer)
    return { code, out: (out + err).trim() }
  },
  async health(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (!r.ok) return null
      const j = (await r.json()) as { version?: unknown }
      return typeof j.version === 'string' ? j.version : null
    } catch { return null }
  },
  async stopAgents(s) {
    const uid = process.getuid?.() ?? 0
    for (const l of [`${s.label}.tunnel`, s.label]) Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}/${l}`], { stdout: 'ignore', stderr: 'ignore' })
    await Bun.sleep(1500)
  },
  sleep: (ms) => Bun.sleep(ms),
  log: (line) => console.log(`${new Date().toISOString()} [update] ${line}`),
  now: () => new Date(),
})

export class UpdateFailure extends Error { name = 'UpdateFailure' }
/** the channel has no release yet (404): nothing to install, not a failure */
export class NotPublished extends UpdateFailure { name = 'NotPublished' }

const MANIFEST_MAX = 256 * 1024
/** health after the switch: the new version must answer within this, then still answer STABLE_MS later */
export const HEALTH_WAIT_MS = 150_000
export const STABLE_MS = 15_000
export const IDLE_WAIT_MS = 10 * 60_000

export interface RunOptions {
  /** 'schedule' = the nightly run (honours pause and earlier failures); 'now' = asked for; 'check' = look only */
  reason: 'schedule' | 'now' | 'check'
  deps?: Partial<UpdateDeps>
  /** waits (tests make them short) */
  healthWaitMs?: number
  stableMs?: number
  idleWaitMs?: number
  /** release public keys (tests sign with their own) */
  keys?: readonly string[]
}
export interface RunResult { kind: ResultKind; version: string | null; message: string | null }

/** fetch and verify the channel's manifest */
export async function fetchRelease(home: string, d: Pick<UpdateDeps, 'fetch'>, keys: readonly string[] = OFFICE_RELEASE_KEYS): Promise<OfficeRelease> {
  const set = readUpdateSettings(home)
  const feed = feedOf(set)
  const url = manifestUrl(feed, set.channel)
  let res: Response
  try { res = await d.fetch(`${url}?t=${Date.now()}`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } }) } catch (e) { throw new UpdateFailure(`cannot reach ${feed}: ${(e as Error).message}`) }
  if (res.status === 404) throw new NotPublished(`no ${set.channel} release published yet`)
  if (!res.ok) throw new UpdateFailure(`${url}: HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > MANIFEST_MAX) throw new UpdateFailure(`${url} is larger than a manifest`)
  return verifyRelease(Buffer.from(buf).toString('utf8'), { keys, channel: set.channel, feed })
}

/** Download a release file into `dir`, checking size and SHA-256 on the way. Returns the file. */
export async function download(f: ReleaseFile, dir: string, d: Pick<UpdateDeps, 'fetch'>): Promise<string> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const dest = path.join(dir, f.file)
  if (fs.existsSync(dest) && fs.statSync(dest).size === f.size && sha256File(dest) === f.sha256) return dest // already here (an earlier try)
  const part = `${dest}.part`
  fs.rmSync(part, { force: true })
  let res: Response
  try { res = await d.fetch(f.url, { redirect: 'error', signal: AbortSignal.timeout(60 * 60_000) }) } catch (e) { throw new UpdateFailure(`download ${f.file}: ${(e as Error).message}`) }
  if (!res.ok || !res.body) throw new UpdateFailure(`download ${f.file}: HTTP ${res.status}`)
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(part, 'wx', 0o600)
  let n = 0
  try {
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      n += c.byteLength
      if (n > f.size) throw new UpdateFailure(`${f.file} is larger than the release says (${f.size} bytes)`)
      h.update(c)
      fs.writeSync(fd, c)
    }
  } catch (e) {
    fs.closeSync(fd); fs.rmSync(part, { force: true })
    throw e instanceof UpdateFailure ? e : new UpdateFailure(`download ${f.file}: ${(e as Error).message}`)
  }
  fs.closeSync(fd)
  const sha = h.digest('hex')
  if (n !== f.size || sha !== f.sha256) { fs.rmSync(part, { force: true }); throw new UpdateFailure(`${f.file} does not match the signed release (size ${n}/${f.size}, SHA-256 ${sha.slice(0, 12)}… / ${f.sha256.slice(0, 12)}…)`) }
  fs.renameSync(part, dest)
  return dest
}

export function sha256File(file: string, algo: 'sha256' | 'sha512' = 'sha256', enc: 'hex' | 'base64' = 'hex'): string {
  const h = crypto.createHash(algo)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    for (let pos = 0; ;) { const k = fs.readSync(fd, buf, 0, buf.length, pos); if (!k) break; h.update(buf.subarray(0, k)); pos += k }
  } finally { fs.closeSync(fd) }
  return h.digest(enc)
}

/** the office zip for this Mac (a universal one, else this processor's) */
export function pickOffice(r: OfficeRelease, arch = process.arch): ReleaseFile {
  const want = arch === 'arm64' ? 'arm64' : 'amd64'
  const f = r.office.find((x) => x.arch === 'universal') ?? r.office.find((x) => x.arch === want)
  if (!f) throw new UpdateFailure(`release ${r.version} has no office zip for this Mac (${want})`)
  return f
}

/** "<name>-office-<version>", name = letters, digits, . _ - (PRODUCT.officeBundle today; older or newer names too) */
export function isOfficeFolder(name: string, version: string): boolean {
  const suffix = `-office-${version}`
  return name.endsWith(suffix) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name.slice(0, -suffix.length))
}

/** Unpack the zip into staging/<version>; returns the bundle folder (with office-install.sh and app/). */
export async function unpack(zip: string, version: string, home: string, d: Pick<UpdateDeps, 'exec'>): Promise<string> {
  const base = path.join(updatePaths(home).staging, version)
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const r = await d.exec(['/usr/bin/ditto', '-x', '-k', zip, base], { capture: true, timeoutMs: 10 * 60_000 })
  if (r.code !== 0) throw new UpdateFailure(`unzip failed: ${r.out.slice(0, 500)}`)
  const top = fs.readdirSync(base).filter((n) => !n.startsWith('.') && n !== '__MACOSX')
  // one folder <name>-office-<version>: the name is PRODUCT.officeBundle, but any name is taken, so a renamed product's
  // zip still updates an office installed under the old name (the signed manifest is what is trusted, not the name)
  if (top.length !== 1 || !isOfficeFolder(top[0]!, version)) throw new UpdateFailure(`the zip does not hold ${PRODUCT.officeBundle}-${version}/ (found ${top.join(', ') || 'nothing'})`)
  const dir = path.join(base, top[0]!)
  const v = (() => { try { return fs.readFileSync(path.join(dir, 'app', 'VERSION'), 'utf8').trim() } catch { return '' } })()
  if (v !== version) throw new UpdateFailure(`the zip's app/VERSION is ${v || 'missing'}, the release says ${version}`)
  if (!fs.existsSync(path.join(dir, 'office-install.sh'))) throw new UpdateFailure('the zip has no office-install.sh')
  return dir
}

/** answers running on the server right now (status/status.json, written every 30 s); null = unknown */
export function runningAnswers(home: string, now = Date.now()): number | null {
  const j = readJson(path.join(home, 'status', 'status.json')) as { writtenAt?: string; queue?: { running?: number } } | null
  if (!j?.writtenAt || now - Date.parse(j.writtenAt) > 120_000) return null
  return typeof j.queue?.running === 'number' ? j.queue.running : null
}

function toolEnv(home: string): Record<string, string> {
  const p = officePaths(home)
  const env: Record<string, string> = { ...(process.env as Record<string, string>), MYCEL_CONFIG: p.serverJson, MYCEL_MODE: 'dev' }
  for (const k of Object.keys(env)) if (k.startsWith('BUN_') || k.startsWith('NODE_')) delete env[k]
  return env
}

/** Put the old app back and start it (after a failed install). Returns the version that answers, or null. */
export async function rollBack(home: string, from: string, to: string, d: UpdateDeps, healthWaitMs: number): Promise<string | null> {
  const s = loadSettings(home)
  d.log(`rolling back to ${from}`)
  await d.stopAgents(s)
  const app = path.join(home, 'app'), prev = path.join(home, 'app.previous'), failed = path.join(home, 'app.failed')
  if (installedVersion(home) !== from) {
    let prevVersion: string | null = null
    try { prevVersion = fs.readFileSync(path.join(prev, 'VERSION'), 'utf8').trim() } catch {}
    if (prevVersion !== from) throw new UpdateFailure(`cannot roll back: app.previous is ${prevVersion ?? 'missing'}, not ${from}`)
    fs.rmSync(failed, { recursive: true, force: true })
    if (fs.existsSync(app)) fs.renameSync(app, failed)
    fs.renameSync(prev, app)
    d.log(`app.failed = ${to}, app = ${from}`)
  }
  // the old version's own install (agent plist, server, cloudflared); it does not touch this agent (TEAMAX_UPDATE_RUN)
  const r = await d.exec([path.join(app, 'bin', 'bun'), path.join(app, 'server', 'src', 'office.js'), 'install', '--no-open', '--home', home], { cwd: home, env: { ...toolEnv(home), TEAMAX_UPDATE_RUN: '1' }, timeoutMs: 5 * 60_000 })
  if (r.code !== 0) d.log(`the old version's install exited ${r.code}`)
  return await waitVersion(s.appPort, from, d, healthWaitMs)
}

async function waitVersion(port: number, want: string, d: UpdateDeps, ms: number): Promise<string | null> {
  const end = d.now().getTime() + ms
  let last: string | null = null
  for (;;) {
    last = await d.health(port)
    if (last === want) return last
    if (d.now().getTime() >= end) return last
    await d.sleep(2000)
  }
}

/** Offer the release's Windows installer to the desks: data/downloads/<installer>, latest.yml, index.json. */
export async function deliverWindows(home: string, r: OfficeRelease, d: Pick<UpdateDeps, 'fetch' | 'log'>): Promise<string | null> {
  const w = r.windows
  if (!w) return null
  const dir = path.join(officePaths(home).data, 'downloads')
  const st = readUpdateState(home)
  const items = readIndex(dir)
  const have = items.find((i) => i.platform === 'windows' && i.file === w.installer.file && i.version === w.version)
  if (have && st.desktop?.version === w.version && fs.existsSync(path.join(dir, w.installer.file)) && fs.existsSync(path.join(dir, 'latest.yml'))) return null
  const newer = items.find((i) => i.platform === 'windows' && compareVersions(i.version, w.version) > 0)
  if (newer) { d.log(`Windows app ${newer.version} is already offered (newer than ${w.version}); left as it is`); return null }
  const tmp = path.join(updatePaths(home).download, 'windows')
  const exe = await download(w.installer, tmp, d)
  const yml = await download(w.latestYml, tmp, d)
  checkLatestYml(fs.readFileSync(yml, 'utf8'), w.version, w.installer.file, sha256File(exe, 'sha512', 'base64'), w.installer.size)
  // the same checks and index.json as `teamax desktop add` (./desktop.ts): an NSIS installer, the only Windows one
  const added = addInstaller(dir, exe, { version: w.version })
  if (added.item.sha256 !== w.installer.sha256) throw new UpdateFailure(`${w.installer.file} changed while it was offered`)
  // latest.yml last: it never names a file that is not there yet
  const dest = path.join(dir, 'latest.yml')
  const t = path.join(dir, `.latest.yml.tmp-${process.pid}`)
  fs.copyFileSync(yml, t)
  fs.chmodSync(t, 0o600)
  fs.renameSync(t, dest)
  fs.rmSync(tmp, { recursive: true, force: true })
  patchUpdateState(home, (s) => { s.desktop = { version: w.version, at: new Date().toISOString() } })
  d.log(`Windows app ${w.version} offered to the desks (${w.installer.file}, latest.yml)`)
  return w.version
}

/** electron-updater's latest.yml of the installer: the version, a plain file name (no URL elsewhere), its sha512. */
export function checkLatestYml(text: string, version: string, file: string, sha512b64: string, size: number) {
  const val = (k: string) => new RegExp(`^${k}:\\s*'?([^'\\n]*?)'?\\s*$`, 'm').exec(text)?.[1] ?? null
  if (val('version') !== version) throw new UpdateFailure(`latest.yml names version ${val('version')}, not ${version}`)
  if (val('path') !== file) throw new UpdateFailure(`latest.yml names ${val('path')}, not ${file}`)
  if (val('sha512') !== sha512b64) throw new UpdateFailure('latest.yml sha512 does not match the installer')
  const urls = [...text.matchAll(/^\s*-?\s*url:\s*'?([^'\n]*?)'?\s*$/gm)].map((m) => m[1])
  if (!urls.length || urls.some((u) => u !== file)) throw new UpdateFailure(`latest.yml file urls must be just ${file}`)
  const sizes = [...text.matchAll(/^\s*size:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]))
  if (sizes.some((x) => x !== size)) throw new UpdateFailure('latest.yml size does not match the installer')
}

/** One run of the updater. Never throws: the outcome is recorded in state.json and returned. */
export async function runUpdate(home: string, o: RunOptions): Promise<RunResult> {
  const d: UpdateDeps = { ...defaultDeps(), ...o.deps }
  home = path.resolve(home)
  const up = updatePaths(home)
  fs.mkdirSync(up.dir, { recursive: true, mode: 0o700 })
  // one run at a time (the agent, `teamax update check`)
  let lockFd: number
  try {
    lockFd = fs.openSync(up.lock, 'wx', 0o600)
  } catch {
    const pid = Number((() => { try { return fs.readFileSync(up.lock, 'utf8') } catch { return '' } })())
    if (pidAlive(pid)) return { kind: 'skipped', version: null, message: `another update run is in progress (pid ${pid})` }
    fs.rmSync(up.lock, { force: true })
    lockFd = fs.openSync(up.lock, 'wx', 0o600)
  }
  fs.writeSync(lockFd, String(process.pid))
  fs.closeSync(lockFd)
  const phase: Phase = (step, p, target = null) => { d.log(p); patchUpdateState(home, (s) => { s.running = { pid: process.pid, since: s.running?.since ?? d.now().toISOString(), step, phase: p, target } }) }
  const finish = (r: RunResult): RunResult => {
    patchUpdateState(home, (s) => { s.running = null; s.last = { ...r, at: d.now().toISOString() } })
    fs.rmSync(up.lock, { force: true })
    d.log(`${r.kind}${r.version ? ` ${r.version}` : ''}${r.message ? `: ${r.message}` : ''}`)
    return r
  }
  try {
    const set = readUpdateSettings(home)
    if (o.reason === 'schedule' && set.paused) return finish({ kind: 'paused', version: null, message: 'automatic updates are off (teamax update resume)' })
    const current = installedVersion(home)
    if (!current) return finish({ kind: 'failed', version: null, message: `${home}/app/VERSION missing` })
    phase('check', `checking ${feedOf(set)} (${set.channel}; installed ${current})`)
    let r: OfficeRelease
    try { r = await fetchRelease(home, d, o.keys) } catch (e) {
      patchUpdateState(home, (s) => { s.lastCheckAt = d.now().toISOString() })
      if (e instanceof NotPublished) return finish({ kind: 'up-to-date', version: current, message: e.message })
      return finish({ kind: e instanceof ReleaseError ? 'refused' : 'failed', version: null, message: (e as Error).message })
    }
    const dec = decide(current, r)
    patchUpdateState(home, (s) => {
      s.lastCheckAt = d.now().toISOString()
      s.available = dec.kind === 'install' || dec.kind === 'too-old' ? { version: r.version, channel: r.channel, notes: r.notes, publishedAt: r.publishedAt } : null
    })
    if (dec.kind === 'older' || dec.kind === 'too-old') return finish({ kind: 'refused', version: r.version, message: dec.reason })
    if (dec.kind === 'current') {
      if (o.reason !== 'check') await deliverWindows(home, r, d).catch((e) => d.log(`Windows app not offered: ${(e as Error).message}`))
      return finish({ kind: 'up-to-date', version: current, message: null })
    }
    if (o.reason === 'check') return finish({ kind: 'available', version: r.version, message: null })
    const failedBefore = readUpdateState(home).failed[r.version]
    if (failedBefore && o.reason === 'schedule') return finish({ kind: 'skipped', version: r.version, message: `${r.version} failed on ${failedBefore.at} and was rolled back; not tried again at night (teamax update now tries again)` })
    return finish(await install(home, current, r, d, o, phase))
  } catch (e) {
    return finish({ kind: 'failed', version: null, message: (e as Error).message })
  }
}

type Phase = (step: UpdateStep, text: string, target?: string | null) => void
async function install(home: string, current: string, r: OfficeRelease, d: UpdateDeps, o: RunOptions, phase: Phase): Promise<RunResult> {
  const up = updatePaths(home)
  const s = loadSettings(home)
  const target = r.version
  const fail = (msg: string, result: 'failed' | 'rolled-back' = 'failed'): RunResult => {
    patchUpdateState(home, (x) => {
      x.lastUpdate = { from: current, to: target, at: d.now().toISOString(), result, error: msg }
      if (result === 'rolled-back') x.failed[target] = { at: d.now().toISOString(), reason: msg }
    })
    return { kind: result, version: target, message: msg }
  }
  let bundle: string
  try {
    phase('download', `downloading ${target}`, target)
    const zip = await download(pickOffice(r), up.download, d)
    phase('unpack', `unpacking ${target}`, target)
    bundle = await unpack(zip, target, home, d)
    phase('precheck', `checking the new installer (${target})`, target)
    const chk = await d.exec(['/bin/bash', path.join(bundle, 'office-install.sh'), '--prefix', home, '--update', '--check-only'], { cwd: bundle, env: { ...toolEnv(home), TEAMAX_UPDATE_RUN: '1' }, capture: true, timeoutMs: 5 * 60_000 })
    if (chk.code !== 0) return fail(`the new installer's check failed: ${chk.out.split('\n').slice(-3).join(' ').slice(0, 600)}`)
    // running answers finish first (an answer that is still running after 10 minutes is interrupted)
    const idleEnd = d.now().getTime() + (o.idleWaitMs ?? IDLE_WAIT_MS)
    for (let n = runningAnswers(home, d.now().getTime()); n && n > 0 && d.now().getTime() < idleEnd; n = runningAnswers(home, d.now().getTime())) {
      phase('wait-idle', `waiting for ${n} running answer(s) to finish`, target)
      await d.sleep(15_000)
    }
    phase('backup', 'backing up the database (pre-update)', target)
    const app = path.join(home, 'app')
    const bk = await d.exec([path.join(app, 'bin', 'bun'), path.join(app, 'server', 'src', 'admin.js'), 'backup', '--scope', 'db', '--kind', 'pre-update'], { cwd: home, env: toolEnv(home), capture: true, timeoutMs: 15 * 60_000 })
    if (bk.code !== 0) return fail(`the pre-update backup failed (nothing was changed): ${bk.out.slice(-400)}`)
  } catch (e) {
    return fail((e as Error).message)
  }
  // from here on the program changes: any failure rolls back
  phase('install', `installing ${target} (was ${current})`, target)
  const inst = await d.exec(['/bin/bash', path.join(bundle, 'office-install.sh'), '--prefix', home, '--update'], { cwd: bundle, env: { ...toolEnv(home), TEAMAX_UPDATE_RUN: '1' }, timeoutMs: 10 * 60_000 })
  let problem: string | null = inst.code !== 0 ? `the installer exited ${inst.code}` : null
  if (!problem) {
    phase('verify', `waiting for ${target} to answer`, target)
    const v = await waitVersion(s.appPort, target, d, o.healthWaitMs ?? HEALTH_WAIT_MS)
    if (v !== target) problem = v ? `the server answers as ${v}, not ${target}` : `${target} did not answer on 127.0.0.1:${s.appPort}`
    else {
      await d.sleep(o.stableMs ?? STABLE_MS)
      const again = await d.health(s.appPort)
      if (again !== target) problem = `${target} stopped answering after it started`
    }
  }
  if (problem) {
    phase('rollback', `${problem}: rolling back to ${current}`, target)
    let back: string | null = null
    try { back = await rollBack(home, current, target, d, o.healthWaitMs ?? HEALTH_WAIT_MS) } catch (e) { d.log(`rollback: ${(e as Error).message}`) }
    if (back !== current) return fail(`${problem}; the rollback to ${current} did not answer either: run ${path.join(home, 'teamax')} status and office-install.sh from the ${PRODUCT.officeBundle}-${current} zip`)
    return fail(`${problem}; rolled back to ${current}`, 'rolled-back')
  }
  patchUpdateState(home, (x) => {
    x.lastUpdate = { from: current, to: target, at: d.now().toISOString(), result: 'updated', error: null }
    x.available = null
    delete x.failed[target]
  })
  // tidy: the unpacked bundle, the zip, an older failed app folder
  fs.rmSync(up.staging, { recursive: true, force: true })
  fs.rmSync(up.download, { recursive: true, force: true })
  fs.rmSync(path.join(home, 'app.failed'), { recursive: true, force: true })
  await deliverWindows(home, r, d).catch((e) => d.log(`Windows app not offered: ${(e as Error).message}`))
  return { kind: 'updated', version: target, message: `${current} → ${target}` }
}

export const isVersion = (v: string) => VERSION_RE.test(v)
export { readIndex }
