// The srt runner of the dev environment (docs/research/srt-dev-env.md). On with MYCEL_DEV_ENV_RUNNER=srt; the box
// (mycel-boxd) stays the default until a later PR removes it. The AI's commands run on the team server as the server
// account, inside Anthropic's sandbox runtime srt (bwrap, a proxy with a domain allowlist), in a `systemd-run --scope`
// unit with memory, CPU and pids limits. Each command, job or dev server is one srt process in its own scope.
//
// A run is not locked to a project. It belongs to the person who owns the chat: it may read and write exactly the team
// folders that person may open now (srt/access.ts, built from the folder rules for every command and every job start),
// plus the person's home (caches) and, for a chat with no project, the chat's work folder. The folder a run starts in
// (its root) is the project folder of a project chat, else the chat's work folder.
//
// Kinds of run:
//  - command (box_shell): the call waits for it. One per root at a time; at most maxRunning + 1 on the server, past
//    that the call is refused at once.
//  - job (job=true): a row in dev_env_runs. Over maxRunning it waits in a FIFO queue for the whole team (state
//    waiting) and starts when a slot is free. At most 3 waiting per person and 10 on the server. A waiting job ends
//    "expired" after 24 hours.
//  - dev server (background=true): a row with kind server. At most maxRunning on the server and one per chat.
//
// Runs keep going when the server restarts: their output goes to files, and the tracker finds them again by the
// unit name in the row. A unit with no row is stopped. The tracker also stops a job or dev server when the person's
// folder access changes or the person may no longer use the dev environment (reason setting).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { DevEnvRun, DevEnvRuns } from '@mycel/shared/api'
import type { BoxdExit, BoxdJob } from '@mycel/shared'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { storageRoom } from '../../system/storage'
import { resolveLayout } from '../../system/layout'
import { mayUseDevEnv, teamSetting } from '../setting'
import { folderView, viewAccess, viewHash, type FolderView, type RunWrites } from './access'
import { RUN_ID_RE, SRT_PATHS, chatWork, devenvPaths, isFull, personHome, personLogs, resolveRunCwd, runEnv, settingsProblems, srtSettings, unitName, UNIT_RE } from './config'
import { formatOnce, netNarrowed, netSnapshot, parseOnce, parseSnapshot, personNet, type NetSnapshot } from '../sites'
import { effectiveLimits, loadPlan, NO_PLAN_MAX_RUNNING, type DevEnvPlan, type PlanState } from './plan'
import { holdPlaceholders } from './placeholders'
import { directSystem, systemdSystem, type SrtSystem } from './system'

export const MAX_WAITING_PER_PERSON = 3
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
  setting: 'stopped: the dev environment setting, the allowed sites or the folder access of the person changed',
  expired: 'did not start: it waited for 24 hours',
  lost: 'the run ended with no exit code',
}

/** Where a run belongs and where it starts. root: the project folder (a project chat whose folder the person can
 * read), else the chat's work folder. */
export interface Space { userId: string; chatId: string | null; projectId: string | null; root: string }

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

interface Active { runId: string; space: Space; kind: 'command' | 'job' | 'server'; command: string; startedAt: string; pid: number; stopReason: EndReason | null; rowId?: string }
/** runs started by this process (the tracker also finds runs from before a restart through the rows) */
const active = new Map<string, Active>()
/** one command at a time per root folder (the change window of track.ts would mix two commands) */
const rootLocks = new Map<string, Promise<void>>()
/** dev servers: CPU time at the last poll, and since when they are idle */
const idleSince = new Map<string, { usec: number; at: number; since: number | null }>()
function reset() { active.clear(); rootLocks.clear(); idleSince.clear(); imds = null; planCache = null; selfTest = null }

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

// ---------------- the folder access of a person ----------------

/** The person's view, with only the folders that exist now (srt skips what is not there; a folder that appears later
 * changes the hash, and the tracker then stops the person's jobs). With `run`, the view of a run that starts there
 * (access.ts: only the starting folder and the person's own folder are writable). Null: the person cannot be loaded. */
export function personView(ctx: AppContext, userId: string, run?: RunWrites): FolderView | null {
  let p
  try { p = ctx.files.principal(userId) } catch { return null }
  const v = folderView(ctx.files.rules(), p, run)
  const root = ctx.files.fx.root
  const there = (rel: string) => { try { return fs.statSync(rel === '' ? root : path.join(root, rel)).isDirectory() } catch { return false } }
  return { read: v.read.filter(there), write: v.write.filter(there), denyRead: v.denyRead.filter(there), denyWrite: v.denyWrite.filter(there) }
}

/** The writable starting folder of a run in `space`: the project folder (team-relative), or null for the chat's work
 * folder (outside the team folder). */
function runWrites(ctx: AppContext, c: SrtConfig, space: Space): RunWrites {
  if (space.chatId && space.root === chatWork(c.base, space.chatId)) return { start: null }
  const team = ctx.files.fx.root
  if (!space.root.startsWith(team + '/')) throw new Error('the person cannot open the folder of this chat now')
  return { start: space.root.slice(team.length + 1) }
}
const runHash = (view: FolderView, run: RunWrites) => viewHash(view, run.start ?? '')

/** The hash a running job or dev server is checked against: the view of a run in this space, and whether the person
 * may still use the dev environment. */
export function accessHash(ctx: AppContext, space: Space): string {
  if (!mayUseDevEnv(ctx.db, ctx.files, space.userId)) return 'off'
  let run: RunWrites
  try { run = runWrites(ctx, srtConfig(), space) } catch { return 'off' }
  const v = personView(ctx, space.userId, run)
  return v ? runHash(v, run) : 'off'
}

/** May a run of this person start in `root` now? The root is the chat's work folder, or a team folder the person can
 * read. */
export function rootAllowed(ctx: AppContext, c: SrtConfig, space: Space, view: FolderView): boolean {
  if (space.chatId && space.root === chatWork(c.base, space.chatId)) return true
  const team = ctx.files.fx.root
  if (space.root !== team && !space.root.startsWith(team + '/')) return false
  const rel = space.root === team ? '' : space.root.slice(team.length + 1)
  return viewAccess(view, rel) !== 'none'
}

/** The root of a chat: the project folder when the chat has a project with a folder of its own that the person can
 * read, else the chat's work folder (made here). Null: no chat and no project folder. */
export function spaceOf(ctx: AppContext, o: { userId: string; chatId: string | null; project: { id: string; folderPath: string } | null }): Space | null {
  const c = srtConfig()
  const view = personView(ctx, o.userId)
  if (!view) return null
  if (o.project && o.project.folderPath !== '') {
    const root = path.join(ctx.files.fx.root, o.project.folderPath)
    if (viewAccess(view, o.project.folderPath) !== 'none' && fs.existsSync(root)) return { userId: o.userId, chatId: o.chatId, projectId: o.project.id, root }
  }
  if (!o.chatId) return null
  const root = chatWork(c.base, o.chatId)
  fs.mkdirSync(devenvPaths(c.base).work, { recursive: true, mode: 0o700 })
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  return { userId: o.userId, chatId: o.chatId, projectId: o.project?.id ?? null, root }
}

// ---------------- one run ----------------

interface RunSpec { runId: string; space: Space; cwd: string; command: string; network: 'open' | 'offline'; once: readonly string[]; limits: { cpus: number; memoryMiB: number; pids: number }; runtimeMaxSec: number; stdoutFile: string; stderrFile: string }

function prepare(c: SrtConfig, userId: string) {
  const p = devenvPaths(c.base)
  for (const d of [p.root, p.run, p.home, p.logs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  const home = personHome(c.base, userId), logs = personLogs(c.base, userId)
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(logs, { recursive: true, mode: 0o750 })
  return { ...p, personHome: home, personLogs: logs }
}

/** The server's own folders and files, from the server's config (not from the base folder of the env): the data
 * folder (the DB), the sockets, the engine folders, the secrets, the config file and the TLS key. srtSettings hides the
 * ones outside the base folder, and settingsProblems refuses a run when one is not hidden. Only paths that exist. */
export function serverPaths(ctx: Pick<AppContext, 'config' | 'engineConfig'>): string[] {
  const out: (string | null | undefined)[] = [ctx.config.dataDir, ctx.engineConfig.runDir, ctx.engineConfig.agentRoot, ctx.config.engine.launcherSock,
    ctx.config.configFile, ctx.config.tls?.keyFile]
  try { out.push(resolveLayout(ctx.config).secretsDir) } catch {}
  return [...new Set(out.filter((p): p is string => !!p && path.isAbsolute(p) && fs.existsSync(p)).map((p) => path.resolve(p)))]
}

/** Can this server run Full internet? full.mjs is installed (install-srt.sh). Without it Full internet acts as off:
 * the run gets the lists only (fail closed). */
export const fullAvailable = () => !!systemOverride || fs.existsSync(SRT_PATHS.cliFull)

/** The network of runs now: the team's choice cut to the plan ('offline' wins). */
export function networkNow(ctx: AppContext): 'open' | 'offline' {
  const l = limitsFor(ctx)
  return l.ok ? l.l.network : 'offline'
}

/** The network part of the person's runs now: the team's sites, her own sites and Full internet (sites.ts). */
export function personNetNow(ctx: AppContext, userId: string) {
  const p = personNet(ctx.db, userId, teamHosts(ctx))
  return { ...p, full: p.full && fullAvailable() }
}
const snapshotNow = (ctx: AppContext, userId: string): NetSnapshot => netSnapshot(teamSetting(ctx.db).extraDomains, personNetNow(ctx, userId))

/** The settings of a run, checked; throws with the reason when the run must not start. `once`: the sites allowed once
 * for this run (the turn's, or the row's). */
async function settingsFor(ctx: AppContext, c: SrtConfig, space: Space, network: 'open' | 'offline', once: readonly string[] = []) {
  const run = runWrites(ctx, c, space)
  const view = personView(ctx, space.userId, run)
  if (!view) throw new Error('the person cannot use the dev environment now')
  if (!rootAllowed(ctx, c, space, view)) throw new Error('the person cannot open the folder of this chat now')
  const work = run.start === null ? space.root : null
  const hosts = teamHosts(ctx)
  // only this person's sites and switch: another person's never reach this run
  const person = personNetNow(ctx, space.userId)
  const input = {
    base: c.base, id: c.id, teamRoot: ctx.files.fx.root, userId: space.userId, view, start: run.start, work, network,
    extraDomains: teamSetting(ctx.db).extraDomains,
    userDomains: [...person.sites, ...parseOnce(formatOnce(once), hosts)],
    full: person.full,
    denyHosts: hosts,
    denyAddrs: [...listEnv(process.env.MYCEL_DEV_ENV_DENY_ADDRS), ...await publicIps()],
    serverPaths: serverPaths(ctx),
  }
  const settings = srtSettings(input)
  const problems = settingsProblems(settings, input)
  if (problems.length) throw new Error(`refused settings: ${problems.join('; ')}`)
  return { settings, work, hash: runHash(view, run), net: netSnapshot(input.extraDomains, person) }
}

async function spawnRun(ctx: AppContext, c: SrtConfig, s: RunSpec): Promise<{ pid: number; exited: Promise<{ code: number | null; signal: string | null }>; hash: string; net: NetSnapshot }> {
  const p = prepare(c, s.space.userId)
  const { settings, work, hash, net } = await settingsFor(ctx, c, s.space, s.network, s.once)
  // a cwd through a link out of the root folder is refused before the run (attack A10)
  const cwd = resolveRunCwd(s.space.root, s.cwd)
  if (!cwd) throw new Error('cwd must be a folder inside the folder of this chat')
  const settingsFile = path.join(p.run, `${s.runId}.json`)
  fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
  const exitFile = path.join(p.personLogs, `${s.runId}.exit`)
  // srt's write denies in the cwd stay in force while other runs share it (placeholders.ts)
  const release = holdPlaceholders(cwd)
  let sp: Awaited<ReturnType<SrtSystem['spawn']>>
  try {
    sp = await c.system.spawn({
    runId: s.runId, id: c.id, cwd, env: runEnv({ base: c.base, userId: s.space.userId, teamRoot: ctx.files.fx.root, work }),
    limits: { cpus: s.limits.cpus, memoryMiB: s.limits.memoryMiB, pids: s.limits.pids, runtimeMaxSec: s.runtimeMaxSec }, exitFile, settingsFile, command: s.command,
    stdoutFile: s.stdoutFile, stderrFile: s.stderrFile, full: isFull(settings),
    })
  } catch (e) { release(); throw e }
  return { ...sp, exited: sp.exited.finally(release), hash, net }
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

/** The limits of a run: the team's wish, cut to the plan caps. */
function limitsFor(ctx: AppContext): { ok: true; l: ReturnType<typeof effectiveLimits> } | { ok: false; message: string } {
  const p = planState()
  if (!p.ok) return { ok: false, message: `the dev environment is not available: ${p.reason}` }
  const s = teamSetting(ctx.db)
  return { ok: true, l: effectiveLimits(s.limits, s.network, p.plan) }
}

async function withRootLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const before = rootLocks.get(root) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => { release = r })
  const chain = before.then(() => mine)
  rootLocks.set(root, chain)
  await before
  try { return await fn() } finally {
    release()
    if (rootLocks.get(root) === chain) rootLocks.delete(root)
  }
}

/** Is there a command slot on the server? (maxRunning + 1 commands at the same time). The tool asks before the change
 * window, so a call over the limit is refused at once and does not wait. */
export function commandSlotFree(ctx: AppContext): { ok: true } | { ok: false; message: string } {
  const lim = limitsFor(ctx)
  if (!lim.ok) return lim
  const commands = [...active.values()].filter((a) => a.kind === 'command').length
  return commands >= lim.l.maxRunning + 1 ? { ok: false, message: 'busy: the dev environment is busy, try again in a minute' } : { ok: true }
}

/** A foreground command: the call waits for it. The answer has the shape of boxd's exec answer, so tool.ts reads both
 * runners the same way. */
export async function runCommand(ctx: AppContext, o: { space: Space; cwd: string; command: string; shown?: string; timeoutMs: number; signal?: AbortSignal; once?: readonly string[] }): Promise<{ ok: true; value: BoxdExit } | { ok: false; message: string }> {
  const c = srtConfig()
  const lim = limitsFor(ctx)
  if (!lim.ok) return lim
  const slot = commandSlotFree(ctx)
  if (!slot.ok) return slot
  return withRootLock(o.space.root, async () => {
    const runId = newRunId()
    const p = prepare(c, o.space.userId)
    const out = path.join(p.personLogs, `cmd-${runId}.out`), err = path.join(p.personLogs, `cmd-${runId}.err`), exitFile = path.join(p.personLogs, `${runId}.exit`)
    const started = Date.now()
    // the lists show this text to other people: the command with secrets hidden, as in a job's row
    const a: Active = { runId, space: o.space, kind: 'command', command: (o.shown ?? o.command).slice(0, 300), startedAt: new Date(started).toISOString(), pid: 0, stopReason: null }
    active.set(runId, a)
    let oom = false
    try {
      const sp = await spawnRun(ctx, c, {
        runId, space: o.space, cwd: o.cwd, command: o.command, network: lim.l.network, once: o.once ?? [],
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

export interface RunRow { id: string; user_id: string; chat_id: string | null; project_id: string | null; turn_id: string | null; name: string; command: string; root: string; cwd: string; started_at: string; run_at: string | null; state: 'waiting' | 'running' | 'ended'; kind: 'job' | 'server'; unit: string; access: string; last_line: string; log_tail: string; once_domains: string; net: string }
export const RCOLS = 'id, user_id, chat_id, project_id, turn_id, name, command, root, cwd, started_at, run_at, state, kind, unit, access, last_line, log_tail, once_domains, net'

const openRuns = (db: Database, state: 'waiting' | 'running', kind?: 'job' | 'server') =>
  db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE ended_at IS NULL AND state = ? ${kind ? 'AND kind = ?' : ''} ORDER BY started_at, id`).all(...(kind ? [state, kind] : [state])) as RunRow[]
const spaceOfRow = (r: RunRow): Space => ({ userId: r.user_id, chatId: r.chat_id, projectId: r.project_id, root: r.root })

const runIdOf = (unit: string) => (UNIT_RE.test(unit) ? unit.slice('trina-dev-'.length, -'.scope'.length) : '')
const logFile = (c: SrtConfig, userId: string, name: string) => path.join(personLogs(c.base, userId), `${name}.log`)

/** Does a job or dev server with this log name still run or wait for this person? (The log is per person.) */
export const runNameInUse = (db: Database, userId: string, name: string) =>
  !!db.query('SELECT 1 FROM dev_env_runs WHERE user_id = ? AND name = ? AND ended_at IS NULL').get(userId, name)

export type SubmitResult = { ok: true; state: 'running' | 'waiting'; position: number | null; rowId: string } | { ok: false; message: string }

/** The command of a row that has not started: a file in the run folder (0600, hidden from the sandbox). The row keeps
 * only the text with secrets hidden (`shown`), as for the box. */
const commandFile = (c: SrtConfig, rowId: string) => path.join(devenvPaths(c.base).run, `${rowId}.cmd`)
function keepCommand(rowId: string, command: string) {
  const c = srtConfig()
  fs.mkdirSync(devenvPaths(c.base).run, { recursive: true, mode: 0o700 })
  fs.writeFileSync(commandFile(c, rowId), command, { mode: 0o600 })
}
function takeCommand(c: SrtConfig, rowId: string): string | null {
  const f = commandFile(c, rowId)
  try { const t = fs.readFileSync(f, 'utf8'); rm(f); return t } catch { return null }
}

interface NewRow { space: Space; name: string; turnId: string; command: string; shown: string; cwd: string; once?: readonly string[] }
function insertRow(ctx: AppContext, j: NewRow, kind: 'job' | 'server'): string {
  const id = newId()
  keepCommand(id, j.command)
  // the once-allowed sites go with the row: a waiting job builds its settings later, outside the turn
  ctx.db.query('INSERT INTO dev_env_runs (id, user_id, chat_id, project_id, turn_id, kind, name, command, root, cwd, state, started_at, ai_told_at, once_domains) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, j.space.userId, j.space.chatId, j.space.projectId, j.turnId, kind, j.name, j.shown.slice(0, 500), j.space.root, j.cwd, 'waiting', new Date().toISOString(), kind === 'server' ? new Date().toISOString() : null, formatOnce(j.once ?? []))
  return id
}

/** Start a job, or put it in the queue. `shown` is the command with secrets hidden: the text of the row. */
export async function submitJob(ctx: AppContext, j: NewRow): Promise<SubmitResult> {
  const lim = limitsFor(ctx)
  if (!lim.ok) return lim
  const waiting = openRuns(ctx.db, 'waiting')
  if (waiting.filter((r) => r.user_id === j.space.userId).length >= MAX_WAITING_PER_PERSON) return { ok: false, message: `queue full: ${MAX_WAITING_PER_PERSON} of your jobs wait already. Wait for one to start, or stop one.` }
  if (waiting.length >= MAX_WAITING_SERVER) return { ok: false, message: `queue full: ${MAX_WAITING_SERVER} jobs wait on this server. Try again later.` }
  const id = insertRow(ctx, j, 'job')
  await startWaiting(ctx)
  const row = ctx.db.query('SELECT state, ended_at, end_note FROM dev_env_runs WHERE id = ?').get(id) as { state: string; ended_at: string | null; end_note: string }
  if (row.ended_at) return { ok: false, message: row.end_note || 'the job could not start' }
  if (row.state === 'running') return { ok: true, state: 'running', position: null, rowId: id }
  const pos = openRuns(ctx.db, 'waiting').findIndex((r) => r.id === id) + 1
  return { ok: true, state: 'waiting', position: pos, rowId: id }
}

/** One start at a time. The tracker, submitJob and every box_shell call (pollSrt) start waiting jobs; two of them
 * must not take the same row (the second one ended a running job as "lost" and left its scope with no row), or
 * start more than maxRunning. */
let startChain: Promise<unknown> = Promise.resolve()
function oneStart<T>(fn: () => Promise<T>): Promise<T> {
  const next = startChain.then(fn, fn)
  startChain = next.catch(() => {})
  return next
}

/** Start a dev server now, or refuse (no queue). */
export function startServer(ctx: AppContext, j: NewRow): Promise<{ ok: true; rowId: string } | { ok: false; message: string }> {
  return oneStart(() => startServerNow(ctx, j))
}
async function startServerNow(ctx: AppContext, j: NewRow): Promise<{ ok: true; rowId: string } | { ok: false; message: string }> {
  const lim = limitsFor(ctx)
  if (!lim.ok) return lim
  const servers = openRuns(ctx.db, 'running', 'server')
  const mine = servers.filter((r) => (j.space.chatId ? r.chat_id === j.space.chatId : r.root === j.space.root))
  if (mine.length) return { ok: false, message: `a dev server runs in this chat already (${mine.map((r) => r.name).join(', ')}). Stop it first (the dev environment list, or ask the person).` }
  if (servers.length >= lim.l.maxRunning) return { ok: false, message: `${servers.length} dev servers run on this server, the most it allows. Ask a person to stop one.` }
  const id = insertRow(ctx, j, 'server')
  const row = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE id = ?`).get(id) as RunRow
  const r = await startRow(ctx, row)
  return r.ok ? { ok: true, rowId: id } : r
}

/** the hook that ends a row (jobs.ts sets it, to keep one place for notices) */
type Ender = (ctx: AppContext, rowId: string, end: { code: number | null; reason: EndReason; tail: string; lastLine: string }) => void
let ender: Ender = (ctx, rowId, end) => {
  ctx.db.query("UPDATE dev_env_runs SET ended_at = ?, state = 'ended', exit_code = ?, end_note = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
    .run(new Date().toISOString(), end.code, END_NOTE[end.reason], end.reason, rowId)
}
export function setEnder(e: Ender) { ender = e }

async function startRow(ctx: AppContext, row: RunRow): Promise<{ ok: true } | { ok: false; message: string }> {
  const c = srtConfig()
  // the person must still be allowed at the start (the setting or the folder rules can change while a job waits);
  // spawnRun builds the folder access again and checks the root
  if (!mayUseDevEnv(ctx.db, ctx.files, row.user_id)) {
    takeCommand(c, row.id)
    ender(ctx, row.id, { code: null, reason: 'setting', tail: '', lastLine: '' })
    return { ok: false, message: 'the dev environment is off for this person now' }
  }
  const lim = limitsFor(ctx)
  if (!lim.ok) { takeCommand(c, row.id); ender(ctx, row.id, { code: null, reason: 'setting', tail: '', lastLine: '' }); return lim }
  const command = takeCommand(c, row.id)
  if (command === null) { ender(ctx, row.id, { code: null, reason: 'lost', tail: '', lastLine: '' }); return { ok: false, message: 'the command of this job is gone' } }
  const runId = newRunId()
  const log = logFile(c, row.user_id, row.name)
  prepare(c, row.user_id)
  rm(log)
  const space = spaceOfRow(row)
  try {
    const sp = await spawnRun(ctx, c, {
      runId, space, cwd: row.cwd, command, network: lim.l.network, once: parseOnce(row.once_domains ?? '', teamHosts(ctx)), limits: lim.l,
      runtimeMaxSec: row.kind === 'server' ? SERVER_MAX_SEC : JOB_MAX_SEC, stdoutFile: log, stderrFile: log,
    })
    active.set(runId, { runId, space, kind: row.kind, command: row.command.slice(0, 300), startedAt: new Date().toISOString(), pid: sp.pid, stopReason: null, rowId: row.id })
    void sp.exited.then(() => { const a = active.get(runId); if (a) active.delete(runId) })
    const set = ctx.db.query("UPDATE dev_env_runs SET state = 'running', run_at = ?, unit = ?, access = ?, net = ? WHERE id = ? AND ended_at IS NULL").run(new Date().toISOString(), unitName(runId), accessHashFrom(ctx, row.user_id, sp.hash), JSON.stringify(sp.net), row.id)
    if (!set.changes) {
      // the row ended while the run started (a stop of a waiting job): no run may live with no open row
      const a = active.get(runId)
      if (a) a.stopReason = 'stopped'
      await c.system.stop(runId, sp.pid)
      active.delete(runId)
      return { ok: false, message: 'the job was stopped before it started' }
    }
    return { ok: true }
  } catch (e) {
    const m = (e as Error).message.slice(0, 300)
    ender(ctx, row.id, { code: null, reason: /cannot use|cannot open/.test(m) ? 'setting' : 'lost', tail: m, lastLine: '' })
    return { ok: false, message: m }
  }
}
/** the hash of the view the run started with (accessHash's format) */
const accessHashFrom = (ctx: AppContext, userId: string, viewHashValue: string) => (mayUseDevEnv(ctx.db, ctx.files, userId) ? viewHashValue : 'off')

/** Start waiting jobs while there are free slots, oldest first. Expired ones end. */
export function startWaiting(ctx: AppContext): Promise<void> {
  return oneStart(() => startWaitingNow(ctx))
}
async function startWaitingNow(ctx: AppContext): Promise<void> {
  const p = planState()
  const max = p.ok ? (p.plan?.maxRunning ?? NO_PLAN_MAX_RUNNING) : 0
  for (const w of openRuns(ctx.db, 'waiting', 'job')) {
    if (Date.now() - Date.parse(w.started_at) > WAIT_MAX_MS) { takeCommand(srtConfig(), w.id); ender(ctx, w.id, { code: null, reason: 'expired', tail: '', lastLine: '' }); continue }
    if (openRuns(ctx.db, 'running', 'job').length >= max) return
    // read again: an earlier start in this loop awaited, and a stop may have ended this row meanwhile
    if (!ctx.db.query("SELECT 1 FROM dev_env_runs WHERE id = ? AND state = 'waiting' AND ended_at IS NULL").get(w.id)) continue
    await startRow(ctx, w)
  }
}

/** What the tracker reads for one running row: still running, or ended with a code and a reason. */
async function rowStatus(c: SrtConfig, r: RunRow): Promise<{ running: true; tail: string } | { running: false; code: number | null; reason: EndReason; tail: string }> {
  const runId = runIdOf(r.unit)
  const log = logFile(c, r.user_id, r.name)
  const tail = readTail(log, TAIL_BYTES)
  if (!runId) return { running: false, code: null, reason: 'lost', tail }
  const exitFile = path.join(personLogs(c.base, r.user_id), `${runId}.exit`)
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

/** The tracker's step for the srt runner: end rows whose run ended, stop runs whose person's access changed, stop idle
 * dev servers, stop everything at the disk floor. Returns the BoxdJob view of each row it read, for jobs.ts, and the
 * people whose runs stopped at the disk floor. */
export async function pollRuns(ctx: AppContext, filter?: { chatId?: string; userId?: string }): Promise<{ rows: Map<string, BoxdJob & { reason?: EndReason }>; diskStopped: string[] }> {
  const c = srtConfig()
  const out = new Map<string, BoxdJob & { reason?: EndReason }>()
  const room = storageRoom(0)
  const diskStopped = room && !room.ok ? await stopAll(ctx, 'disk') : []
  // the access of a run depends on the person and on its starting folder (only that folder is writable)
  const hashes = new Map<string, string>()
  const nets = new Map<string, NetSnapshot>()
  for (const r of openRuns(ctx.db, 'running')) {
    if (filter?.chatId && r.chat_id !== filter.chatId) continue
    if (filter?.userId && r.user_id !== filter.userId) continue
    // the run's access: built again each poll, once per person and starting folder
    const key = `${r.user_id}\0${r.root}`
    if (!hashes.has(key)) hashes.set(key, accessHash(ctx, spaceOfRow(r)))
    if (r.access && hashes.get(key) !== r.access) { await stopRow(ctx, r, 'setting'); continue }
    // the network got narrower (the person removed a site, turned Full internet off; the team removed a site): stop it.
    // A row from an older build has no snapshot and is not checked
    const started = parseSnapshot(r.net ?? '')
    if (started) {
      if (!nets.has(r.user_id)) nets.set(r.user_id, snapshotNow(ctx, r.user_id))
      if (netNarrowed(started, nets.get(r.user_id)!)) { await stopRow(ctx, r, 'setting'); continue }
    }
    const s = await rowStatus(c, r)
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
  const idleMin = teamSetting(ctx.db).limits.idleStopMin
  if (since !== null && now - since >= idleMin * 60_000) await stopRow(ctx, r, 'idle')
}

async function stopRow(ctx: AppContext, r: RunRow, reason: EndReason) {
  const c = srtConfig()
  if (r.state === 'waiting') { takeCommand(c, r.id); ender(ctx, r.id, { code: null, reason, tail: '', lastLine: '' }); return }
  const runId = runIdOf(r.unit)
  const a = active.get(runId)
  if (a) a.stopReason = reason
  if (runId) await c.system.stop(runId, a?.pid)
  const tail = readTail(logFile(c, r.user_id, r.name), TAIL_BYTES)
  rm(path.join(personLogs(c.base, r.user_id), `${runId}.exit`))
  ender(ctx, r.id, { code: null, reason, tail, lastLine: lastLine(tail) })
  active.delete(runId); idleSince.delete(runId)
}

/** An open run by its row id or run id (a command of this process). */
export function findRun(ctx: AppContext, id: string): { row: RunRow } | { command: { runId: string; space: Space } } | null {
  const row = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE id = ? AND ended_at IS NULL`).get(id) as RunRow | null
  if (row) return { row }
  const a = RUN_ID_RE.test(id) ? active.get(id) : undefined
  return a && a.kind === 'command' ? { command: { runId: a.runId, space: a.space } } : null
}

/** Stop one run by its row id or run id. False when there is no such run here. The caller checks who may stop it. */
export async function stopRun(ctx: AppContext, id: string, reason: EndReason = 'stopped'): Promise<boolean> {
  const f = findRun(ctx, id)
  if (!f) return false
  if ('row' in f) { await stopRow(ctx, f.row, reason); return true }
  const a = active.get(f.command.runId)!
  a.stopReason = reason
  await srtConfig().system.stop(a.runId, a.pid)
  return true
}

/** Stop every run (and waiting job) that matches: a project's, a person's, or all. */
export async function stopWhere(ctx: AppContext, match: (s: { userId: string; projectId: string | null; chatId: string | null }) => boolean, reason: EndReason): Promise<string[]> {
  const people = new Set<string>()
  const rows = ctx.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE ended_at IS NULL`).all() as RunRow[]
  for (const r of rows) if (match({ userId: r.user_id, projectId: r.project_id, chatId: r.chat_id })) { people.add(r.user_id); await stopRow(ctx, r, reason) }
  for (const a of active.values()) if (a.kind === 'command' && match(a.space)) { people.add(a.space.userId); a.stopReason = reason; await srtConfig().system.stop(a.runId, a.pid) }
  return [...people]
}

/** Stop everything (the disk floor, the team setting changed). Returns the people whose runs stopped. */
export const stopAll = (ctx: AppContext, reason: EndReason) => stopWhere(ctx, () => true, reason)

/** After a restart: a trina-dev unit with no open row and no command of this process is stopped. Rows with no unit
 * end at the next poll (lost). */
export async function reconcile(ctx: AppContext): Promise<void> {
  const c = srtConfig()
  const known = new Set((ctx.db.query("SELECT unit FROM dev_env_runs WHERE ended_at IS NULL AND unit != ''").all() as { unit: string }[]).map((r) => r.unit))
  for (const a of active.values()) known.add(unitName(a.runId))
  for (const u of await c.system.units()) {
    if (known.has(u)) continue
    const runId = runIdOf(u)
    await c.system.stop(runId)
    await c.system.forget(runId)
  }
}

/** What runs and what waits: of a project's chats (the project page), or of one person (every chat). The queue
 * position counts every waiting job of the team. */
export async function runsOf(ctx: AppContext, filter: { projectId: string } | { userId: string }): Promise<DevEnvRuns> {
  const c = srtConfig()
  const match = (s: { userId: string; projectId: string | null }) => ('projectId' in filter ? s.projectId === filter.projectId : s.userId === filter.userId)
  const names = (ids: string[]) => new Map((ids.length ? ctx.db.query(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; name: string }[] : []).map((u) => [u.id, u.name]))
  const running = openRuns(ctx.db, 'running').filter((r) => match({ userId: r.user_id, projectId: r.project_id }))
  const waitingAll = openRuns(ctx.db, 'waiting')
  const commands = [...active.values()].filter((a) => a.kind === 'command' && match(a.space))
  const who = names([...new Set([...running, ...waitingAll].map((r) => r.user_id).concat(commands.map((a) => a.space.userId)))])
  const ref = (id: string) => ({ id, name: who.get(id) ?? id })
  // a person sees the chat of their own runs only
  const chatOf = (userId: string, chatId: string | null) => ('userId' in filter && userId === filter.userId ? chatId : null)
  const out: DevEnvRun[] = []
  for (const r of running) {
    const u = await c.system.unit(runIdOf(r.unit))
    out.push({ id: r.id, kind: r.kind, name: r.name, by: ref(r.user_id), startedAt: r.started_at, runAt: r.run_at, position: null, memoryMiB: u.memoryBytes === null ? null : Math.round(u.memoryBytes / 1048576), lastLine: r.last_line, chatId: chatOf(r.user_id, r.chat_id), projectId: r.project_id })
  }
  for (const a of commands) out.push({ id: a.runId, kind: 'command', name: a.command.slice(0, 80), by: ref(a.space.userId), startedAt: a.startedAt, runAt: a.startedAt, position: null, memoryMiB: null, lastLine: '', chatId: chatOf(a.space.userId, a.space.chatId), projectId: a.space.projectId })
  const waiting = waitingAll.map((r, i) => ({ r, i })).filter(({ r }) => match({ userId: r.user_id, projectId: r.project_id }))
    .map(({ r, i }) => ({ id: r.id, kind: r.kind, name: r.name, by: ref(r.user_id), startedAt: r.started_at, runAt: null, position: i + 1, memoryMiB: null, lastLine: '', chatId: chatOf(r.user_id, r.chat_id), projectId: r.project_id }))
  return { running: out, waiting }
}

/** The runs of other people in the same project (the first call of a turn tells the AI what else runs there): kinds,
 * names and who, never logs. */
export function othersInProject(ctx: AppContext, projectId: string, userId: string): { kind: string; name: string; by: string; position: number | null }[] {
  const waitingAll = openRuns(ctx.db, 'waiting')
  const rows = [...openRuns(ctx.db, 'running'), ...waitingAll].filter((r) => r.project_id === projectId && r.user_id !== userId)
  const names = new Map((ctx.db.query('SELECT id, name FROM users').all() as { id: string; name: string }[]).map((u) => [u.id, u.name]))
  return rows.map((r) => ({ kind: r.kind, name: r.name, by: names.get(r.user_id) ?? '?', position: r.state === 'waiting' ? waitingAll.findIndex((w) => w.id === r.id) + 1 : null }))
}

/** The work folder of a chat goes with the chat (chat/forget.ts, after the purge). */
export function forgetChatWork(chatId: string) {
  try { fs.rmSync(chatWork(srtConfig().base, chatId), { recursive: true, force: true }) } catch {}
}

/** tests */
export function _active() { return active }
