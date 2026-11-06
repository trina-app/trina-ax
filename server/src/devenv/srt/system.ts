// What the srt runner asks of the system: spawn a run, stop a unit, read a unit's state. Tests replace it with a fake
// (setSrtSystem). The real one calls systemd-run and systemctl, or, with MYCEL_DEV_ENV_SRT_DIRECT=1, runs srt with no
// scope (a process group; the Docker attack test, where there is no systemd).
import fs from 'node:fs'
import { SRT_PATHS, UNIT_RE, scopeArgv, wrappedArgv, type ScopeLimits } from './config'

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
  spawn(s: SpawnSpec): Spawned
  /** stop the run's unit (SIGTERM, SIGKILL after the stop timeout). Never throws. */
  stop(runId: string, pid?: number): Promise<void>
  unit(runId: string): Promise<UnitInfo>
  /** the trina-dev-*.scope units that systemd knows (running or failed) */
  units(): Promise<string[]>
  /** forget a failed unit (reset-failed), so systemd does not keep it */
  forget(runId: string): Promise<void>
  /** oom_kill count of the run's cgroup, or null when the cgroup is gone */
  oomKills(runId: string): number | null
  /** CPU time of the run in microseconds, or null */
  cpuUsec(runId: string): number | null
  /** the processes of the run: pid and command line */
  procs(runId: string): { pid: number; command: string; seconds: number }[]
  /** check that scopes can be made here (polkit). '' = good, else why not */
  selfTest(id: string): Promise<string>
}

const unitOf = (runId: string) => `trina-dev-${runId}.scope`

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
/** the cgroup folder of a run's scope in the devenv slice of this install */
export function cgroupDir(id: string, runId: string): string {
  return `/sys/fs/cgroup/${slicePath(`${id}-devenv.slice`)}/${unitOf(runId)}`
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

/** systemd scopes (production). */
export function systemdSystem(id: string): SrtSystem {
  return {
    spawn(s) {
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
      if (v.LoadState === 'not-found') return { state: '', result: '', memoryBytes: null }
      const mem = Number(v.MemoryCurrent)
      return { state: v.ActiveState ?? '', result: v.Result ?? '', memoryBytes: Number.isFinite(mem) && mem < 2 ** 62 ? mem : null }
    },
    async units() {
      const r = await run([SRT_PATHS.systemctl, 'list-units', '--all', '--plain', '--no-legend', '--no-pager', 'trina-dev-*.scope']).catch(() => null)
      return (r?.out ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '').filter((u) => UNIT_RE.test(u))
    },
    async forget(runId) { await run([SRT_PATHS.systemctl, 'reset-failed', '--no-ask-password', unitOf(runId)]).catch(() => null) },
    oomKills(runId) { return readNumber(`${cgroupDir(id, runId)}/memory.events`, 'oom_kill') },
    cpuUsec(runId) { return readNumber(`${cgroupDir(id, runId)}/cpu.stat`, 'usage_usec') },
    procs(runId) { return procsIn(cgroupDir(id, runId)) },
    async selfTest(installId) {
      const probe = 'selftest' + Math.random().toString(36).slice(2, 10).padEnd(8, '0')
      const r = await run([SRT_PATHS.systemdRun, '--scope', '--quiet', '--no-ask-password', `--unit=${unitOf(probe.slice(0, 16))}`, `--slice=${installId}-devenv.slice`, '--', '/bin/true']).catch((e) => ({ code: 1, out: '', err: String(e) }))
      return r.code === 0 ? '' : `cannot start a scope (polkit rule or slice missing): ${r.err.trim().slice(0, 300)}`
    },
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
    async units() { return [...live.keys()].map(unitOf) },
    async forget() {},
    oomKills() { return null },
    cpuUsec() { return null },
    procs() { return [] },
    async selfTest() { return '' },
  }
}
