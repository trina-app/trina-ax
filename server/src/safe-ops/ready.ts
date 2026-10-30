// What a qualified Linux install needs before a 1A job runs (QA 2026-10-30 B1), in words the person and the
// administrator can act on. Two install parts used to be missing on every standard install, and both refusals read
// "a qualified Linux converter is needed":
//   - the bounded group: the server, its converters and every engine turn in one cgroup with finite memory, pids and
//     CPU (envelope.ts). The installer puts both units in <id>.slice; `sudo mycel-ctl safe-ops on` bounds it.
//   - root-owned programs: a 1A job runs only executables that root owns and nobody else can write, in folders root owns
//     (runner.ts trustedFile). The app folder belongs to the server account (in-app updates write it), so the installer
//     and `mycel-ctl update` put copies of mycel-safeops and pandoc into <base>/root/safe-ops/ (the unit's
//     MYCEL_SAFE_OPS_BIN). Without that variable (a source checkout, the T1 container) the app's own copies are used and
//     must be root-owned themselves.
// Every job still checks all of it again (runner.ts, envelope.ts); this file only names the problem.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { converterCgroup, cgroupState } from '../system/cgroups'
import { nativeBinDir, which } from '../config'
import { ToolError } from '../policy/errors'
import { qualifiedEnvelope } from './envelope'

export type SafeProgram = 'mycel-safeops' | 'pandoc'

/** The app's own copy of a 1A program (bundle native/ or bin/, or the system's pandoc in a source checkout). */
export function appProgram(name: SafeProgram, pandoc: string | null = which('pandoc')): string | null {
  return name === 'mycel-safeops' ? path.join(nativeBinDir(), 'mycel-safeops') : pandoc
}

/** The executable a 1A job runs: the root-owned copy in MYCEL_SAFE_OPS_BIN when the unit names one, else the app's. */
export function safeProgram(name: SafeProgram, pandoc?: string | null): string | null {
  const dir = process.env.MYCEL_SAFE_OPS_BIN
  if (dir && path.isAbsolute(dir)) return path.join(dir, name)
  return appProgram(name, pandoc)
}

const notReady = (detail: string) => new ToolError(`Safe operation programs are not ready: ${detail}`, 'safe_ops_not_ready_programs')

/** Why `file` may not run in a 1A job: it and every folder above it must be root's and not group/other-writable.
 * Null when it may. */
export function untrusted(file: string): string | null {
  let real: string
  try { real = fs.realpathSync(file) } catch { return `${file} is missing` }
  const st = fs.statSync(real)
  if (!st.isFile()) return `${real} is not a regular file`
  if (st.uid !== 0) return `${real} is owned by uid ${st.uid}, not root`
  if (st.mode & 0o022) return `${real} is writable by group or others`
  for (let p = path.dirname(real); ; p = path.dirname(p)) {
    const d = fs.statSync(p)
    if (d.uid !== 0) return `${p} is owned by uid ${d.uid}, not root`
    if (d.mode & 0o022) return `${p} is writable by group or others`
    if (p === '/') return null
  }
}

const hashes = new Map<string, string>()
function digest(file: string): string {
  const st = fs.statSync(file)
  const key = `${file}\0${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
  let h = hashes.get(key)
  if (!h) {
    // streamed: pandoc is about 160 MB
    const hash = crypto.createHash('sha256'), buf = Buffer.alloc(1 << 20), fd = fs.openSync(file, 'r')
    try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n)) } finally { fs.closeSync(fd) }
    h = hash.digest('hex')
    if (hashes.size > 16) hashes.clear()
    hashes.set(key, h)
  }
  return h
}

/** Why the 1A program `name` cannot run now: missing or not root-owned, or a root copy from another version than the
 * running app (an app-only update the root copies did not follow). Null when it can. */
export function programProblem(name: SafeProgram, pandoc?: string | null): string | null {
  const file = safeProgram(name, pandoc)
  if (!file) return `${name} is missing`
  const bad = untrusted(file)
  if (bad) return bad
  const app = appProgram(name, pandoc === undefined ? which('pandoc') : pandoc)
  if (process.env.MYCEL_SAFE_OPS_BIN && app && fs.existsSync(app) && fs.realpathSync(app) !== fs.realpathSync(file)) {
    try { if (digest(app) !== digest(file)) return `${file} is from another version than ${app}` } catch { return `${file} cannot be read` }
  }
  return null
}

/** Throw the "programs not ready" refusal for an executable a job is about to run (before any job is reserved). */
export function assertTrustedProgram(file: string, name?: SafeProgram, pandoc?: string | null) {
  const problem = name ? programProblem(name, pandoc) : untrusted(file)
  if (problem) throw notReady(problem)
}

export type Readiness =
  | { state: 'off' }
  | { state: 'ready'; memory: number; pids: number; cpus: number; current: number }
  | { state: 'not_ready'; reason: 'unavailable' | 'programs' | 'group' | 'memory'; detail: string }

/** The administrator's view (diagnostics): the same checks as a job, without an engine process (the server's own
 * process stands in; the group must also hold the launcher unit, which a job checks through the engine's PID). */
export function safeOpsReadiness(enabled: boolean, pandoc: string | null = which('pandoc')): Readiness {
  if (!enabled) return { state: 'off' }
  if (process.platform !== 'linux') return { state: 'not_ready', reason: 'unavailable', detail: 'not Linux' }
  if (process.env.MYCEL_ISOLATION === 'none') return { state: 'not_ready', reason: 'unavailable', detail: 'MYCEL_ISOLATION=none' }
  const conv = converterCgroup()
  if (!conv) {
    const s = cgroupState()
    return { state: 'not_ready', reason: 'unavailable', detail: `no converter cgroup (${s.state === 'delegated' ? 'delegated' : s.reason})` }
  }
  const helper = untrusted(conv.helper)
  if (helper) return { state: 'not_ready', reason: 'programs', detail: helper }
  for (const name of ['mycel-safeops', 'pandoc'] as const) {
    const p = programProblem(name, pandoc)
    if (p) return { state: 'not_ready', reason: 'programs', detail: p }
  }
  const bwrap = process.env.MYCEL_SAFE_OPS_BWRAP ?? which('bwrap')
  const b = bwrap ? untrusted(bwrap) : 'bwrap is missing'
  if (b) return { state: 'not_ready', reason: 'unavailable', detail: b }
  try {
    const e = qualifiedEnvelope(conv.dir, process.pid)
    const label = process.env.MYCEL_LABEL
    if (label && /^[a-z][a-z0-9-]{0,30}$/.test(label) && !fs.existsSync(path.join(e.dir, `${label}-launcher.service`)))
      return { state: 'not_ready', reason: 'group', detail: `${label}-launcher.service is not inside ${e.dir}` }
    return { state: 'ready', memory: e.memory, pids: e.pids, cpus: e.cpu, current: e.current }
  } catch (e) {
    const code = e instanceof ToolError ? e.code : ''
    return { state: 'not_ready', reason: code === 'safe_ops_group_memory' ? 'memory' : 'group', detail: (e as Error).message }
  }
}
