// What the srt runner asks of the system: spawn a run, stop a unit, read a unit's state. Tests replace it with a fake
// (setSrtSystem). The real one starts each run as an instance of the run template trina-dev@.service with systemctl
// (an older install with no template: systemd-run --scope), or, with MYCEL_DEV_ENV_SRT_DIRECT=1, runs srt with no unit
// (a process group; the Docker attack test, where there is no systemd).
import fs from 'node:fs'
import os from 'node:os'
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
  /** folders the run only reads that macOS gives the dev accounts' ACL too: a copy's stage folder (devenv/work-write.ts) */
  readable?: string[]
  /** macOS: the runs (and their slot ports) on localhost this run may connect to besides its own port, the chat's own
   * running jobs and dev servers (srt/runner.ts reachTargets; srt-mac.mjs TRINA_REACH_PORTS). A port counts only while
   * that run still has the slot, and the slot is not given to another run while this one lives. Linux reaches them
   * through `bridge` instead */
  reach?: readonly { runId: string; port: number }[]
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
  /** Linux: listen on 127.0.0.1:<port> (and [::1]) in the network namespace of run `runId` and copy each connection to
   * the unix socket `socket` (another run's forwarder): `mycel-sandbox port-bridge` (native/cmd/mycel-sandbox
   * portfwd_linux.go). A later command of a chat reaches the chat's own dev server this way. null: not on this server */
  bridge?: ((o: { runId: string; port: number; socket: string }) => Promise<Forwarder | { error: string }>) | null
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
    // a later command reaches the chat's dev server (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md): the
    // bridge waits for the new run's network namespace (at most 10 s), listens there and dials the dev server's forwarder
    bridge: sandboxHelper() ? async ({ runId, port, socket }) => {
      const helper = sandboxHelper()
      if (!helper) return { error: 'no MYCEL_SANDBOX_HELPER on this server' }
      return startForwarder([helper, 'port-bridge', '--cgroup', cgroupDir(id, runId, template()), '--port', String(port), '--socket', socket], socket, 15_000)
    } : null,
  }
}

/** No systemd: srt runs in its own process group. For the Docker attack test and for development only; there are no
 * memory or CPU limits. */
/** One /proc entry: parent, start time (stat field 22: a later process with the same pid has another) and owner. */
export interface ProcEntry { ppid: number; start: string; uid: number }

/** Every process /proc shows now. Linux only; elsewhere empty. */
export function procTable(procDir = '/proc'): Map<number, ProcEntry> {
  const t = new Map<number, ProcEntry>()
  let names: string[] = []
  try { names = fs.readdirSync(procDir) } catch { return t }
  for (const n of names) {
    if (!/^[0-9]+$/.test(n)) continue
    try {
      // "pid (comm) state ppid ... starttime(22) ...": comm may hold spaces and parentheses, so read after the last ")"
      const st = fs.readFileSync(`${procDir}/${n}/stat`, 'utf8')
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ')
      let uid = -1
      try { uid = Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`${procDir}/${n}/status`, 'utf8'))?.[1] ?? -1) } catch {}
      t.set(Number(n), { ppid: Number(f[1]), start: f[19] ?? '', uid })
    } catch { /* gone */ }
  }
  return t
}

/** `roots` and every process below them in `table`. */
export function descendants(roots: readonly number[], table: Map<number, ProcEntry>): number[] {
  const kids = new Map<number, number[]>()
  for (const [pid, e] of table) { const l = kids.get(e.ppid); if (l) l.push(pid); else kids.set(e.ppid, [pid]) }
  const out: number[] = [], seen = new Set<number>(), todo = [...roots]
  while (todo.length) {
    const q = todo.pop()!
    if (seen.has(q) || !table.has(q)) continue
    seen.add(q); out.push(q)
    for (const c of kids.get(q) ?? []) todo.push(c)
  }
  return out
}

/** A run's process tree as /proc shows it now: every descendant of `root` (srt's bwrap starts its own sessions, so the
 * process group alone misses them), their resident memory added up, and how many there are. One read of /proc per call,
 * no cap on the count: a run cannot hide memory in more processes. Linux only; elsewhere an empty tree. */
export function runTree(root: string | number, procDir = '/proc', table: Map<number, ProcEntry> = procTable(procDir)): { pids: number[]; rssKiB: number } {
  const pids: number[] = []
  let rssKiB = 0
  for (const q of descendants([Number(root)], table)) {
    try {
      const m = /^VmRSS:\s+(\d+)/m.exec(fs.readFileSync(`${procDir}/${q}/status`, 'utf8'))
      pids.push(q)
      if (m) rssKiB += Number(m[1])
    } catch { /* gone */ }
  }
  return { pids, rssKiB }
}

/** The container's memory (cgroup v2 at `dir`, the container's own with a private cgroup namespace): what it uses now
 * (page cache and tmpfs included, which a process's resident memory does not count), its limit (memory.max, or the
 * machine's memory when it has none) and its OOM kills so far. null where there is no cgroup v2 file to read. */
export function containerMemory(dir = '/sys/fs/cgroup'): { current: number; max: number; ooms: number } | null {
  try {
    const current = Number(fs.readFileSync(path.join(dir, 'memory.current'), 'utf8').trim())
    const m = fs.readFileSync(path.join(dir, 'memory.max'), 'utf8').trim()
    let max = Number(m)
    if (m === 'max' || !Number.isFinite(max)) max = Number(/^MemTotal:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) * 1024
    let ooms = 0
    try { ooms = Number(/^oom_kill (\d+)/m.exec(fs.readFileSync(path.join(dir, 'memory.events'), 'utf8'))?.[1] ?? 0) } catch {}
    return Number.isFinite(current) && current > 0 && max > 0 ? { current, max, ooms } : null
  } catch { return null }
}

/** Tasks (threads) of this account now: what RLIMIT_NPROC counts, which is per account, not per run. */
export function accountTasks(uid = process.getuid?.() ?? -1, procDir = '/proc'): number {
  let n = 0
  for (const [pid, e] of procTable(procDir)) {
    if (e.uid !== uid) continue
    try { n += Number(/^Threads:\s+(\d+)/m.exec(fs.readFileSync(`${procDir}/${pid}/status`, 'utf8'))?.[1] ?? 1) } catch {}
  }
  return n
}

/** how often a direct run's memory and processes are counted */
export const DIRECT_WATCH_MS = 500
/** the memory the container keeps for the server, the engines and the page render while a direct run builds: the run
 * is stopped when the container's memory.current comes within this of its limit */
export const DIRECT_HEADROOM_MIB = 768
/** oom_score_adj: srt's own process and run-wrap below what a run's commands get, so the kernel (or the container's
 * OOM) takes the command first and srt lives to report it; both above the server's */
export const SRT_OOM_SCORE = 700, PAYLOAD_OOM_SCORE = 1000

/** The argv of a direct run: its own session, the lowest CPU priority (nice 19, and SCHED_IDLE where chrt can set it),
 * a hard cap on processes (RLIMIT_NPROC counts the whole account, so the account's tasks now plus the run's pids), then
 * run-wrap and srt as with systemd. Programs that are missing are left out, never the run. */
export function directArgv(s: Pick<SpawnSpec, 'exitFile' | 'settingsFile' | 'command' | 'full' | 'limits'>, accountNow: number, has: (f: string) => boolean = fs.existsSync): string[] {
  return [
    '/usr/bin/setsid',
    ...(has('/usr/bin/nice') ? ['/usr/bin/nice', '-n', '19'] : []),
    ...(has('/usr/bin/chrt') ? ['/usr/bin/chrt', '--idle', '0'] : []),
    ...(has('/usr/bin/prlimit') ? ['/usr/bin/prlimit', `--nproc=${accountNow + s.limits.pids}`] : []),
    ...wrappedArgv(s),
  ]
}

/** No systemd (MYCEL_DEV_ENV_SRT_DIRECT=1: the Docker image, docs/decisions/20261124-doc-kit-docker.md, and the attack
 * tests): srt in a session of its own, with no unit cgroup, so the server holds the run's limits itself:
 *  - CPU: nice 19 and SCHED_IDLE (directArgv): a run never slows the server or a turn;
 *  - processes: RLIMIT_NPROC (hard), and the tree is counted every DIRECT_WATCH_MS;
 *  - memory: the tree's resident memory against the run's memoryMiB, and, with `memory`, the container's own
 *    memory.current against its limit less a fixed headroom (page cache and tmpfs files, which srt's /tmp and /run are,
 *    count only there; one run builds at a time in the Docker plan, so the container's growth is that run's);
 *  - OOM: the run's commands get a higher oom_score_adj than srt and run-wrap.
 * A run over a limit is killed, the whole tree, and ends as out of memory (oomKills, unit result oom-kill), as a unit's
 * OOM kill does; so does a run the container's OOM killer hit. Every process the watch has seen is remembered (with
 * its start time): when the run ends, however it ends, whatever is left of them and below them is killed, so nothing
 * of a run outlives it (security review of #511: srt's node OOM-killed, run-wrap gone, the sandboxed shell went on).
 * At its first start the system also kills what an earlier server left (sweepLeftoverRuns). */
export function directSystem(o: { watchMs?: number; base?: string; memory?: { dir?: string; headroomMiB?: number } | null; procDir?: string } = {}): SrtSystem {
  const procDir = o.procDir ?? '/proc'
  const live = new Map<string, number>()
  /** runs killed for their memory or processes, or by the container's OOM: kept until forget */
  const oomed = new Set<string>()
  const memDir = o.memory ? o.memory.dir ?? '/sys/fs/cgroup' : null
  const headroom = (o.memory?.headroomMiB ?? DIRECT_HEADROOM_MIB) * 1024 * 1024
  const killAll = (pids: Iterable<number>) => { for (const q of pids) { try { process.kill(q, 'SIGKILL') } catch {} } }
  /** what is left of `seen` (same pid, same start) and everything below it, killed until nothing is left */
  async function finish(rootPid: number, seen: Map<number, string>) {
    for (let round = 0; round < 10; round++) {
      try { process.kill(-rootPid, 'SIGKILL') } catch {}
      const t = procTable(procDir)
      const alive = [...seen].filter(([pid, start]) => t.get(pid)?.start === start).map(([pid]) => pid)
      const all = descendants(alive, t)
      if (!all.length) return
      for (const q of all) { const e = t.get(q); if (e) seen.set(q, e.start) }
      killAll(all)
      await Bun.sleep(100)
    }
  }
  if (o.base) sweepLeftoverRuns(procDir)
  return {
    spawn(s) {
      const out = openOut(s.stdoutFile), err = s.stderrFile === s.stdoutFile ? out : openOut(s.stderrFile)
      try {
        const before = memDir ? containerMemory(memDir) : null
        const p = Bun.spawn(directArgv(s, accountTasks(process.getuid?.() ?? -1, procDir)), { cwd: s.cwd, env: s.env, stdin: 'ignore', stdout: out, stderr: err })
        live.set(s.runId, p.pid)
        oomed.delete(s.runId)
        const maxKiB = s.limits.memoryMiB * 1024, maxPids = s.limits.pids
        const seen = new Map<number, string>()
        const raised = new Set<number>()
        const watch = setInterval(() => {
          const table = procTable(procDir)
          const t = runTree(p.pid, procDir, table)
          for (const q of t.pids) { const e = table.get(q); if (e) seen.set(q, e.start) }
          // the commands (below srt's node, which is run-wrap's child) go first when memory runs out
          for (const q of t.pids) {
            if (raised.has(q) || q === p.pid || table.get(q)?.ppid === p.pid) continue
            raised.add(q)
            try { fs.writeFileSync(`${procDir}/${q}/oom_score_adj`, String(PAYLOAD_OOM_SCORE)) } catch { /* not ours to set: best effort */ }
          }
          const cm = memDir ? containerMemory(memDir) : null
          if (t.rssKiB > maxKiB || t.pids.length > maxPids || (cm && cm.current > cm.max - headroom)) { oomed.add(s.runId); try { process.kill(-p.pid, 'SIGKILL') } catch {}; killAll(t.pids) }
        }, o.watchMs ?? DIRECT_WATCH_MS)
        const exited = p.exited.then(async (code) => {
          clearInterval(watch)
          seen.set(p.pid, procTable(procDir).get(p.pid)?.start ?? '')
          await finish(p.pid, seen)
          const after = memDir ? containerMemory(memDir) : null
          if (before && after && after.ooms > before.ooms) oomed.add(s.runId)
          live.delete(s.runId)
          return { code, signal: p.signalCode ?? null }
        })
        return { pid: p.pid, exited }
      } finally {
        fs.closeSync(out); if (err !== out) fs.closeSync(err)
      }
    },
    async stop(runId, pid) {
      const p = live.get(runId) ?? pid
      if (!p) return
      try { process.kill(-p, 'SIGTERM') } catch {}
      await Bun.sleep(2000)
      // the rest goes when the run's process ends (finish); a run of an earlier server: its tree now
      try { process.kill(-p, 'SIGKILL') } catch {}
      killAll(runTree(p, procDir).pids)
    },
    async unit(runId) {
      if (live.has(runId)) return { state: 'active', result: '', memoryBytes: null }
      return oomed.has(runId) ? { state: 'failed', result: 'oom-kill', memoryBytes: null } : { state: '', result: '', memoryBytes: null }
    },
    async units() { return [...live.keys()].map((r) => unitName(r, false)) },
    async forget(runId) { oomed.delete(runId) },
    oomKills(runId) { return oomed.has(runId) ? 1 : 0 },
    cpuUsec() { return null },
    procs() { return [] },
    // a real command through srt, as a run starts it (no network, the base folder hidden; the settings file may sit in
    // the base folder, srt reads it before the sandbox starts): a host where srt cannot make
    // its namespaces (a container without the guide's security settings, an Ubuntu host's AppArmor) has no box_shell,
    // and the AI makes documents with make_file. Without a base (the attack tests) nothing to check here
    async selfTest() { return o.base ? directSelfTest(o.base) : '' },
    // no unit cgroup: port-forward cannot tell this run's processes from others, so there is no preview here
    forward: null,
    bridge: null,
  }
}

/** At a server's start with direct runs: kill what an earlier server of this account left running (a run whose server
 * died or restarted: the container keeps its orphans). Only processes of this account that are not this server, its
 * parents (the bootstrap) or its children (converters started since), and that are a run's: in another pid namespace
 * than this server (inside a run's bwrap) or a run's own programs (run-wrap, srt, bwrap). Returns how many. */
export function sweepLeftoverRuns(procDir = '/proc', me = process.pid, uid = process.getuid?.() ?? -1): number {
  const t = procTable(procDir)
  const keep = new Set<number>(descendants([me], t))
  for (let q: number | undefined = me; q && q > 1 && !keep.has(-q); q = t.get(q)?.ppid) { keep.add(q); keep.add(-q) }
  let myNs = ''
  try { myNs = fs.readlinkSync(`${procDir}/${me}/ns/pid`) } catch {}
  const runProg = /\/opt\/trina\/devenv\/run-wrap|\/opt\/trina\/srt\/|(^|\/)bwrap(\0|$)/
  const victims: number[] = []
  for (const [pid, e] of t) {
    if (e.uid !== uid || keep.has(pid)) continue
    let ns = '', cmd = ''
    try { ns = fs.readlinkSync(`${procDir}/${pid}/ns/pid`) } catch {}
    try { cmd = fs.readFileSync(`${procDir}/${pid}/cmdline`, 'utf8') } catch {}
    if ((myNs && ns && ns !== myNs) || runProg.test(cmd)) victims.push(pid)
  }
  const all = descendants(victims, t).filter((q) => !keep.has(q) && t.get(q)?.uid === uid)
  for (const q of all) { try { process.kill(q, 'SIGKILL') } catch {} }
  return all.length
}

/** One `echo` through srt as this account, offline, with `base` hidden: '' when it printed, else why not. */
export async function directSelfTest(base: string, timeoutMs = 30_000): Promise<string> {
  let dir = ''
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-srt-check-'))
    const settings = path.join(dir, 'settings.json')
    fs.writeFileSync(settings, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [base], allowWrite: [], denyWrite: [] } }), { mode: 0o600 })
    const p = Bun.spawn(srtArgv({ settingsFile: settings, command: 'echo srt-ok' }), { cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/', LANG: 'C.UTF-8' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, timeoutMs)
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    clearTimeout(t)
    if (code === 0 && out.trim() === 'srt-ok') return ''
    return `a command in srt did not run here (exit ${code}): ${(err || out).trim().replace(/\s+/g, ' ').slice(0, 300)}`
  } catch (e) {
    return `a command in srt did not run here: ${(e as Error).message.slice(0, 300)}`
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}
