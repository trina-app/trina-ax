// Office mode automatic updates (docs/OFFICE.md "자동 업데이트"). The third LaunchAgent of an installation,
// <label>.update (app.team-ax.office.update), runs `office.js update run` every 15 minutes, and that run goes on only
// inside the team's update window in the team's time zone (Admin > Team settings, 03:00-05:00 when empty: the same
// window as a Linux server's updates, officeSchedule; update audit 2026-11-01 O1), and when someone asks (`teamax update
// now`, Admin > System "지금 업데이트": a request file + launchctl kickstart):
//
//   1. GET <feed>/<dir>/<channel>.json (the only address contacted: RELEASE_CHANNEL.feed), verify the Ed25519
//      signature with a key baked into this build (./release.ts), the channel, no downgrade, not below minFrom; the
//      nightly run also waits for this Mac's turn in a stable release's staged roll-out (system/rollout.ts, the same
//      rule as a Linux server's; about 10% of offices the first day, 50% the second, all from the third)
//   2. download the office zip, check its size and SHA-256, unpack it into update/staging/ (what an earlier failed
//      release left there and in update/download is removed first)
//   3. the new bundle's own installer with --check-only, wait until no answer is running, a database backup (admin.js
//      backup --scope db --kind pre-update). The nightly run waits until the window closes (at most an hour) and then
//      leaves the update for the next check rather than cut an answer off; after three days of that it waits at most
//      10 minutes, like "update now" (O4, the Linux root update's rule: native/cmd/mycel-ctl/schedule.go)
//   4. the new bundle's own installer with --update: it stops the agents, copies its app/ next to the old one, keeps
//      the old one as app.previous, swaps, starts the server and cloudflared again
//   5. /api/health on 127.0.0.1 must answer with the new version (and still after 15 s); a version that updates a large
//      database first answers "migrating" meanwhile and is waited for, at most MIGRATE_WAIT_MS (office/health.ts; QA
//      TC-278); otherwise roll back: stop
//      the agents, app -> app.failed, app.previous -> app, the old version's `office.js install`, wait for the old
//      version; that version is not tried again by the nightly run (`teamax update now` tries again)
//   6. the release's Windows desktop installer + latest.yml into data/downloads (index.json), so the desks' app
//      (electron-updater, generic provider) updates from the office's own Mac (offerWindows; a Linux team server does
//      the same after each of its updates, system/windows-app.ts)
//
// data/, team/, tls/ and config/ are never touched by an update (the installer keeps them; the rollback moves only
// app folders). The updater's own files live in <home>/update/: settings.json (channel, time, paused), state.json
// (what the web and `teamax update status` show), request.json (an "update now" waiting for the agent), lock, the
// download and the unpacked bundle. Its log is logs/update.log.
import { Database } from 'bun:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TeamSettings } from '@mycel/shared/api'
import { defaultTimeZone, isValidTimeZone, zonedParts, zonedToUtc } from '../system/time-zone'
import { compareVersions } from '../system/update'
import { DEFAULT_UPDATE_WINDOW, inWindow } from '../system/update-job'
import { rolloutTurn, type RolloutTurn } from '../system/rollout'
import { CHANNELS, decide, DEFAULT_FEED, fileUrl, manifestUrl, OFFICE_RELEASE_KEYS, ReleaseError, verifyRelease, VERSION_RE, type Channel, type OfficeRelease, type ReleaseFile } from './release'
import { addInstaller, ensureDir, planAdd, readIndex } from './desktop'
import { reserveBytes, snapshotOf } from '../system/storage'
import { loadSettings, officePaths, type OfficeSettings } from './settings'
import { PRODUCT } from '@mycel/shared'
import { isMigrating, MIGRATE_WAIT_MS, probeHealth, type HealthAnswer } from './health'

// ---- settings and state ------------------------------------------------------------------------------------------

export interface UpdateSettings {
  channel: Channel
  /** before 0.2.19: the nightly time in this Mac's clock, HH:MM (`teamax update time`). The schedule is the team's update
   * window now (officeSchedule); a time other than 03:00 set before still counts while the team has no window. */
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
  /** a newer version on the feed that is not installed yet; turnAt: when the nightly run may take it in its staged
   * roll-out (null: never with this release), absent when nothing waits (officeRolloutTurn) */
  available: { version: string; channel: Channel; notes: string; publishedAt: string; turnAt?: string | null } | null
  /** the last install attempt */
  lastUpdate: { from: string; to: string; at: string; result: 'updated' | 'rolled-back' | 'failed'; error: string | null } | null
  /** versions that failed and were rolled back: the nightly run does not try them again */
  failed: Record<string, { at: string; reason: string }>
  /** an update in progress (the agent's pid); step is what the web shows in the person's language */
  running: { pid: number; since: string; step: UpdateStep; phase: string; target: string | null } | null
  /** the Windows desktop app last put into data/downloads */
  desktop: { version: string; at: string } | null
  /** a nightly update that found answers running until its window closed, since when (the last resort after 3 days) */
  deferred?: { version: string; since: string } | null
}
const emptyState = (): UpdateState => ({ lastCheckAt: null, last: null, available: null, lastUpdate: null, failed: {}, running: null, desktop: null, deferred: null })

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

/** a feed override is only honoured for this Mac (tests): the office's Mac never contacts anything but the feed */
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

// ---- the schedule: the team's update window (one setting for every kind of install) -----------------------------

export interface OfficeSchedule {
  /** "HH:mm-HH:mm" in timeZone (update-job.ts inWindow: equal ends never open) */
  window: string
  timeZone: string
  /** team = Admin > Team settings; legacy = `teamax update time` of an older version; default = 03:00-05:00 */
  source: 'team' | 'legacy' | 'default'
}

const plus = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number) as [number, number]; const t = (h * 60 + m + min) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }

/** The team's update window and time zone, read from the database (read only; the same values the server's
 * getTeamSettings / teamTimeZone give: an invalid stored window is "00:00-00:00", which never opens). A team without a
 * window gets the time an older `teamax update time` set (as its window's start, two hours long), else 03:00-05:00. */
export function officeSchedule(home: string, env: Record<string, string | undefined> = process.env): OfficeSchedule {
  let window: string | null = null, tz: string | null = null
  try {
    const db = new Database(path.join(officePaths(home).data, 'app.db'), { readonly: true })
    try {
      for (const r of db.query("SELECT key, value FROM settings WHERE key IN ('updateWindow', 'timeZone')").all() as { key: string; value: string }[]) {
        let v: unknown
        try { v = JSON.parse(r.value) } catch { v = undefined }
        if (r.key === 'updateWindow') window = TeamSettings.shape.updateWindow.safeParse(v).success ? (v as string | null) : '00:00-00:00'
        else if (isValidTimeZone(v)) tz = v
      }
    } finally { db.close() }
  } catch { /* no database yet, or not readable: the defaults */ }
  const timeZone = tz ?? defaultTimeZone(env)
  if (window) return { window, timeZone, source: 'team' }
  const legacy = readUpdateSettings(home).time
  if (legacy !== DEFAULT_UPDATE_SETTINGS.time) return { window: `${legacy}-${plus(legacy, 120)}`, timeZone, source: 'legacy' }
  return { window: DEFAULT_UPDATE_WINDOW, timeZone, source: 'default' }
}

/** The install id of this office (the server's own, server/src/admin/settings.ts installId: MYCEL_INSTALL_ID, else the
 * settings table, read only), for the staged roll-out (system/rollout.ts); null when there is none yet: the last wave. */
export function officeInstallId(home: string, env: Record<string, string | undefined> = process.env): string | null {
  const e = env.MYCEL_INSTALL_ID
  if (e && /^[A-Za-z0-9._-]{1,128}$/.test(e)) return e
  try {
    const db = new Database(path.join(officePaths(home).data, 'app.db'), { readonly: true })
    try {
      const r = db.query("SELECT value FROM settings WHERE key = 'system.installId'").get() as { value: string } | null
      const v: unknown = r ? JSON.parse(r.value) : null
      return typeof v === 'string' && v ? v : null
    } finally { db.close() }
  } catch { return null }
}

/** This Mac's turn for a release in its staged roll-out (system/rollout.ts): the same rule as a Linux server's. */
export function officeRolloutTurn(home: string, r: Pick<OfficeRelease, 'rollout' | 'publishedAt'>, channel: Channel, now: Date): RolloutTurn {
  return rolloutTurn(r, officeInstallId(home), { now, channel })
}

/** When the window that holds `now` closes (the next end after now, in the window's zone). */
export function windowEnd(window: string, timeZone: string, now: Date): Date {
  const to = window.split('-')[1]!
  const [h, m] = to.split(':').map(Number) as [number, number]
  const p = zonedParts(now, timeZone)
  let end = zonedToUtc(p.y, p.m, p.d, h, m, timeZone)
  if (end.getTime() <= now.getTime()) {
    const next = zonedParts(new Date(now.getTime() + 86_400_000), timeZone)
    end = zonedToUtc(next.y, next.m, next.d, h, m, timeZone)
  }
  return end
}

/** The agent's next run that the window lets go on (it starts every 15 minutes: :00, :15, :30, :45), or null while
 * paused or when the window never opens. */
export function nextRunAt(s: Pick<OfficeSchedule, 'window' | 'timeZone'>, now = new Date(), paused = false): Date | null {
  if (paused) return null
  const q = 15 * 60_000
  const up = (t: number) => Math.ceil(t / q) * q
  // inside the window now: the next start; else the first start after the window opens today, tomorrow or the day
  // after (a few zone conversions: the web asks for this every few seconds while an update runs)
  const next = up(now.getTime() + 1)
  if (inWindow(s.window, new Date(next), s.timeZone)) return new Date(next)
  const [h, m] = s.window.slice(0, 5).split(':').map(Number) as [number, number]
  const today = zonedParts(now, s.timeZone)
  for (let day = 0; day < 3; day++) {
    // calendar days in the team's zone (not now + 24 h: a day around a clock change is 23 or 25 hours)
    const c = new Date(Date.UTC(today.y, today.m - 1, today.d + day, 12))
    const [y, mo, d] = [c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate()]
    const start = zonedToUtc(y, mo, d, h, m, s.timeZone)
    const t = up(start.getTime())
    if (t > now.getTime() && inWindow(s.window, new Date(t), s.timeZone)) return new Date(t)
    // a start the clocks skip that night (02:30 on a spring-forward night): the quarters of that day
    const sp = zonedParts(start, s.timeZone)
    if (sp.h !== h || sp.min !== m) {
      const from = zonedToUtc(y, mo, d, 0, 0, s.timeZone).getTime()
      for (let x = up(Math.max(from, now.getTime() + 1)); x < from + 25 * 3600_000; x += q) if (inWindow(s.window, new Date(x), s.timeZone)) return new Date(x)
    }
  }
  return null
}

/** A run of the agent now: does the window let it go on, and until when may it wait for running answers. */
export function scheduledRun(home: string, now = new Date()): { go: false; schedule: OfficeSchedule } | { go: true; schedule: OfficeSchedule; quietBy: Date; lastResort: boolean } {
  const schedule = officeSchedule(home)
  if (!inWindow(schedule.window, now, schedule.timeZone)) return { go: false, schedule }
  const end = windowEnd(schedule.window, schedule.timeZone, now)
  const quietBy = new Date(Math.min(end.getTime(), now.getTime() + RUN_WAIT_MS))
  const d = readUpdateState(home).deferred
  return { go: true, schedule, quietBy, lastResort: !!d && now.getTime() - Date.parse(d.since) >= LAST_RESORT_MS }
}

export const installedVersion = (home: string): string | null => {
  try { const v = fs.readFileSync(path.join(home, 'app', 'VERSION'), 'utf8').trim(); return v || null } catch { return null }
}

// ---- the LaunchAgent ---------------------------------------------------------------------------------------------

export const updateLabel = (s: Pick<OfficeSettings, 'label'>) => `${s.label}.update`

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The update agent: not kept alive, not run at load, a normal process (Background throttles disk I/O: unpacking the
 * zip took a minute, and "update now" is waited for); launchd starts it every 15 minutes (and after a wake if the Mac
 * slept through one) and when kickstarted. A run outside the team's update window ends at once, without network or a
 * log line (update-cli.ts `update run`). PATH has Claude Code's folder (the new installer checks it). */
export function updatePlist(s: OfficeSettings, envPath: string): string {
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
  <array>${[0, 15, 30, 45].map((min) => `<dict><key>Minute</key><integer>${min}</integer></dict>`).join('')}</array>
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
  /** the window's start (older web pages show it) */
  time: string
  /** the team's update window, where it comes from and its zone (officeSchedule) */
  window: string
  windowSource: OfficeSchedule['source']
  timeZone: string
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
  const sched = officeSchedule(home)
  const next = nextRunAt(sched, o.now ?? new Date(), set.paused)
  return {
    current, channel: set.channel, paused: set.paused, time: sched.window.slice(0, 5), window: sched.window, windowSource: sched.source, timeZone: sched.timeZone,
    nextWindowAt: agentInstalled && next ? next.toISOString() : null,
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
  /** the version /api/health reports on 127.0.0.1:<port>, null when it does not answer, {migrating: version} while that
   * version updates its database before it starts (office/health.ts) */
  health(port: number): Promise<HealthAnswer>
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
  health: (port) => probeHealth(port),
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
/** a nightly run waits for a quiet moment at most this long (the agent's next start in the window goes on) */
export const RUN_WAIT_MS = 60 * 60_000
/** an update deferred this long goes in after IDLE_WAIT_MS even with answers running */
export const LAST_RESORT_MS = 72 * 3600_000

export interface RunOptions {
  /** 'schedule' = the nightly run (honours pause and earlier failures); 'now' = asked for; 'check' = look only */
  reason: 'schedule' | 'now' | 'check'
  deps?: Partial<UpdateDeps>
  /** waits (tests make them short) */
  healthWaitMs?: number
  /** a version that reports "migrating" may take this long after the switch (MIGRATE_WAIT_MS) */
  migrateWaitMs?: number
  stableMs?: number
  idleWaitMs?: number
  /** the nightly run inside the team's window (scheduledRun): wait for running answers until then and leave the update
   * for a later run instead of interrupting them; without it a run waits idleWaitMs and goes on */
  quietBy?: Date
  /** the update was deferred for 3 days: wait idleWaitMs, then go on */
  lastResort?: boolean
  /** release public keys (tests sign with their own) */
  keys?: readonly string[]
}
export interface RunResult { kind: ResultKind; version: string | null; message: string | null }

/** fetch and verify the channel's manifest */
export async function fetchRelease(home: string, d: Pick<UpdateDeps, 'fetch'>, keys: readonly string[] = OFFICE_RELEASE_KEYS): Promise<OfficeRelease> {
  const set = readUpdateSettings(home)
  return fetchManifest(feedOf(set), set.channel, d, keys)
}

/** GET <feed>/<dir>/<channel>.json and verify it (signature with a baked key, the channel, every file on the feed); the
 * office updater and a Linux server's Windows app (system/windows-app.ts). NotPublished for 404. `version`: that
 * version's own copy, <feed>/<dir>/<version>/<channel>.json (scripts/release/publish.ts keeps it for good), which must
 * be that version. */
export async function fetchManifest(feed: string, channel: Channel, d: Pick<UpdateDeps, 'fetch'>, keys: readonly string[] = OFFICE_RELEASE_KEYS, version?: string): Promise<OfficeRelease> {
  if (version !== undefined && !VERSION_RE.test(version)) throw new NotPublished(`${version} is not a release version`)
  const url = version === undefined ? manifestUrl(feed, channel) : fileUrl(feed, version, `${channel}.json`)
  let res: Response
  try { res = await d.fetch(`${url}?t=${Date.now()}`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } }) } catch (e) { throw new UpdateFailure(`cannot reach ${feed}: ${(e as Error).message}`) }
  if (res.status === 404) throw new NotPublished(version === undefined ? `no ${channel} release published yet` : `the feed keeps no ${channel} manifest of ${version}`)
  if (!res.ok) throw new UpdateFailure(`${url}: HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > MANIFEST_MAX) throw new UpdateFailure(`${url} is larger than a manifest`)
  const text = Buffer.from(buf).toString('utf8')
  const r = verifyRelease(text, { keys, channel, feed })
  if (version !== undefined && r.version !== version) throw new ReleaseError(`${url} is the manifest of ${r.version}, not ${version}`)
  SIGNED.set(r, { channel, text })
  return r
}

const SIGNED = new WeakMap<OfficeRelease, SignedText>()
/** the signed manifest a release came from (fetchManifest): offerWindows puts it next to the installer */
export interface SignedText { channel: Channel; text: string }
export const signedTextOf = (r: OfficeRelease): SignedText | undefined => SIGNED.get(r)

/** Download a release file into `dir`, checking size and SHA-256 on the way. Returns the file. `o.sha512` gets the
 * file's SHA-512 (base64, electron-updater's latest.yml), computed on the way too. */
export async function download(f: ReleaseFile, dir: string, d: Pick<UpdateDeps, 'fetch'>, o: { sha512?: (b64: string) => void } = {}): Promise<string> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const dest = path.join(dir, f.file)
  if (fs.existsSync(dest) && fs.statSync(dest).size === f.size && sha256File(dest) === f.sha256) { // already here (an earlier try)
    o.sha512?.(sha256File(dest, 'sha512', 'base64'))
    return dest
  }
  const part = `${dest}.part`
  fs.rmSync(part, { force: true })
  let res: Response
  try { res = await d.fetch(f.url, { redirect: 'error', signal: AbortSignal.timeout(60 * 60_000) }) } catch (e) { throw new UpdateFailure(`download ${f.file}: ${(e as Error).message}`) }
  if (!res.ok || !res.body) throw new UpdateFailure(`download ${f.file}: HTTP ${res.status}`)
  const h = crypto.createHash('sha256')
  const h512 = o.sha512 ? crypto.createHash('sha512') : null
  const fd = fs.openSync(part, 'wx', 0o600)
  let n = 0
  try {
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      n += c.byteLength
      if (n > f.size) throw new UpdateFailure(`${f.file} is larger than the release says (${f.size} bytes)`)
      h.update(c)
      h512?.update(c)
      fs.writeSync(fd, c)
    }
  } catch (e) {
    fs.closeSync(fd); fs.rmSync(part, { force: true })
    throw e instanceof UpdateFailure ? e : new UpdateFailure(`download ${f.file}: ${(e as Error).message}`)
  }
  fs.closeSync(fd)
  const sha = h.digest('hex')
  // shorter than the release: the connection ended early (said as a download problem, so it is simply tried again)
  if (n < f.size) { fs.rmSync(part, { force: true }); throw new UpdateFailure(`download ${f.file}: it ended after ${n} of ${f.size} bytes`) }
  if (n !== f.size || sha !== f.sha256) { fs.rmSync(part, { force: true }); throw new UpdateFailure(`${f.file} does not match the signed release (size ${n}/${f.size}, SHA-256 ${sha.slice(0, 12)}… / ${f.sha256.slice(0, 12)}…)`) }
  fs.renameSync(part, dest)
  if (h512) o.sha512!(h512.digest('base64'))
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

/** answers running on the server right now (status/status.json, written every 30 s); null = unknown (old or missing:
 * the caller asks the server whether it is up, update audit O4: an unknown count used to mean "do not wait") */
export function runningAnswers(home: string, now = Date.now()): number | null {
  const j = readJson(path.join(home, 'status', 'status.json')) as { writtenAt?: string; queue?: { running?: number } } | null
  if (!j?.writtenAt || now - Date.parse(j.writtenAt) > 120_000) return null
  return typeof j.queue?.running === 'number' ? j.queue.running : null
}

/** the server's own maintenance running now (status.json: a backup, a restore), null for none or an old file */
export function serverMaintenance(home: string, now = Date.now()): string | null {
  const j = readJson(path.join(home, 'status', 'status.json')) as { writtenAt?: string; maintenance?: unknown } | null
  if (!j?.writtenAt || now - Date.parse(j.writtenAt) > 120_000) return null
  return typeof j.maintenance === 'string' && j.maintenance ? j.maintenance.slice(0, 40) : null
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
  return (await waitVersion(s.appPort, from, d, healthWaitMs)).version
}

export interface WaitResult {
  /** the version that answered last (null: none) */
  version: string | null
  /** `want` said it was updating its database at some point / still said so when the wait ended */
  sawMigrating: boolean
  stillMigrating: boolean
}

/** Wait until /api/health answers with `want`, at most `ms`. While `want` reports it is updating its database the
 * deadline moves to now + `ms` (never less than it had), so the start after a long migration gets the usual time; once
 * that has lasted `migrateMs` from the start of the wait there is no more time (the bootstrap's extendDeadline,
 * native/cmd/mycel-bootstrap; the wait is bounded by migrateMs + ms). Progress goes to the log once a minute. */
export async function waitVersion(port: number, want: string, d: UpdateDeps, ms: number, migrateMs = MIGRATE_WAIT_MS): Promise<WaitResult> {
  const start = d.now().getTime()
  let end = start + ms
  let last: string | null = null
  let sawMigrating = false, loggedAt = -Infinity
  for (;;) {
    const h = await d.health(port)
    const now = d.now().getTime()
    const migrating = isMigrating(h) && h.migrating === want
    last = typeof h === 'string' ? h : null
    if (last === want) return { version: last, sawMigrating, stillMigrating: false }
    if (migrating) {
      if (now - start < migrateMs) end = Math.max(end, now + ms)
      else end = Math.min(end, now)
      if (now - loggedAt >= 60_000) {
        d.log(`${want} is updating its database (${h.progress || '-'}), ${Math.round((now - start) / 1000)} s so far; waiting while it does, at most ${Math.round(migrateMs / 60_000)} min`)
        loggedAt = now
      }
      sawMigrating = true
    }
    if (now >= end) return { version: last, sawMigrating, stillMigrating: migrating }
    await d.sleep(2000)
  }
}

/** Offer the release's Windows installer to the desks: data/downloads/<installer>, latest.yml, index.json. */
export async function deliverWindows(home: string, r: OfficeRelease, d: Pick<UpdateDeps, 'fetch' | 'log'>, o: { statfs?: StatfsLike } = {}): Promise<string | null> {
  const w = r.windows
  if (!w) return null
  let res: Awaited<ReturnType<typeof offerWindows>>
  try { res = await offerWindows(path.join(officePaths(home).data, 'downloads'), path.join(updatePaths(home).download, 'windows'), w, d, { ...o, signed: signedTextOf(r) }) }
  finally {
    // update/download/ itself when nothing else waits there (O9: an empty folder was left after every update; a failed
    // download too). rmdir removes only an empty folder: a deferred release's zip stays
    try { fs.rmdirSync(updatePaths(home).download) } catch {}
  }
  if (res.kind === 'newer') { d.log(`Windows app ${res.version} is already offered (newer than ${w.version}); left as it is`); return null }
  if (res.kind === 'no-room') throw new UpdateFailure(res.message)
  if (res.kind === 'current') {
    if (readUpdateState(home).desktop?.version !== w.version) patchUpdateState(home, (s) => { s.desktop = { version: w.version, at: new Date().toISOString() } })
    return null
  }
  patchUpdateState(home, (s) => { s.desktop = { version: w.version, at: new Date().toISOString() } })
  d.log(`Windows app ${w.version} offered to the desks (${w.installer.file}, latest.yml)`)
  return w.version
}

export type WindowsRelease = NonNullable<OfficeRelease['windows']>
export type StatfsLike = (p: string) => { bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint }
export type WindowsOffer =
  | { kind: 'offered' | 'current'; version: string }
  /** a newer Windows app is offered (put there by hand): left as it is, never replaced by an older one */
  | { kind: 'newer'; version: string }
  /** the disk has no room for the download (nothing was downloaded) */
  | { kind: 'no-room'; message: string }

/** `dir` offers exactly this release's Windows app: index.json lists the installer with its SHA-256, the file is there
 * with that size, and latest.yml is the release's (by SHA-256). */
export function windowsOffered(dir: string, w: WindowsRelease, items = readIndex(dir)): boolean {
  const i = items.find((x) => x.platform === 'windows' && x.file === w.installer.file)
  if (!i || i.version !== w.version || i.sha256 !== w.installer.sha256) return false
  try {
    if (fs.statSync(path.join(dir, w.installer.file)).size !== w.installer.size) return false
    return sha256File(path.join(dir, 'latest.yml')) === w.latestYml.sha256
  } catch { return false }
}

/** The signed manifest that names the offered installer, as <dir>/<channel>.json (routes/downloads.ts serves it): the
 * Windows app installs an update only when that signed release names the installer it downloaded
 * (desktop/src/common/update-verify.ts). The other channel's file goes (a server offers one channel). Written before
 * latest.yml names a new installer, so a desk never sees an installer without its manifest. */
export function placeSignedManifest(dir: string, s: SignedText | undefined) {
  if (!s) return
  ensureDir(dir)
  const f = path.join(dir, `${s.channel}.json`)
  let same = false
  try { same = fs.readFileSync(f, 'utf8') === s.text } catch {}
  if (!same) {
    const t = path.join(dir, `.${s.channel}.json.tmp-${process.pid}`)
    try {
      fs.writeFileSync(t, s.text, { mode: 0o600 })
      fs.renameSync(t, f)
    } finally { fs.rmSync(t, { force: true }) }
  }
  for (const c of CHANNELS) if (c !== s.channel) fs.rmSync(path.join(dir, `${c}.json`), { force: true })
}

/** Room for `bytes` more next to `p`: what is left keeps the reserve below which the team folder refuses writes
 * (system/storage.ts: max(512 MiB, 2% of the disk)), so a download never takes the team's last space. */
export function roomFor(p: string, bytes: number, statfs: StatfsLike = (x) => fs.statfsSync(x)): { ok: boolean; freeBytes: number; needBytes: number } {
  let at = path.resolve(p)
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at)
  const s = snapshotOf(statfs(at))
  const needBytes = bytes + reserveBytes(s.totalBytes)
  return { ok: s.freeBytes >= needBytes, freeBytes: s.freeBytes, needBytes }
}

/**
 * Put a verified release's Windows installer and its latest.yml into the downloads folder `dir` (index.json), so the
 * desks' app (electron-updater, generic provider = <team address>/downloads/) updates from its own team server. Both
 * files are downloaded into `tmp` with their size and SHA-256 checked against the signed manifest, latest.yml must name
 * exactly that installer (version, sha512, size), the installer gets the checks of `teamax desktop add` and replaces
 * every older Windows installer in the folder (moved in, not copied: the folder needs room for one copy), and latest.yml
 * comes last, so it never names a file that is not there. `tmp` is removed afterwards, whatever happened.
 */
export async function offerWindows(dir: string, tmp: string, w: WindowsRelease, d: Pick<UpdateDeps, 'fetch' | 'log'>, o: { statfs?: StatfsLike; signed?: SignedText } = {}): Promise<WindowsOffer> {
  const items = readIndex(dir)
  if (windowsOffered(dir, w, items)) {
    // a folder filled before the desks checked the signed release gets its manifest too
    placeSignedManifest(dir, o.signed)
    return { kind: 'current', version: w.version }
  }
  const newer = items.find((i) => i.platform === 'windows' && compareVersions(i.version, w.version) > 0)
  if (newer) return { kind: 'newer', version: newer.version }
  // the installer is already listed and in place (its SHA-256 recorded when it was added), only latest.yml is not the
  // release's: that file alone (pinned by the signed manifest) is put right; the 110 MB file is not fetched or read again
  const listed = items.find((i) => i.platform === 'windows' && i.file === w.installer.file && i.version === w.version && i.sha256 === w.installer.sha256)
  const inPlace = !!listed && (() => { try { return fs.statSync(path.join(dir, w.installer.file)).size === w.installer.size } catch { return false } })()
  const room = roomFor(tmp, (inPlace ? 0 : w.installer.size) + w.latestYml.size, o.statfs)
  if (!room.ok) return { kind: 'no-room', message: `not enough disk space for the Windows app ${w.version} (${Math.ceil(room.needBytes / 1048576)} MB needed with the reserve, ${Math.floor(room.freeBytes / 1048576)} MB free)` }
  fs.rmSync(tmp, { recursive: true, force: true })
  if (inPlace) {
    try {
      const yml = await download(w.latestYml, tmp, d)
      const text = fs.readFileSync(yml, 'utf8')
      const val = (k: string) => ymlValue(text, k)
      if (val('version') !== w.version || val('path') !== w.installer.file) throw new UpdateFailure(`latest.yml names ${val('path')} ${val('version')}, not ${w.installer.file} ${w.version}`)
      placeSignedManifest(dir, o.signed)
      const t = path.join(dir, `.latest.yml.tmp-${process.pid}`)
      try {
        fs.copyFileSync(yml, t)
        fs.chmodSync(t, 0o600)
        fs.renameSync(t, path.join(dir, 'latest.yml'))
      } finally { fs.rmSync(t, { force: true }) }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    return { kind: 'offered', version: w.version }
  }
  const wasThere = fs.existsSync(path.join(dir, w.installer.file))
  try {
    // the hashes on the way (a Linux server does this in its own process: no second pass over 110 MB there)
    let exe512 = ''
    const exe = await download(w.installer, tmp, d, { sha512: (b) => { exe512 = b } })
    const yml = await download(w.latestYml, tmp, d)
    checkLatestYml(fs.readFileSync(yml, 'utf8'), w.version, w.installer.file, exe512, w.installer.size)
    // the same checks as `teamax desktop add` (./desktop.ts: an NSIS installer, the only Windows one), decided before
    // anything in the folder changes
    const plan = planAdd(dir, exe, { version: w.version })
    if (plan.action === 'refused') throw new UpdateFailure(plan.reason)
    if (plan.item.file !== w.installer.file) throw new UpdateFailure(`${w.installer.file} would be offered as ${plan.item.file}`)
    // latest.yml goes into the folder first under a name that is never served, so a full disk stops here, before
    // index.json changes; it takes its own name last, so it never names a file that is not there yet
    ensureDir(dir)
    const t = path.join(dir, `.latest.yml.tmp-${process.pid}`)
    try {
      fs.copyFileSync(yml, t)
      fs.chmodSync(t, 0o600)
      const added = addInstaller(dir, exe, { version: w.version, move: true, sha256: w.installer.sha256 })
      if (added.item.sha256 !== w.installer.sha256 || added.item.file !== w.installer.file) throw new UpdateFailure(`${w.installer.file} changed while it was offered`)
      placeSignedManifest(dir, o.signed)
      fs.renameSync(t, path.join(dir, 'latest.yml'))
    } finally { fs.rmSync(t, { force: true }) }
  } catch (e) {
    // moved in but not listed (index.json could not be written): not served, so not left to take 110 MB
    const f = path.join(dir, w.installer.file)
    if (!wasThere && fs.existsSync(f) && !readIndex(dir).some((i) => i.file === w.installer.file)) fs.rmSync(f, { force: true })
    throw e
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  return { kind: 'offered', version: w.version }
}

/** a top-level `key: value` of latest.yml (quotes off) */
export const ymlValue = (text: string, k: string): string | null => new RegExp(`^${k}:\\s*'?([^'\\n]*?)'?\\s*$`, 'm').exec(text)?.[1] ?? null

/** electron-updater's latest.yml of the installer: the version, a plain file name (no URL elsewhere), its sha512. */
export function checkLatestYml(text: string, version: string, file: string, sha512b64: string, size: number) {
  const val = (k: string) => ymlValue(text, k)
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
    // the staged roll-out (system/rollout.ts): the nightly run waits for this Mac's turn; "update now" does not
    const turn = dec.kind === 'install' ? officeRolloutTurn(home, r, set.channel, d.now()) : null
    patchUpdateState(home, (s) => {
      s.lastCheckAt = d.now().toISOString()
      s.available = dec.kind === 'install' || dec.kind === 'too-old'
        ? { version: r.version, channel: r.channel, notes: r.notes, publishedAt: r.publishedAt, ...(turn?.wait ? { turnAt: turn.at?.toISOString() ?? null } : {}) }
        : null
    })
    if (dec.kind === 'older' || dec.kind === 'too-old') return finish({ kind: 'refused', version: r.version, message: dec.reason })
    if (dec.kind === 'current') {
      if (o.reason !== 'check') patchUpdateState(home, (s) => { s.deferred = null })
      if (o.reason !== 'check') await deliverWindows(home, r, d).catch((e) => d.log(`Windows app not offered: ${(e as Error).message}`))
      return finish({ kind: 'up-to-date', version: current, message: null })
    }
    if (o.reason === 'check') return finish({ kind: 'available', version: r.version, message: null })
    const failedBefore = readUpdateState(home).failed[r.version]
    if (failedBefore && o.reason === 'schedule') return finish({ kind: 'skipped', version: r.version, message: `${r.version} failed on ${failedBefore.at} and was rolled back; not tried again at night (teamax update now tries again)` })
    if (turn?.wait && o.reason === 'schedule') {
      // a deferral left by an earlier release must not carry its three days over to this one (the last resort would cut
      // answers off at this release's turn), like the root update timer
      patchUpdateState(home, (s) => { if (s.deferred && s.deferred.version !== r.version) s.deferred = null })
      const when = turn.at ? `this Mac's turn comes at ${turn.at.toISOString()}` : 'this release does not reach this Mac by itself'
      return finish({ kind: 'skipped', version: r.version, message: `${r.version} is in a staged roll-out: ${when} (teamax update now installs it now)` })
    }
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
    const file = pickOffice(r)
    // the zip and unpacked bundle of an earlier release that failed (both are removed only after an update that
    // worked): only this release's stay for a retry, so failed releases in a row do not pile up on the Mac
    for (const [dir, keep] of [[up.download, file.file], [up.staging, target]] as const) {
      let names: string[] = []
      try { names = fs.readdirSync(dir) } catch {}
      for (const n of names) if (n !== keep) fs.rmSync(path.join(dir, n), { recursive: true, force: true })
    }
    const zip = await download(file, up.download, d)
    phase('unpack', `unpacking ${target}`, target)
    bundle = await unpack(zip, target, home, d)
    phase('precheck', `checking the new installer (${target})`, target)
    const chk = await d.exec(['/bin/bash', path.join(bundle, 'office-install.sh'), '--prefix', home, '--update', '--check-only'], { cwd: bundle, env: { ...toolEnv(home), TEAMAX_UPDATE_RUN: '1' }, capture: true, timeoutMs: 5 * 60_000 })
    if (chk.code !== 0) return fail(`the new installer's check failed: ${chk.out.split('\n').slice(-3).join(' ').slice(0, 600)}`)
    // running answers finish first. The nightly run waits until quietBy and then leaves the update for a later run;
    // "update now" (and the last resort) waits idleWaitMs, then an answer still running is interrupted. A count the
    // server did not write lately (status.json older than 2 minutes) counts as running while the server answers.
    // what keeps the update waiting, '' for nothing: running answers, the server's own maintenance (a backup)
    const busy = async (): Promise<string> => {
      const now = d.now().getTime()
      const m = serverMaintenance(home, now)
      const n = runningAnswers(home, now)
      if (n !== null) return n > 0 ? `${n} answer(s) still running` : m ? `the server's ${m} still running` : ''
      return (await d.health(s.appPort)) === null ? '' : 'answers may be running (the server has not said lately)'
    }
    let patient = o.reason === 'schedule' && !!o.quietBy && !o.lastResort
    let idleEnd = patient ? o.quietBy!.getTime() : d.now().getTime() + (o.idleWaitMs ?? IDLE_WAIT_MS)
    let why = await busy()
    while (why && d.now().getTime() < idleEnd) {
      phase('wait-idle', `waiting: ${why}`, target)
      await d.sleep(15_000)
      // "update now" while the nightly run waits: it waits as "update now" does from here
      if (patient && takeRequest(home)) { patient = false; idleEnd = d.now().getTime() + (o.idleWaitMs ?? IDLE_WAIT_MS); d.log('update now asked while waiting') }
      why = await busy()
    }
    if (why && patient) {
      const since = patchUpdateState(home, (x) => { x.deferred = { version: target, since: x.deferred?.since ?? d.now().toISOString() } }).deferred!.since
      return { kind: 'skipped', version: target, message: `${why} when the update window's wait ended (${o.quietBy!.toISOString()}); ${target} waits for a quiet moment in the update window (deferred since ${since})` }
    }
    if (why) d.log(`${why}: installing anyway${o.lastResort ? ' (deferred for 3 days)' : ''}`)
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
    const w = await waitVersion(s.appPort, target, d, o.healthWaitMs ?? HEALTH_WAIT_MS, o.migrateWaitMs ?? MIGRATE_WAIT_MS)
    const v = w.version
    if (v !== target) {
      problem = w.stillMigrating ? `${target} was still updating its database after ${Math.round((o.migrateWaitMs ?? MIGRATE_WAIT_MS) / 60_000)} min`
        : v ? `the server answers as ${v}, not ${target}`
        : w.sawMigrating ? `${target} did not answer on 127.0.0.1:${s.appPort} after it updated its database`
        : `${target} did not answer on 127.0.0.1:${s.appPort}`
    } else {
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
    x.deferred = null
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
