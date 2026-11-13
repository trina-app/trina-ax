// What the srt runner asks of the system: spawn a run, stop a unit, read a unit's state. Tests replace it with a fake
// (setSrtSystem). The real one starts each run as an instance of the run template trina-dev@.service with systemctl
// (an older install with no template: systemd-run --scope), or, with MYCEL_DEV_ENV_SRT_DIRECT=1, runs srt with no unit
// (a process group; the Docker attack test, where there is no systemd).
import fs from 'node:fs'
import path from 'node:path'
import { SRT_PATHS, UNIT_RE, devenvPaths, scopeArgv, srtArgv, templateInstalled, unitArgs, unitLimits, unitName, wrappedArgv, type ScopeLimits } from './config'

export interface SpawnSpec {
  runId: string
  /** the install id (<ID>): the slice name */
  id: string
  cwd: string
  env: Record<string, string>
  limits: ScopeLimits
  exitFile: string
  settingsFile: string
  command: string
  /** Full internet: run srt through full.mjs (the settings have strictAllowlist false) */
  full?: boolean
  /** stdout and stderr go here (the same file for a job); never a pipe */
  stdoutFile: string
  stderrFile: string
  /** the folders the run may write (the settings' allowWrite). macOS gives them the dev accounts' ACL again first */
  writable?: string[]
}

export interface Spawned {
  pid: number
  /** resolves when the spawned process ends (only while this server process lives) */
  exited: Promise<{ code: number | null; signal: string | null }>
}

export interface UnitInfo {
  /** active, activating, deactivating, failed, inactive; '' when systemd does not know the unit */
  state: string
  /** systemd's Result (success, oom-kill, timeout, signal, ...) */
  result: string
  memoryBytes: number | null
}

export interface SrtSystem {
  /** macOS picks a slot and grants the ACL first, so it may be async */
  spawn(s: SpawnSpec): Spawned | Promise<Spawned>
  /** stop the run's unit (SIGTERM, SIGKILL after the stop timeout). Never throws. */
  stop(runId: string, pid?: number): Promise<void>
  unit(runId: string): Promise<UnitInfo>
  /** the run units that systemd knows (running or failed): trina-dev@*.service, and trina-dev-*.scope of an older install */
  units(): Promise<string[]>
  /** forget a failed unit (reset-failed), so systemd does not keep it */
  forget(runId: string): Promise<void>
  /** oom_kill count of the run's cgroup, or null when the cgroup is gone */
  oomKills(runId: string): number | null
  /** CPU time of the run in microseconds, or null */
  cpuUsec(runId: string): number | null
  /** the processes of the run: pid and command line */
  procs(runId: string): { pid: number; command: string; seconds: number }[]
  /** check that a run unit can start here (template, polkit, run-wrap). '' = good, else why not */
  selfTest(id: string): Promise<string>
  /** Serve a port of a running run on a unix socket (the preview): `mycel-sandbox port-forward` enters the run's
   * network namespace (docs/DECISIONS.md "Dev environment on srt: preview"). Resolves when the socket accepts, or
   * with why not. null: this system has no preview (no unit cgroup to find the run by). */
  forward?: ((o: { runId: string; port: number; socket: string }) => Promise<Forwarder | { error: string }>) | null
}

/** A running port forwarder of one run and port. stop() ends it (its stdin closes); exited resolves when it ended. */
export interface Forwarder {
  socket: string
  stop(): void
  exited: Promise<void>
}

/** the root-owned mycel-sandbox helper the server unit names (server.service.in) */
const sandboxHelper = (env: Record<string, string | undefined> = process.env) => {
  const h = env.MYCEL_SANDBOX_HELPER ?? ''
  return path.isAbsolute(h) && fs.existsSync(h) ? h : ''
}

/** Start `mycel-sandbox port-forward` for a run's unit cgroup and wait for its "ready" line (at most 10 s). */
export async function startForwarder(argv: string[], socket: string, timeoutMs = 10_000): Promise<Forwarder | { error: string }> {
  const p = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  const exited = p.exited.then(() => {})
  const err = new Response(p.stderr).text()
  const reader = p.stdout.getReader()
  let out = ''
  const ready = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return false
      out += new TextDecoder().decode(value)
      if (out.includes('ready\n')) return true
    }
  })()
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))
  const r = await Promise.race([ready, timer])
  if (r === true) {
    reader.releaseLock()
    void p.stdout.cancel().catch(() => {})
    // the forwarder ends when its stdin closes: the server stops it, or the server process ends
    const stop = () => { try { p.stdin.end() } catch {} ; setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 2000).unref?.() }
    return { socket, stop, exited }
  }
  try { p.kill('SIGKILL') } catch {}
  const why = (await err.catch(() => '')).trim().replace(/^mycel-sandbox: /, '').slice(0, 300)
  return { error: r === 'timeout' ? 'the preview forwarder did not start in time' : why || 'the preview forwarder ended' }
}

async function run(argv: string[], timeoutMs = 15_000): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
  const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  clearTimeout(t)
  return { code, out, err }
}

/** The cgroup path of a slice: systemd nests slices by the dashes of the name ("a-b-c.slice" is
 * a.slice/a-b.slice/a-b-c.slice), so an install id with a dash nests deeper. */
export function slicePath(name: string): string {
  const parts = name.replace(/\.slice$/, '').split('-')
  return parts.map((_, i) => parts.slice(0, i + 1).join('-') + '.slice').join('/')
}
/** the cgroup folder of a run's unit in the devenv slice of this install (the template sets Slice=) */
export function cgroupDir(id: string, runId: string, template: boolean = templateInstalled()): string {
  return `/sys/fs/cgroup/${slicePath(`${id}-devenv.slice`)}/${unitName(runId, template)}`
}

function readNumber(file: string, key?: string): number | null {
  try {
    const t = fs.readFileSync(file, 'utf8')
    if (!key) return Number(t.trim())
    const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(t)
    return m ? Number(m[1]) : 0
  } catch { return null }
}

function openOut(file: string): number {
  // O_APPEND: the tracker can cut a large log while the run writes it
  return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o640)
}

function procsIn(dir: string): { pid: number; command: string; seconds: number }[] {
  let pids: number[] = []
  try { pids = fs.readFileSync(`${dir}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number) } catch { return [] }
  const ticks = 100, now = uptime()
  return pids.slice(0, 50).map((pid) => {
    let command = '', seconds = 0
    try { command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') } catch {}
    try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' '); seconds = Math.max(0, Math.round(now - Number(f[19]) / ticks)) } catch {}
    return { pid, command: command.slice(0, 300), seconds }
  })
}
function uptime(): number { try { return Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) } catch { return 0 } }

const rmFile = (f: string) => { try { fs.rmSync(f, { force: true }) } catch {} }

/** systemd (production). A run is an instance of the run template (docs/DECISIONS.md "Dev environment on srt: runs as
 * template units"): the runner writes the run's arguments file, sets the run's cgroup limits with
 * `systemctl set-property --runtime` and starts the unit with `systemctl start --wait`, which ends when the unit ends.
 * The polkit rule allows only these verbs on trina-dev@<16>.service. An install whose root files are older (no
 * template yet) starts transient scopes as before, until install-srt.sh runs again. */
export function systemdSystem(id: string, base: string, template: () => boolean = () => templateInstalled()): SrtSystem {
  const unitOf = (runId: string) => unitName(runId, template())
  const runDir = devenvPaths(base).run
  /** write the arguments file and start the unit; `exited` resolves when the unit has ended */
  async function startUnit(o: { runId: string; cwd: string; env: Record<string, string>; limits: ScopeLimits; exitFile: string; stdoutFile: string; stderrFile: string; argv: string[] }): Promise<Spawned> {
    const unit = unitName(o.runId, true)
    const args = path.join(runDir, `${o.runId}.args`)
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(args, unitArgs(o), { mode: 0o600, flag: 'wx' })
    const lim = await run([SRT_PATHS.systemctl, 'set-property', '--runtime', '--no-ask-password', unit, ...unitLimits(o.limits)]).catch((e) => ({ code: 1, out: '', err: String(e) }))
    if (lim.code !== 0) { rmFile(args); throw new Error(`cannot set the limits of ${unit}: ${lim.err.trim().slice(0, 200)}`) }
    const p = Bun.spawn([SRT_PATHS.systemctl, 'start', '--wait', '--no-ask-password', unit], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    p.unref()
    const err = new Response(p.stderr).text().catch(() => '')
    const exited = p.exited.then(async (code) => {
      // run-wrap removes the file when it starts; it is still here when the unit did not start
      rmFile(args)
      const e = (await err).trim()
      if (code !== 0 && e) console.warn(`[dev-env] systemctl start ${unit}: ${e.slice(0, 300)}`)
      // the run's exit code is in the exit file; systemctl's code says only whether the unit failed
      return { code: null, signal: null }
    })
    return { pid: p.pid, exited }
  }
  return {
    spawn(s) {
      if (template()) {
        // the output files exist before the start, made here with O_NOFOLLOW; run-wrap appends to them
        fs.closeSync(openOut(s.stdoutFile)); if (s.stderrFile !== s.stdoutFile) fs.closeSync(openOut(s.stderrFile))
        return startUnit({ runId: s.runId, cwd: s.cwd, env: s.env, limits: s.limits, exitFile: s.exitFile, stdoutFile: s.stdoutFile, stderrFile: s.stderrFile, argv: srtArgv(s) })
      }
      const out = openOut(s.stdoutFile), err = s.stderrFile === s.stdoutFile ? out : openOut(s.stderrFile)
      try {
        const p = Bun.spawn(scopeArgv({ runId: s.runId, id: s.id, limits: s.limits, exitFile: s.exitFile, settingsFile: s.settingsFile, command: s.command, full: s.full }), {
          cwd: s.cwd, env: s.env, stdin: 'ignore', stdout: out, stderr: err,
        })
        p.unref()
        return { pid: p.pid, exited: p.exited.then((code) => ({ code, signal: p.signalCode ?? null })) }
      } finally {
        fs.closeSync(out); if (err !== out) fs.closeSync(err)
      }
    },
    async stop(runId) { await run([SRT_PATHS.systemctl, 'stop', '--no-ask-password', unitOf(runId)], 30_000).catch(() => null) },
    async unit(runId) {
      const r = await run([SRT_PATHS.systemctl, 'show', '--no-ask-password', '-p', 'ActiveState,Result,MemoryCurrent,LoadState', unitOf(runId)]).catch(() => null)
      if (!r || r.code !== 0) return { state: '', result: '', memoryBytes: null }
      const v = Object.fromEntries(r.out.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      // a scope systemd does not know is not-found; an instance of the template always loads (inactive)
      if (v.LoadState === 'not-found') return { state: '', result: '', memoryBytes: null }
      const mem = Number(v.MemoryCurrent)
      return { state: v.ActiveState ?? '', result: v.Result ?? '', memoryBytes: Number.isFinite(mem) && mem < 2 ** 62 ? mem : null }
    },
    async units() {
      const r = await run([SRT_PATHS.systemctl, 'list-units', '--all', '--plain', '--no-legend', '--no-pager', 'trina-dev@*.service', 'trina-dev-*.scope']).catch(() => null)
      return (r?.out ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '').filter((u) => UNIT_RE.test(u))
    },
    async forget(runId) { await run([SRT_PATHS.systemctl, 'reset-failed', '--no-ask-password', unitOf(runId)]).catch(() => null) },
    oomKills(runId) { return readNumber(`${cgroupDir(id, runId, template())}/memory.events`, 'oom_kill') },
    cpuUsec(runId) { return readNumber(`${cgroupDir(id, runId, template())}/cpu.stat`, 'usage_usec') },
    procs(runId) { return procsIn(cgroupDir(id, runId, template())) },
    async selfTest(installId) {
      const probe = ('selftest' + Math.random().toString(36).slice(2, 10)).padEnd(16, '0').slice(0, 16)
      if (template()) {
        // a whole run of /bin/true: the limits (set-property), the start, run-wrap and its exit file
        const exitFile = path.join(runDir, `${probe}.exit`)
        try {
          const sp = await startUnit({ runId: probe, cwd: '/', env: {}, limits: { cpus: 1, memoryMiB: 64, pids: 16, runtimeMaxSec: 30 }, exitFile, stdoutFile: '/dev/null', stderrFile: '/dev/null', argv: ['/bin/true'] })
          await Promise.race([sp.exited, Bun.sleep(15_000)])
          const code = (() => { try { return fs.readFileSync(exitFile, 'utf8').trim() } catch { return '' } })()
          return code === '0' ? '' : `a run unit did not run (${unitName(probe, true)}): check the polkit rule, ${SRT_PATHS.template} and run-wrap (install-srt.sh)`
        } catch (e) {
          return `cannot start a run unit: ${String((e as Error).message ?? e).slice(0, 300)}`
        } finally { rmFile(exitFile) }
      }
      const r = await run([SRT_PATHS.systemdRun, '--scope', '--quiet', '--no-ask-password', `--unit=${unitName(probe, false)}`, `--slice=${installId}-devenv.slice`, '--', '/bin/true']).catch((e) => ({ code: 1, out: '', err: String(e) }))
      return r.code === 0 ? '' : `no run template (${SRT_PATHS.template}: run install-srt.sh again), and cannot start a scope: ${r.err.trim().slice(0, 300)}`
    },
    forward: sandboxHelper() ? async ({ runId, port, socket }) => {
      const helper = sandboxHelper()
      if (!helper) return { error: 'no MYCEL_SANDBOX_HELPER on this server' }
      return startForwarder([helper, 'port-forward', '--cgroup', cgroupDir(id, runId, template()), '--port', String(port), '--socket', socket], socket)
    } : null,
  }
}

/** No systemd: srt runs in its own process group. For the Docker attack test and for development only; there are no
 * memory or CPU limits. */
export function directSystem(): SrtSystem {
  const live = new Map<string, number>()
  return {
    spawn(s) {
      const out = openOut(s.stdoutFile), err = s.stderrFile === s.stdoutFile ? out : openOut(s.stderrFile)
      try {
        const p = Bun.spawn(['/usr/bin/setsid', ...wrappedArgv(s)], { cwd: s.cwd, env: s.env, stdin: 'ignore', stdout: out, stderr: err })
        live.set(s.runId, p.pid)
        return { pid: p.pid, exited: p.exited.then((code) => { live.delete(s.runId); return { code, signal: p.signalCode ?? null } }) }
      } finally {
        fs.closeSync(out); if (err !== out) fs.closeSync(err)
      }
    },
    async stop(runId, pid) {
      const p = live.get(runId) ?? pid
      if (!p) return
      try { process.kill(-p, 'SIGTERM') } catch {}
      await Bun.sleep(2000)
      try { process.kill(-p, 'SIGKILL') } catch {}
    },
    async unit(runId) { return live.has(runId) ? { state: 'active', result: '', memoryBytes: null } : { state: '', result: '', memoryBytes: null } },
    async units() { return [...live.keys()].map((r) => unitName(r, false)) },
    async forget() {},
    oomKills() { return null },
    cpuUsec() { return null },
    procs() { return [] },
    async selfTest() { return '' },
    // no unit cgroup: port-forward cannot tell this run's processes from others, so there is no preview here
    forward: null,
  }
}
