// The srt runner of the dev environment (docs/research/srt-dev-env.md). On with MYCEL_DEV_ENV_RUNNER=srt; the box
// (mycel-boxd) stays the default until a later PR removes it. The AI's commands run on the team server as the server
// account, inside Anthropic's sandbox runtime srt (bwrap, a proxy with a domain allowlist), in a `systemd-run --scope`
// unit with memory, CPU and pids limits. Each command, job or dev server is one srt process in its own scope.
//
// Kinds of run:
//  - command (box_shell): the call waits for it. One per project at a time; at most maxRunning + 1 on the server, past
//    that the call is refused at once.
//  - job (job=true): a row in dev_env_jobs. Over maxRunning it waits in a FIFO queue (state waiting) and starts when a
//    slot is free. At most 3 waiting per project and 10 on the server. A waiting job ends "expired" after 24 hours.
//  - dev server (background=true): a row with kind server. At most maxRunning on the server and one per project.
//
// Runs keep going when the server restarts: their output goes to files, and the tracker finds them again by the
// unit name in the row. A unit with no row is stopped.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { DevEnvTeamSetting, type DevEnvRun, type DevEnvRuns } from '@mycel/shared/api'
import type { BoxdExit, BoxdJob } from '@mycel/shared'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { getSetting } from '../../admin/settings'
import { storageRoom } from '../../system/storage'
import { devEnvSetting, mayUseBox } from '../setting'
import { RUN_ID_RE, devenvPaths, resolveRunCwd, runEnv, settingsProblems, srtSettings, unitName, UNIT_RE } from './config'
import { effectiveLimits, loadPlan, NO_PLAN_MAX_RUNNING, type DevEnvPlan, type PlanState } from './plan'
import { directSystem, systemdSystem, type SrtSystem } from './system'

export const TEAM_SETTING_KEY = 'devEnv.team'
export const MAX_WAITING_PER_PROJECT = 3
export const MAX_WAITING_SERVER = 10
export const WAIT_MAX_MS = 24 * 3600_000
export const JOB_MAX_SEC = 6 * 3600
export const SERVER_MAX_SEC = 8 * 3600
export const LOG_MAX_BYTES = 64 << 20
const OUT_READ = 64 << 10
const TAIL_BYTES = 4 << 10
/** a dev server under this CPU share for idleStopMin stops (reason idle) */
const IDLE_CPU_SHARE = 0.02

export type EndReason = 'exit' | 'timeout' | 'oom' | 'stopped' | 'idle' | 'disk' | 'setting' | 'expired' | 'lost'

/** what each end reason says to people and to the AI */
export const END_NOTE: Record<EndReason, string> = {
  exit: '',
  timeout: 'stopped at its time limit',
  oom: 'stopped: it ran out of memory',
  stopped: 'stopped by a person',
  idle: 'stopped: unused',
  disk: 'stopped: the server disk is nearly full',
  setting: 'stopped: the dev environment setting changed, or the person lost access',
  expired: 'did not start: it waited for 24 hours',
  lost: 'the run ended with no exit code',
}

// ---------------- configuration ----------------

export interface SrtConfig { base: string; id: string; system: SrtSystem; planFile: string }

let systemOverride: SrtSystem | null = null
let configOverride: (Partial<SrtConfig> & { plan?: DevEnvPlan | null }) | null = null
/** tests: a fake system, other folders, a plan (the real file must belong to root) */
export function setSrtSystem(s: SrtSystem | null, c: (Partial<SrtConfig> & { plan?: DevEnvPlan | null }) | null = null) { systemOverride = s; configOverride = c; reset() }

export function srtConfig(env: Record<string, string | undefined> = process.env): SrtConfig {
  const id = configOverride?.id ?? env.MYCEL_LABEL ?? 'mycel'
  const base = configOverride?.base ?? env.MYCEL_INSTALL_BASE ?? `/var/lib/${id}`
  const system = systemOverride ?? (env.MYCEL_DEV_ENV_SRT_DIRECT === '1' ? directSystem() : systemdSystem(id))
  return { id, base, system, planFile: configOverride?.planFile ?? path.join(base, 'root', 'dev-env.json') }
}

/** the team's extra domains (admins, devEnv.team) */
export function teamSetting(db: Database): DevEnvTeamSetting {
  const v = DevEnvTeamSetting.safeParse(getSetting(db, TEAM_SETTING_KEY))
  return v.success ? v.data : { extraDomains: [] }
}

const listEnv = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)

/** The host names of this Trina server: its public origins, the relay, and MYCEL_DEV_ENV_DENY_HOSTS. A run may not
 * reach them through the proxy, and an admin may not allow them. */
export function teamHosts(ctx: Pick<AppContext, 'config'>, env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>(listEnv(env.MYCEL_DEV_ENV_DENY_HOSTS).map((h) => h.toLowerCase()))
  for (const u of [...(ctx.config.publicOrigins ?? []), ctx.config.relay?.url ?? '']) {
    try { const h = new URL(u).hostname.toLowerCase(); if (h && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(h)) out.add(h) } catch {}
  }
  return [...out]
}

/** This VM's public IPv4 from EC2's metadata service (IMDSv2), cached for a minute. Only with MYCEL_DEV_ENV_IMDS=1
 * (the install sets it on EC2). An instance with no Elastic IP gets a new address after a stop. */
let imds: { at: number; ips: string[] } | null = null
async function publicIps(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  if (env.MYCEL_DEV_ENV_IMDS !== '1') return []
  if (imds && Date.now() - imds.at < 60_000) return imds.ips
  let ips: string[] = []
  try {
    const t = await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(1000) })
    const token = await t.text()
    const r = await fetch('http://169.254.169.254/latest/meta-data/public-ipv4', { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1000) })
    const ip = r.ok ? (await r.text()).trim() : ''
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ips = [ip]
  } catch {}
  imds = { at: Date.now(), ips }
  return ips
}

// ---------------- state of this server process ----------------

interface Active { runId: string; projectId: string; kind: 'command' | 'job' | 'server'; userId: string; command: string; startedAt: string; pid: number; stopReason: EndReason | null; rowId?: string }
/** runs started by this process (the tracker also finds runs from before a restart through the rows) */
const active = new Map<string, Active>()
/** one command at a time per project */
const projectLocks = new Map<string, Promise<void>>()
/** dev servers: CPU time at the last poll, and since when they are idle */
const idleSince = new Map<string, { usec: number; at: number; since: number | null }>()
function reset() { active.clear(); projectLocks.clear(); idleSince.clear(); imds = null; planCache = null; selfTest = null }

let planCache: { at: number; state: PlanState } | null = null
let selfTest: { at: number; problem: string } | null = null
export function planState(c = srtConfig()): PlanState {
  if (configOverride && configOverride.plan !== undefined) return { ok: true, plan: configOverride.plan }
  if (planCache && Date.now() - planCache.at < 30_000) return planCache.state
  planCache = { at: Date.now(), state: loadPlan(c.planFile) }
  return planCache.state
}

export const newRunId = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return [...crypto.randomBytes(16)].map((b) => a[b % 36]).join('')
}

// ---------------- availability ----------------

/** Can this server run srt? '' = yes, else why not. Checks the files of the install and that a scope can be made. */
export async function srtProblem(c = srtConfig()): Promise<string> {
  const p = planState(c)
  if (!p.ok) return p.reason
  if (!systemOverride) {
    const { SRT_PATHS } = await import('./config')
    for (const f of [SRT_PATHS.node, SRT_PATHS.cli, SRT_PATHS.runWrap]) if (!fs.existsSync(f)) return `${f} is missing: run scripts/dev-env/srt/install-srt.sh`
    for (const b of ['bwrap', 'socat', 'rg']) if (!['/usr/bin', '/bin', '/usr/local/bin'].some((d) => fs.existsSync(path.join(d, b)))) return `${b} is missing`
  }
  if (!selfTest || Date.now() - selfTest.at > 10 * 60_000) selfTest = { at: Date.now(), problem: await c.system.selfTest(c.id) }
  return selfTest.problem
}

// ---------------- one run ----------------

interface RunSpec { runId: string; projectId: string; projectDir: string; cwd: string; command: string; network: 'open' | 'offline'; limits: { cpus: number; memoryMiB: number; pids: number }; runtimeMaxSec: number; stdoutFile: string; stderrFile: string }

function prepare(ctx: AppContext, c: SrtConfig, projectId: string) {
  const p = devenvPaths(c.base, projectId)
  for (const d of [p.root, p.run, path.dirname(p.home), path.dirname(p.logs)]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(p.home, 'tmp'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(p.logs, { recursive: true, mode: 0o750 })
  return p
}

async function spawnRun(ctx: AppContext, c: SrtConfig, s: RunSpec): Promise<{ pid: number; exited: Promise<{ code: number | null; signal: string | null }> }> {
  const p = prepare(ctx, c, s.projectId)
  const input = {
    base: c.base, id: c.id, projectId: s.projectId, projectDir: s.projectDir, teamRoot: ctx.files.fx.root, network: s.network,
    extraDomains: teamSetting(ctx.db).extraDomains,
    denyHosts: teamHosts(ctx),
    denyAddrs: [...listEnv(process.env.MYCEL_DEV_ENV_DENY_ADDRS), ...await publicIps()],
  }
  const settings = srtSettings(input)
  const problems = settingsProblems(settings, { base: c.base, projectDir: s.projectDir, teamRoot: ctx.files.fx.root })
  if (problems.length) throw new Error(`refused settings: ${problems.join('; ')}`)
  // a cwd through a link out of the project folder is refused before the run (attack A10)
  const cwd = resolveRunCwd(s.projectDir, s.cwd)
  if (!cwd) throw new Error('cwd must be a folder inside the project folder')
  const settingsFile = path.join(p.run, `${s.runId}.json`)
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
  const exitFile = path.join(p.logs, `${s.runId}.exit`)
  return c.system.spawn({
    runId: s.runId, id: c.id, cwd, env: runEnv({ base: c.base, projectId: s.projectId }),
    limits: { cpus: s.limits.cpus, memoryMiB: s.limits.memoryMiB, pids: s.limits.pids, runtimeMaxSec: s.runtimeMaxSec }, exitFile, settingsFile, command: s.command,
    stdoutFile: s.stdoutFile, stderrFile: s.stderrFile,
  })
}

function readHead(file: string, max: number): { text: string; cut: boolean } {
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch { return { text: '', cut: false } }
  try {
    const buf = Buffer.alloc(max + 1)
    const n = fs.readSync(fd, buf, 0, max + 1, 0)
    return { text: buf.subarray(0, Math.min(n, max)).toString('utf8'), cut: n > max }
  } finally { fs.closeSync(fd) }
}

function readTail(file: string, max: number): string {
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch { return '' }
  try {
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, max)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    let t = buf.toString('utf8')
    if (size > max) t = t.slice(t.indexOf('\n') + 1)
    return t
  } finally { fs.closeSync(fd) }
}
const lastLine = (tail: string) => tail.trimEnd().split('\n').pop() ?? ''

/** the exit code that run-wrap wrote, or null */
export function readExit(file: string): number | null {
  const t = readHead(file, 16).text.trim()
  if (!/^\d{1,3}$/.test(t)) return null
  const n = Number(t)
  return n <= 255 ? n : null
}

const rm = (f: string) => { try { fs.rmSync(f, { force: true }) } catch {} }

/** the server limit for commands: maxRunning + 1 */
function limitsFor(ctx: AppContext, projectId: string): { ok: true; l: ReturnType<typeof effectiveLimits> } | { ok: false; message: string } {
  const p = planState()
  if (!p.ok) return { ok: false, message: `the dev environment is not available: ${p.reason}` }
  const s = devEnvSetting(ctx.db, projectId)
  return { ok: true, l: effectiveLimits(s.limits, s.network, p.plan) }
}

async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const before = projectLocks.get(projectId) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => { release = r })
  const chain = before.then(() => mine)
  projectLocks.set(projectId, chain)
  await before
  try { return await fn() } finally {
    release()
    if (projectLocks.get(projectId) === chain) projectLocks.delete(projectId)
  }
}

/** A foreground command: the call waits for it. The answer has the shape of boxd's exec answer, so tool.ts reads both
 * runners the same way. */
/** Is there a command slot on the server? (maxRunning + 1 commands at the same time). The tool asks before the change
 * window, so a call over the limit is refused at once and does not wait. */
export function commandSlotFree(ctx: AppContext, projectId: string): { ok: true } | { ok: false; message: string } {
  const lim = limitsFor(ctx, projectId)
  if (!lim.ok) return lim
  const commands = [...active.values()].filter((a) => a.kind === 'command').length
  return commands >= lim.l.maxRunning + 1 ? { ok: false, message: 'busy: the dev environment is busy, try again in a minute' } : { ok: true }
}

export async function runCommand(ctx: AppContext, o: { projectId: string; projectDir: string; cwd: string; command: string; timeoutMs: number; userId: string; signal?: AbortSignal }): Promise<{ ok: true; value: BoxdExit } | { ok: false; message: string }> {
  const c = srtConfig()
  const lim = limitsFor(ctx, o.projectId)
  if (!lim.ok) return lim
  const slot = commandSlotFree(ctx, o.projectId)
  if (!slot.ok) return slot
  return withProjectLock(o.projectId, async () => {
    const runId = newRunId()
    const p = prepare(ctx, c, o.projectId)
    const out = path.join(p.logs, `cmd-${runId}.out`), err = path.join(p.logs, `cmd-${runId}.err`), exitFile = path.join(p.logs, `${runId}.exit`)
    const started = Date.now()
    const a: Active = { runId, projectId: o.projectId, kind: 'command', userId: o.userId, command: o.command.slice(0, 300), startedAt: new Date(started).toISOString(), pid: 0, stopReason: null }
    active.set(runId, a)
    let oom = false
    try {
      const sp = await spawnRun(ctx, c, {
        runId, projectId: o.projectId, projectDir: o.projectDir, cwd: o.cwd, command: o.command, network: lim.l.network,
        limits: lim.l, runtimeMaxSec: Math.ceil(o.timeoutMs / 1000) + 30, stdoutFile: out, stderrFile: err,
      })
      a.pid = sp.pid
      const stop = (why: EndReason) => { if (!a.stopReason) { a.stopReason = why; void c.system.stop(runId, sp.pid) } }
      const t = setTimeout(() => stop('timeout'), o.timeoutMs)
      const onAbort = () => stop('stopped')
      o.signal?.addEventListener('abort', onAbort, { once: true })
      // the scope's cgroup goes away when the run ends, so its OOM count is read while it runs
      const watch = setInterval(() => { if ((c.system.oomKills(runId) ?? 0) > 0) oom = true }, 1000)
      const ended = await sp.exited
      clearTimeout(t); clearInterval(watch); o.signal?.removeEventListener('abort', onAbort)
      if ((c.system.oomKills(runId) ?? 0) > 0) oom = true
      const u = await c.system.unit(runId)
      if (u.result === 'oom-kill') oom = true
      if (u.state === 'failed') await c.system.forget(runId)
      const code = readExit(exitFile)
      const so = readHead(out, OUT_READ), se = readHead(err, OUT_READ)
      const signal = a.stopReason === 'timeout' ? 'timeout' : a.stopReason ? 'stopped' : oom ? 'oom' : ''
      return { ok: true as const, value: { ev: 'exit' as const, code: code ?? ended.code ?? 137, signal, stdout: so.text, stderr: se.text, truncated: so.cut || se.cut, ms: Date.now() - started } }
    } catch (e) {
      return { ok: false as const, message: (e as Error).message.slice(0, 300) }
    } finally {
      active.delete(runId)
      rm(out); rm(err); rm(exitFile); rm(path.join(p.run, `${runId}.json`))
    }
  })
}

// ---------------- jobs and dev servers (rows) ----------------

interface RunRow { id: string; project_id: string; name: string; user_id: string; command: string; started_at: string; run_at: string | null; state: 'waiting' | 'running' | 'ended'; kind: 'job' | 'server'; cwd: string; unit: string; last_line: string }
const RCOLS = 'id, project_id, name, user_id, command, started_at, run_at, state, kind, cwd, unit, last_line'

const openRuns = (db: Database, state: 'waiting' | 'running', kind?: 'job' | 'server') =>
  db.query(`SELECT ${RCOLS} FROM dev_env_jobs WHERE ended_at IS NULL AND state = ? ${kind ? 'AND kind = ?' : ''} ORDER BY started_at, id`).all(...(kind ? [state, kind] : [state])) as RunRow[]

const runIdOf = (unit: string) => (UNIT_RE.test(unit) ? unit.slice('trina-dev-'.length, -'.scope'.length) : '')
const logFile = (c: SrtConfig, projectId: string, name: string) => path.join(devenvPaths(c.base, projectId).logs, `${name}.log`)

export type SubmitResult = { ok: true; state: 'running' | 'waiting'; position: number | null; rowId: string } | { ok: false; message: string }

/** The command of a row that has not started: a file in the run folder (0600, hidden from the sandbox). The row keeps
 * only the text with secrets hidden (`shown`), as for the box. */
const commandFile = (c: SrtConfig, rowId: string) => path.join(devenvPaths(c.base).run, `${rowId}.cmd`)
function keepCommand(_ctx: AppContext, rowId: string, command: string) {
  const c = srtConfig()
  fs.mkdirSync(devenvPaths(c.base).run, { recursive: true, mode: 0o700 })
  fs.writeFileSync(commandFile(c, rowId), command, { mode: 0o600 })
}
function takeCommand(c: SrtConfig, rowId: string): string | null {
  const f = commandFile(c, rowId)
  try { const t = fs.readFileSync(f, 'utf8'); rm(f); return t } catch { return null }
}

/** Start a job, or put it in the queue. `shown` is the command with secrets hidden: the text of the row. */
export async function submitJob(ctx: AppContext, j: { projectId: string; name: string; userId: string; chatId?: string | null; turnId: string; command: string; shown: string; cwd: string }): Promise<SubmitResult> {
  const lim = limitsFor(ctx, j.projectId)
  if (!lim.ok) return lim
  const waiting = openRuns(ctx.db, 'waiting')
  if (waiting.filter((r) => r.project_id === j.projectId).length >= MAX_WAITING_PER_PROJECT) return { ok: false, message: `queue full: this project has ${MAX_WAITING_PER_PROJECT} jobs waiting. Wait for one to start, or stop one.` }
  if (waiting.length >= MAX_WAITING_SERVER) return { ok: false, message: `queue full: ${MAX_WAITING_SERVER} jobs wait on this server. Try again later.` }
  const id = newId()
  keepCommand(ctx, id, j.command)
  ctx.db.query('INSERT INTO dev_env_jobs (id, project_id, name, user_id, chat_id, turn_id, command, started_at, state, kind, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, j.projectId, j.name, j.userId, j.chatId ?? null, j.turnId, j.shown.slice(0, 500), new Date().toISOString(), 'waiting', 'job', j.cwd)
  await startWaiting(ctx)
  const row = ctx.db.query('SELECT state, ended_at, end_note FROM dev_env_jobs WHERE id = ?').get(id) as { state: string; ended_at: string | null; end_note: string }
  if (row.ended_at) return { ok: false, message: row.end_note || 'the job could not start' }
  if (row.state === 'running') return { ok: true, state: 'running', position: null, rowId: id }
  const pos = openRuns(ctx.db, 'waiting').findIndex((r) => r.id === id) + 1
  return { ok: true, state: 'waiting', position: pos, rowId: id }
}

/** Start a dev server now, or refuse (no queue). */
export async function startServer(ctx: AppContext, j: { projectId: string; name: string; userId: string; chatId?: string | null; turnId: string; command: string; shown: string; cwd: string }): Promise<{ ok: true; rowId: string } | { ok: false; message: string }> {
  const lim = limitsFor(ctx, j.projectId)
  if (!lim.ok) return lim
  const servers = openRuns(ctx.db, 'running', 'server')
  const mine = servers.filter((r) => r.project_id === j.projectId)
  if (mine.length) return { ok: false, message: `a dev server runs in this project already (${mine.map((r) => r.name).join(', ')}). Stop it first (the project page, or a stop of its log name).` }
  if (servers.length >= lim.l.maxRunning) return { ok: false, message: `${servers.length} dev servers run on this server, the most it allows. Ask a person to stop one on its project page.` }
  const id = newId()
  keepCommand(ctx, id, j.command)
  ctx.db.query('INSERT INTO dev_env_jobs (id, project_id, name, user_id, chat_id, turn_id, command, started_at, state, kind, cwd, ai_told_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, j.projectId, j.name, j.userId, j.chatId ?? null, j.turnId, j.shown.slice(0, 500), new Date().toISOString(), 'waiting', 'server', j.cwd, new Date().toISOString())
  const row = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_jobs WHERE id = ?`).get(id) as RunRow
  const r = await startRow(ctx, row)
  return r.ok ? { ok: true, rowId: id } : r
}

/** the hook that ends a row (jobs.ts endJob, set by jobs.ts to keep one place for notices) */
type Ender = (ctx: AppContext, rowId: string, end: { code: number | null; reason: EndReason; tail: string; lastLine: string }) => void
let ender: Ender = (ctx, rowId, end) => {
  ctx.db.query("UPDATE dev_env_jobs SET ended_at = ?, state = 'ended', exit_code = ?, end_note = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
    .run(new Date().toISOString(), end.code, END_NOTE[end.reason], end.reason, rowId)
}
export function setEnder(e: Ender) { ender = e }

async function startRow(ctx: AppContext, row: RunRow): Promise<{ ok: true } | { ok: false; message: string }> {
  const c = srtConfig()
  const project = ctx.db.query('SELECT id, folder_path, trashed_with FROM projects WHERE id = ?').get(row.project_id) as { id: string; folder_path: string } | null
  // the person must still be allowed at the start (the setting or the folder rules can change while a job waits)
  if (!project || !project.folder_path || !mayUseBox(ctx.db, ctx.files, { id: project.id, folderPath: project.folder_path }, row.user_id)) {
    ender(ctx, row.id, { code: null, reason: 'setting', tail: '', lastLine: '' })
    return { ok: false, message: 'the dev environment is off for this project or for this person now' }
  }
  const lim = limitsFor(ctx, row.project_id)
  if (!lim.ok) { ender(ctx, row.id, { code: null, reason: 'setting', tail: '', lastLine: '' }); return lim }
  const command = takeCommand(c, row.id)
  if (command === null) { ender(ctx, row.id, { code: null, reason: 'lost', tail: '', lastLine: '' }); return { ok: false, message: 'the command of this job is gone' } }
  const runId = newRunId()
  const log = logFile(c, row.project_id, row.name)
  prepare(ctx, c, row.project_id)
  rm(log)
  const projectDir = path.join(ctx.files.fx.root, project.folder_path)
  try {
    const sp = await spawnRun(ctx, c, {
      runId, projectId: row.project_id, projectDir, cwd: row.cwd, command, network: lim.l.network, limits: lim.l,
      runtimeMaxSec: row.kind === 'server' ? SERVER_MAX_SEC : JOB_MAX_SEC, stdoutFile: log, stderrFile: log,
    })
    active.set(runId, { runId, projectId: row.project_id, kind: row.kind, userId: row.user_id, command: row.command.slice(0, 300), startedAt: new Date().toISOString(), pid: sp.pid, stopReason: null, rowId: row.id })
    void sp.exited.then(() => { const a = active.get(runId); if (a) active.delete(runId) })
    ctx.db.query("UPDATE dev_env_jobs SET state = 'running', run_at = ?, unit = ? WHERE id = ?").run(new Date().toISOString(), unitName(runId), row.id)
    return { ok: true }
  } catch (e) {
    ender(ctx, row.id, { code: null, reason: 'lost', tail: (e as Error).message.slice(0, 300), lastLine: '' })
    return { ok: false, message: (e as Error).message.slice(0, 300) }
  }
}

/** Start waiting jobs while there are free slots, oldest first. Expired ones end. */
export async function startWaiting(ctx: AppContext): Promise<void> {
  const p = planState()
  const max = p.ok ? (p.plan?.maxRunning ?? NO_PLAN_MAX_RUNNING) : 0
  for (const w of openRuns(ctx.db, 'waiting', 'job')) {
    if (Date.now() - Date.parse(w.started_at) > WAIT_MAX_MS) { takeCommand(srtConfig(), w.id); ender(ctx, w.id, { code: null, reason: 'expired', tail: '', lastLine: '' }); continue }
    if (openRuns(ctx.db, 'running', 'job').length >= max) return
    await startRow(ctx, w)
  }
}

/** What the tracker reads for one running row: still running, or ended with a code and a reason. */
async function rowStatus(ctx: AppContext, c: SrtConfig, r: RunRow): Promise<{ running: true; tail: string } | { running: false; code: number | null; reason: EndReason; tail: string }> {
  const runId = runIdOf(r.unit)
  const log = logFile(c, r.project_id, r.name)
  const tail = readTail(log, TAIL_BYTES)
  if (!runId) return { running: false, code: null, reason: 'lost', tail }
  const exitFile = path.join(devenvPaths(c.base, r.project_id).logs, `${runId}.exit`)
  const code = readExit(exitFile)
  const a = active.get(runId)
  if (code !== null) {
    rm(exitFile); rm(path.join(devenvPaths(c.base).run, `${runId}.json`))
    return { running: false, code, reason: a?.stopReason ?? 'exit', tail }
  }
  const u = await c.system.unit(runId)
  if (u.state === 'active' || u.state === 'activating' || u.state === 'deactivating' || (a && !a.stopReason && u.state === '' && a.pid && alive(a.pid))) {
    // a large log: cut it, the AI reads only the end
    try { if (fs.statSync(log).size > LOG_MAX_BYTES) { fs.truncateSync(log, 0); fs.appendFileSync(log, '(log cut at 64 MiB)\n') } } catch {}
    return { running: true, tail }
  }
  if (u.state === 'failed') await c.system.forget(runId)
  rm(path.join(devenvPaths(c.base).run, `${runId}.json`))
  const reason: EndReason = a?.stopReason ?? (u.result === 'oom-kill' ? 'oom' : u.result === 'timeout' ? 'timeout' : 'lost')
  return { running: false, code: null, reason, tail }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** The tracker's step for the srt runner: end rows whose run ended, stop idle dev servers, stop everything at the
 * disk floor, start waiting jobs. Returns the BoxdJob view of each row it read, for jobs.ts. */
export async function pollRuns(ctx: AppContext, projectId?: string): Promise<{ rows: Map<string, BoxdJob & { reason?: EndReason }>; diskStopped: string[] }> {
  const c = srtConfig()
  const out = new Map<string, BoxdJob & { reason?: EndReason }>()
  const room = storageRoom(0)
  const diskStopped = room && !room.ok ? await stopAll(ctx, 'disk') : []
  for (const r of openRuns(ctx.db, 'running')) {
    if (projectId && r.project_id !== projectId) continue
    const s = await rowStatus(ctx, c, r)
    const seconds = Math.round((Date.now() - Date.parse(r.run_at ?? r.started_at)) / 1000)
    if (s.running) {
      out.set(r.id, { name: r.name, state: 'running', code: null, seconds, tail: s.tail, lastLine: lastLine(s.tail) })
      if (r.kind === 'server') await idleCheck(ctx, c, r)
    } else {
      out.set(r.id, { name: r.name, state: 'ended', code: s.code, seconds, tail: s.tail, lastLine: lastLine(s.tail), why: END_NOTE[s.reason], reason: s.reason })
      const runId = runIdOf(r.unit)
      active.delete(runId); idleSince.delete(runId)
    }
  }
  return { rows: out, diskStopped }
}

async function idleCheck(ctx: AppContext, c: SrtConfig, r: RunRow) {
  const runId = runIdOf(r.unit)
  const usec = c.system.cpuUsec(runId)
  if (usec === null) return
  const now = Date.now()
  const prev = idleSince.get(runId)
  if (!prev) { idleSince.set(runId, { usec, at: now, since: null }); return }
  const share = (usec - prev.usec) / 1000 / Math.max(1, now - prev.at)
  const since = share < IDLE_CPU_SHARE ? (prev.since ?? prev.at) : null
  idleSince.set(runId, { usec, at: now, since })
  const idleMin = devEnvSetting(ctx.db, r.project_id).limits.idleStopMin
  if (since !== null && now - since >= idleMin * 60_000) await stopRow(ctx, r, 'idle')
}

async function stopRow(ctx: AppContext, r: RunRow, reason: EndReason) {
  const c = srtConfig()
  if (r.state === 'waiting') { takeCommand(c, r.id); ender(ctx, r.id, { code: null, reason, tail: '', lastLine: '' }); return }
  const runId = runIdOf(r.unit)
  const a = active.get(runId)
  if (a) a.stopReason = reason
  if (runId) await c.system.stop(runId, a?.pid)
  const tail = readTail(logFile(c, r.project_id, r.name), TAIL_BYTES)
  rm(path.join(devenvPaths(c.base, r.project_id).logs, `${runId}.exit`))
  ender(ctx, r.id, { code: null, reason, tail, lastLine: lastLine(tail) })
  active.delete(runId); idleSince.delete(runId)
}

/** Stop one run by its row id or run id (a person on the project page). False when there is no such run here. */
export async function stopRun(ctx: AppContext, projectId: string, id: string, reason: EndReason = 'stopped'): Promise<boolean> {
  const row = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_jobs WHERE id = ? AND project_id = ? AND ended_at IS NULL`).get(id, projectId) as RunRow | null
  if (row) { await stopRow(ctx, row, reason); return true }
  const a = RUN_ID_RE.test(id) ? active.get(id) : undefined
  if (a && a.projectId === projectId && a.kind === 'command') { a.stopReason = reason; await srtConfig().system.stop(id, a.pid); return true }
  return false
}

/** Stop a dev server or a job by its log name (box_shell with the name of a running one is refused; this is the
 * person's way). */
export const runByName = (db: Database, projectId: string, name: string) =>
  db.query('SELECT id FROM dev_env_jobs WHERE project_id = ? AND name = ? AND ended_at IS NULL').get(projectId, name) as { id: string } | null

/** Stop every run of a project (the setting changed, the person pressed Stop). Waiting jobs end too. */
export async function stopProject(ctx: AppContext, projectId: string, reason: EndReason): Promise<void> {
  const rows = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_jobs WHERE project_id = ? AND ended_at IS NULL`).all(projectId) as RunRow[]
  for (const r of rows) await stopRow(ctx, r, reason)
  for (const a of active.values()) if (a.projectId === projectId && a.kind === 'command') { a.stopReason = reason; await srtConfig().system.stop(a.runId, a.pid) }
}

export async function stopAll(ctx: AppContext, reason: EndReason): Promise<string[]> {
  const projects = new Set<string>([...(ctx.db.query('SELECT DISTINCT project_id FROM dev_env_jobs WHERE ended_at IS NULL').all() as { project_id: string }[]).map((r) => r.project_id), ...[...active.values()].map((a) => a.projectId)])
  for (const p of projects) await stopProject(ctx, p, reason)
  return [...projects]
}

/** After a restart: a trina-dev unit with no open row and no command of this process is stopped. Rows with no unit
 * end at the next poll (lost). */
export async function reconcile(ctx: AppContext): Promise<void> {
  const c = srtConfig()
  const known = new Set((ctx.db.query("SELECT unit FROM dev_env_jobs WHERE ended_at IS NULL AND unit != ''").all() as { unit: string }[]).map((r) => r.unit))
  for (const a of active.values()) known.add(unitName(a.runId))
  for (const u of await c.system.units()) {
    if (known.has(u)) continue
    const runId = runIdOf(u)
    await c.system.stop(runId)
    await c.system.forget(runId)
  }
}

/** What runs and what waits, for the project page. */
export async function runsOf(ctx: AppContext, projectId: string): Promise<DevEnvRuns> {
  const c = srtConfig()
  const names = (ids: string[]) => new Map((ids.length ? ctx.db.query(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; name: string }[] : []).map((u) => [u.id, u.name]))
  const running = openRuns(ctx.db, 'running').filter((r) => r.project_id === projectId)
  const waitingAll = openRuns(ctx.db, 'waiting')
  const commands = [...active.values()].filter((a) => a.projectId === projectId && a.kind === 'command')
  const who = names([...new Set([...running, ...waitingAll].map((r) => r.user_id).concat(commands.map((a) => a.userId)))])
  const ref = (id: string) => ({ id, name: who.get(id) ?? id })
  const out: DevEnvRun[] = []
  for (const r of running) {
    const u = await c.system.unit(runIdOf(r.unit))
    out.push({ id: r.id, kind: r.kind, name: r.name, by: ref(r.user_id), startedAt: r.started_at, runAt: r.run_at, position: null, memoryMiB: u.memoryBytes === null ? null : Math.round(u.memoryBytes / 1048576), lastLine: r.last_line })
  }
  for (const a of commands) out.push({ id: a.runId, kind: 'command', name: a.command.slice(0, 80), by: ref(a.userId), startedAt: a.startedAt, runAt: a.startedAt, position: null, memoryMiB: null, lastLine: '' })
  const waiting = waitingAll.map((r, i) => ({ r, i })).filter(({ r }) => r.project_id === projectId)
    .map(({ r, i }) => ({ id: r.id, kind: r.kind, name: r.name, by: ref(r.user_id), startedAt: r.started_at, runAt: null, position: i + 1, memoryMiB: null, lastLine: '' }))
  return { running: out, waiting }
}

/** tests */
export function _active() { return active }
