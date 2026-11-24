// What the srt runner asks of an office Mac (docs/decisions/20261124-office-mac-doc-kit.md): documents mode only
// (devenv/setting.ts documentsOnlyServer, commandMode). An office install has no sudo, so there are no dev slot accounts
// (system-mac.ts): a run is the signed-in user's own process, and srt's Seatbelt profile is what keeps it in (no
// network, the home folder and the team folder unreadable, only the chat's work folder writable, no process info or
// signals outside the sandbox, no Apple events, no launchd jobs: tests/unit/dev-env-office.test.ts and QA TC-8713).
//
// The run shares the server's uid, so a process that leaves its process group (setsid) is not reached by a group
// kill. What bounds it (security review of #509):
// - rlimits set before srt starts and inherited by every process of the run, escapees too, which cannot raise them:
//   processes of this uid at most what runs now plus the run's pids limit (ulimit -u: a fork bomb stops there, the
//   server, the engine and the owner's apps keep the room they had), CPU seconds per process at most the run's time
//   limit (ulimit -t), open files 4096, file size 4 GiB, no core files;
// - every process of the run carries TRINA_RUN_ID=<run id> in its environment (ps shows it for the kit's python3 and
//   node and other programs that are not part of macOS; macOS hides the environment of its own binaries such as bash),
//   and a watchdog notes four times a second every descendant of the run (by parent pid, before a setsid'd child loses
//   its parent);
// - when a run ends, and when the server starts, this uid's processes that carry a run's tag, that the watchdog noted,
//   or whose working folder is in the dev environment's folders (devenv/), are ended (endRunProcesses).
// What is left: a macOS binary (or one started with env -i) that leaves devenv/ (cd /) after a double fork between two
// watchdog looks. It keeps the rlimits (CPU time, process count) and the sandbox (no network, only the work folder),
// and lives until it ends by itself or the Mac restarts.
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { UNIT_RE, devenvPaths } from './config'
import type { DocKit } from '../kit'
import type { SrtSystem, UnitInfo } from './system'

/** The environment variable every process of a run carries */
export const RUN_TAG = 'TRINA_RUN_ID'
/** the most processes of this uid a run may bring it to, over what it has now */
const uidMax = () => {
  const r = Bun.spawnSync(['/usr/sbin/sysctl', '-n', 'kern.maxprocperuid'], { stdout: 'pipe', stderr: 'ignore' })
  const n = Number(r.stdout.toString().trim())
  return Number.isInteger(n) && n > 0 ? n : 2000
}

/** The argv of one run: a shell sets the limits and execs srt (its CLI with the run's settings) in place. `procs`: the
 * processes this uid may have in all (ulimit -u); `cpuSec`: CPU seconds per process (ulimit -t). */
export function officeArgv(kit: Pick<DocKit, 'node' | 'srtCli'>, o: { settingsFile: string; command: string; procs: number; cpuSec: number }): string[] {
  if (!Number.isInteger(o.procs) || o.procs < 1 || !Number.isInteger(o.cpuSec) || o.cpuSec < 1) throw new Error('bad limits for a run')
  return ['/bin/sh', '-c', `ulimit -u ${o.procs} && ulimit -t ${o.cpuSec} && ulimit -n 4096 && ulimit -f 4194304 && ulimit -c 0 && exec "$@"`, 'trina-run',
    kit.node, kit.srtCli, '--settings', o.settingsFile, '-c', o.command]
}

/** One process of this uid: pid, parent, its environment holds a run tag (and which), its command */
export interface OwnProc { pid: number; ppid: number; tag: string | null; pgid?: number }
/** `ps -x -E -ww -o pid=,ppid=,pgid=,command=` lines (the environment follows the command for this uid's processes) */
export function parseOwnPs(text: string): OwnProc[] {
  const out: OwnProc[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line)
    if (!m) continue
    const t = new RegExp(`(?:^|\\s)${RUN_TAG}=([a-z0-9]{16})(?:\\s|$)`).exec(m[4]!)
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tag: t ? t[1]! : null })
  }
  return out
}
const env0 = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }
function ownProcs(): OwnProc[] {
  const r = Bun.spawnSync(['/bin/ps', '-x', '-E', '-ww', '-U', String(process.getuid?.() ?? 0), '-o', 'pid=,ppid=,pgid=,command='], { stdout: 'pipe', stderr: 'ignore', env: env0 })
  return parseOwnPs(r.stdout.toString())
}
/** pids of this uid whose working folder is inside `dir` (lsof) */
function cwdInside(dir: string): number[] {
  const r = Bun.spawnSync(['/usr/sbin/lsof', '-a', '-d', 'cwd', '-u', String(process.getuid?.() ?? 0), '-Fpn'], { stdout: 'pipe', stderr: 'ignore', env: env0, timeout: 20_000 })
  const out: number[] = []
  let pid = 0
  const root = dir.endsWith('/') ? dir : dir + '/'
  for (const l of r.stdout.toString().split('\n')) {
    if (l.startsWith('p')) pid = Number(l.slice(1))
    else if (l.startsWith('n') && pid && (l.slice(1) === dir || l.slice(1).startsWith(root))) out.push(pid)
  }
  return out
}
/** every descendant of `roots` among `procs`, roots included: by parent pid, and by process group (a child that called
 * setsid leads a group of its own pid, which its children keep after it ends and they lose their parent) */
export function descendants(procs: OwnProc[], roots: Iterable<number>): Set<number> {
  const kids = new Map<number, number[]>()
  for (const p of procs) {
    kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid])
    if (p.pgid && p.pgid !== p.pid && p.pgid !== p.ppid) kids.set(p.pgid, [...(kids.get(p.pgid) ?? []), p.pid])
  }
  const out = new Set<number>(), todo = [...roots]
  while (todo.length) { const p = todo.pop()!; if (out.has(p)) continue; out.add(p); todo.push(...(kids.get(p) ?? [])) }
  return out
}

/**
 * End this uid's processes of runs: those tagged with one of `runIds` (all tags when `runIds` is 'all'), the `noted`
 * pids, and those whose working folder is in one of `dirs`, with their descendants. Never this server or its parents.
 * SIGSTOP first (a stopped process cannot fork), then SIGKILL, a few rounds. Returns how many were ended.
 */
export function endRunProcesses(o: { runIds: string[] | 'all'; noted?: Iterable<number>; dirs?: string[] }, ps: () => OwnProc[] = ownProcs, cwd: (d: string) => number[] = cwdInside, kill: (pid: number, sig: NodeJS.Signals) => void = (pid, sig) => { try { process.kill(pid, sig) } catch {} }): number {
  const safe = new Set<number>([process.pid, process.ppid, 0, 1])
  let ended = 0
  for (let round = 0; round < 5; round++) {
    const procs = ps()
    const live = new Set(procs.map((p) => p.pid))
    const hit = new Set<number>()
    for (const p of procs) if (p.tag && (o.runIds === 'all' || o.runIds.includes(p.tag))) hit.add(p.pid)
    for (const p of o.noted ?? []) if (live.has(p)) hit.add(p)
    for (const d of o.dirs ?? []) for (const p of cwd(d)) hit.add(p)
    const all = [...descendants(procs, hit)].filter((p) => !safe.has(p) && live.has(p))
    if (!all.length) break
    for (const p of all) kill(p, 'SIGSTOP')
    for (const p of all) kill(p, 'SIGKILL')
    ended += all.length
  }
  return ended
}

/** pid and parent of this uid's processes (light: the watchdog's quarter-second look) */
function ownTree(): OwnProc[] {
  const r = Bun.spawnSync(['/bin/ps', '-x', '-U', String(process.getuid?.() ?? 0), '-o', 'pid=,ppid=,pgid='], { stdout: 'pipe', stderr: 'ignore', env: env0 })
  return r.stdout.toString().split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tag: null }))
}

/** RSS (KiB) of these pids, or null when ps fails */
function rssKiB(pids: number[]): number | null {
  if (!pids.length) return 0
  const r = Bun.spawnSync(['/bin/ps', '-o', 'rss=', '-p', pids.join(',')], { stdout: 'pipe', stderr: 'ignore', env: env0 })
  if (r.exitCode !== 0 && !r.stdout.length) return null
  return r.stdout.toString().split('\n').reduce((a, l) => a + (Number(l.trim()) || 0), 0)
}

interface Live { pid: number; noted: Set<number>; oom: boolean; watch: ReturnType<typeof setInterval>; note: ReturnType<typeof setInterval>; work: string | null }

/** what was swept when this server process started (once per base) */
const startSwept = new Set<string>()

/** The office SrtSystem. Runs live only while this server process does (documents mode has no jobs or dev servers);
 * a server start ends what an earlier one left. */
export function officeSystem(kit: DocKit, base: string): SrtSystem {
  const live = new Map<string, Live>()
  const unitOf = (runId: string) => `trina-dev-${runId}.scope`
  const devenv = devenvPaths(base).root
  if (!startSwept.has(base)) {
    startSwept.add(base)
    try { const n = endRunProcesses({ runIds: 'all', dirs: [devenv] }); if (n) console.warn(`[dev-env] ended ${n} process(es) an earlier server's runs left`) } catch { /* the next start tries again */ }
  }
  return {
    spawn(s) {
      const open = (f: string) => fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o640)
      const out = open(s.stdoutFile), err = s.stderrFile === s.stdoutFile ? out : open(s.stderrFile)
      try {
        for (const m of ['.oom', '.timeout']) try { fs.rmSync(s.exitFile + m, { force: true }) } catch {}
        const procs = Math.min(ownProcs().length + s.limits.pids, uidMax())
        const argv = officeArgv(kit, { settingsFile: s.settingsFile, command: s.command, procs, cpuSec: Math.max(1, Math.ceil(s.limits.runtimeMaxSec)) })
        const env = { ...s.env, [RUN_TAG]: s.runId }
        // a process group of its own (detached), so stop reaches the run's group at once; the tag and the noted pids
        // reach a process that left it
        const p = spawnChild(argv[0]!, argv.slice(1), { cwd: s.cwd, env, stdio: ['ignore', out, err], detached: true })
        const pid = p.pid ?? 0
        const started = Date.now()
        const limitKiB = s.limits.memoryMiB * 1024
        const work = s.env.TRINA_WORK && path.isAbsolute(s.env.TRINA_WORK) ? s.env.TRINA_WORK : null
        const noteNow = () => { try { const ps = ownTree(); const live = new Set(ps.map((x) => x.pid)); for (const x of descendants(ps, [...l.noted].filter((q) => live.has(q)))) l.noted.add(x) } catch { /* next look */ } }
        const l: Live = { pid, noted: new Set([pid]), oom: false, work, note: setInterval(noteNow, 250), watch: setInterval(() => {
          let all: number[] = []
          try {
            const ps = ownProcs()
            const tagged = ps.filter((x) => x.tag === s.runId).map((x) => x.pid)
            all = [...descendants(ps, [...l.noted, ...tagged])].filter((x) => ps.some((q) => q.pid === x))
            for (const x of all) l.noted.add(x)
          } catch { /* next second */ }
          const kb = rssKiB(all)
          const end = (marker: string, value: string) => { try { fs.writeFileSync(s.exitFile + marker, value) } catch {} ; endRunProcesses({ runIds: [s.runId], noted: l.noted }) }
          if (kb !== null && kb > limitKiB) { l.oom = true; end('.oom', String(kb)) }
          else if ((Date.now() - started) / 1000 > s.limits.runtimeMaxSec) end('.timeout', String(Math.round((Date.now() - started) / 1000)))
        }, 1000) }
        live.set(s.runId, l)
        const finish = () => {
          clearInterval(l.watch); clearInterval(l.note)
          // what the command left: its tag, what the watchdog saw, anything still working in its work folder
          try { endRunProcesses({ runIds: [s.runId], noted: l.noted, dirs: l.work ? [l.work] : [] }) } catch {}
          live.delete(s.runId)
        }
        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          p.once('exit', (code, signal) => {
            finish()
            try { if (code !== null) fs.writeFileSync(s.exitFile, `${code}\n`, { mode: 0o600 }) } catch {}
            resolve({ code, signal })
          })
          p.once('error', () => { finish(); resolve({ code: 127, signal: null }) })
        })
        return { pid, exited }
      } finally {
        fs.closeSync(out); if (err !== out) fs.closeSync(err)
      }
    },
    async stop(runId, pid) {
      const l = live.get(runId)
      const p = l?.pid ?? pid
      if (!p) return
      try { process.kill(-p, 'SIGTERM') } catch {}
      await Bun.sleep(2000)
      endRunProcesses({ runIds: [runId], noted: l?.noted ?? [p] })
    },
    async unit(runId): Promise<UnitInfo> {
      const l = live.get(runId)
      if (l) return { state: 'active', result: '', memoryBytes: (rssKiB([...l.noted]) ?? 0) * 1024 }
      return { state: '', result: '', memoryBytes: null }
    },
    async units() { return [...live.keys()].map(unitOf).filter((u) => UNIT_RE.test(u)) },
    async forget() {},
    oomKills(runId) { const l = live.get(runId); return l ? (l.oom ? 1 : 0) : null },
    cpuUsec() { return null },
    procs(runId) { const l = live.get(runId); return l ? [...l.noted].slice(0, 50).map((pid) => ({ pid, command: '', seconds: 0 })) : [] },
    async selfTest() {
      for (const f of [kit.node, kit.srtCli, '/usr/bin/sandbox-exec', '/usr/sbin/lsof']) if (!fs.existsSync(f)) return `${f} is missing: run the office installer again`
      const r = Bun.spawnSync([kit.node, kit.srtCli, '--version'], { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/var/empty' }, timeout: 20_000 })
      return r.exitCode === 0 ? '' : `srt does not start: ${r.stderr.toString().trim().slice(0, 300)}`
    },
    forward: null,
    bridge: null,
  }
}
