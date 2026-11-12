// What the srt runner asks of a Mac team server (docs/DECISIONS.md "Dev environment on a Mac team server"). macOS has
// no systemd scopes and no cgroups. Each run gets a dev slot account (_axdev1, _axdev2, ...: one uid for one run at a
// time) and runs as it through sudo; run-wrap-mac does the limits, the RAM watchdog and the clean-up as that account.
// Why one uid per run: a process reads the argv and the environment of every process of its own uid (KERN_PROCARGS2; a
// sandbox cannot block it), the process limit counts per uid, and `kill -1` as the slot account ends every process of
// the run, also one that left its process group.
//
// A state file per run (<base>/devenv/run/<runId>.slot, the server's, hidden from every run) names the slot. The unit
// name of a run (trina-dev-<runId>.scope) stays the id the rows and the runner use; there is no systemd unit here.
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { SLOT_ACCOUNT_RE, SRT_PATHS, UNIT_RE, devenvPaths, macArgv } from './config'
import type { SpawnSpec, SrtSystem, UnitInfo } from './system'

export interface MacConfig {
  base: string
  /** the dev slot accounts (MYCEL_DEV_ENV_SLOTS, set by install-macos.sh) */
  slots: string[]
  /** the port of slot i is portBase + i + 1 (MYCEL_DEV_ENV_PORT_BASE): the run's dev server listens there */
  portBase: number
  /** all slots together may use this much memory (MYCEL_DEV_ENV_POOL_MIB: half of the Mac's memory) */
  poolMiB: number
  /** the most processes of one run (MYCEL_DEV_ENV_PIDS_MAX: the Mac's process table is shared, kern.maxproc 4000) */
  pidsMax: number
  /** the ACL entries that give a run's account and the server the run's folders (MYCEL_DEV_ENV_ACL, install-macos.sh) */
  acl: string[]
}

/** The Mac settings from the server's environment (the installer writes them into the LaunchDaemon). Null with a reason
 * when they are missing or wrong: the dev environment is then not available. */
export function macConfig(base: string, env: Record<string, string | undefined> = process.env): { ok: true; c: MacConfig } | { ok: false; reason: string } {
  const slots = (env.MYCEL_DEV_ENV_SLOTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!slots.length) return { ok: false, reason: 'no dev slot accounts (MYCEL_DEV_ENV_SLOTS): run the installer again' }
  const bad = slots.find((s) => !SLOT_ACCOUNT_RE.test(s))
  if (bad) return { ok: false, reason: `not a dev slot account: ${bad.slice(0, 40)}` }
  const num = (k: string, def: number, min: number, max: number) => {
    const v = env[k] === undefined || env[k] === '' ? def : Number(env[k])
    return Number.isInteger(v) && v >= min && v <= max ? v : null
  }
  const portBase = num('MYCEL_DEV_ENV_PORT_BASE', 47900, 1024, 65000), poolMiB = num('MYCEL_DEV_ENV_POOL_MIB', 2048, 256, 1 << 20), pidsMax = num('MYCEL_DEV_ENV_PIDS_MAX', 384, 64, 4096)
  if (portBase === null || poolMiB === null || pidsMax === null) return { ok: false, reason: 'a dev environment value of the installer is out of range (MYCEL_DEV_ENV_PORT_BASE, _POOL_MIB, _PIDS_MAX)' }
  const acl = (env.MYCEL_DEV_ENV_ACL ?? '').split(';').map((s) => s.trim()).filter(Boolean)
  if (!acl.length || acl.some((a) => !/^(user|group):[_a-z][a-z0-9_]{0,31} allow [a-z_,]+$/.test(a))) return { ok: false, reason: 'no valid folder ACL for the dev accounts (MYCEL_DEV_ENV_ACL): run the installer again' }
  return { ok: true, c: { base, slots, portBase, poolMiB, pidsMax, acl } }
}

/** One process of a slot account (ps). */
export interface MacProc { uid: number; pid: number; rssKiB: number; cpuSec: number; ageSec: number; command: string }

/** What the Mac does for the runner; a test replaces it (the real one runs ps, sudo and chmod). */
export interface MacHost {
  /** the processes of these uids */
  procs(uids: number[]): MacProc[]
  /** the uid of an account, or null */
  uid(account: string): number | null
  /** spawn the argv in a session of its own (it outlives a server restart); stdout and stderr to these fds */
  spawn(argv: string[], o: { cwd: string; out: number; err: number }): { pid: number; exited: Promise<{ code: number | null; signal: string | null }> }
  /** run the argv and wait (sudo stop, sudo check, chmod) */
  run(argv: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }>
}

/** "[[dd-]hh:]mm:ss[.ss]" (ps etime and time) in seconds */
export function psSeconds(t: string): number {
  const [d, rest] = t.includes('-') ? [Number(t.split('-')[0]), t.split('-')[1]!] : [0, t]
  const parts = rest.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return d * 86400 + parts.reduce((a, n) => a * 60 + n, 0)
}

/** Lines of `ps -x -o uid=,pid=,rss=,time=,etime=,command=`, for these uids. */
export function parsePs(text: string, uids: Set<number>): MacProc[] {
  const out: MacProc[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s?(.*)$/.exec(line)
    if (!m || !uids.has(Number(m[1]))) continue
    out.push({ uid: Number(m[1]), pid: Number(m[2]), rssKiB: Number(m[3]), cpuSec: psSeconds(m[4]!), ageSec: psSeconds(m[5]!), command: (m[6] ?? '').slice(0, 300) })
  }
  return out
}

export function realMacHost(): MacHost {
  const uids = new Map<string, number | null>()
  return {
    procs(list) {
      if (!list.length) return []
      const r = Bun.spawnSync(['/bin/ps', '-x', '-U', list.join(','), '-o', 'uid=,pid=,rss=,time=,etime=,command='], { stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
      return parsePs(r.stdout.toString(), new Set(list))
    },
    uid(account) {
      if (!uids.has(account)) {
        const r = Bun.spawnSync(['/usr/bin/id', '-u', account], { stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin' } })
        const n = Number(r.stdout.toString().trim())
        uids.set(account, r.exitCode === 0 && Number.isInteger(n) && n > 0 ? n : null)
      }
      return uids.get(account) ?? null
    },
    spawn(argv, o) {
      // detached: a session of its own, so launchd does not end the run with the server's process group (a server
      // restart or update keeps the runs, as on Linux)
      const p = spawnChild(argv[0]!, argv.slice(1), { cwd: o.cwd, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', o.out, o.err], detached: true })
      p.unref()
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        p.once('exit', (code, signal) => resolve({ code, signal }))
        p.once('error', () => resolve({ code: 127, signal: null }))
      })
      return { pid: p.pid ?? 0, exited }
    },
    async run(argv, timeoutMs) {
      const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      const code = await p.exited
      clearTimeout(t)
      return { code, out, err }
    },
  }
}

interface SlotState { runId: string; account: string; port: number; exitFile: string; pid: number; at: number }

const unitOf = (runId: string) => `trina-dev-${runId}.scope`
const RUN_ID = /^[a-z0-9]{16}$/

function openOut(file: string): number {
  return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o640)
}

/** The macOS SrtSystem. */
let sharedHost: MacHost | null = null
export function macSystem(c: MacConfig, host: MacHost = (sharedHost ??= realMacHost())): SrtSystem & { slotOf(runId: string): { account: string; port: number } | null } {
  const runDir = devenvPaths(c.base).run
  const stateFile = (runId: string) => path.join(runDir, `${runId}.slot`)
  const read = (runId: string): SlotState | null => {
    if (!RUN_ID.test(runId)) return null
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(runId), 'utf8')) as SlotState
      return c.slots.includes(s.account) ? s : null
    } catch { return null }
  }
  const states = (): SlotState[] => {
    let names: string[] = []
    try { names = fs.readdirSync(runDir) } catch { return [] }
    return names.filter((n) => n.endsWith('.slot')).map((n) => read(n.slice(0, -5))).filter((s): s is SlotState => !!s)
  }
  const uidOf = (account: string) => host.uid(account)
  const procsOf = (account: string) => { const u = uidOf(account); return u === null ? [] : host.procs([u]) }
  const marker = (s: SlotState, kind: 'oom' | 'timeout') => fs.existsSync(`${s.exitFile}.${kind}`)
  const stopAccount = (account: string) => host.run([SRT_PATHS.sudo, '-n', '-u', account, SRT_PATHS.runWrapMac, 'stop'], 30_000).catch(() => null)

  /** A free slot: no state file names it and it has no process. A slot with processes and no state is a leftover (a
   * server crash): it is stopped and skipped this time. A state whose run ended (no process, older than a minute) is
   * given up only when every slot is taken. */
  async function pick(): Promise<{ account: string; index: number } | null> {
    const taken = new Map(states().map((s) => [s.account, s]))
    let stale: { account: string; index: number; runId: string } | null = null
    for (const [index, account] of c.slots.entries()) {
      if (uidOf(account) === null) continue
      const s = taken.get(account)
      const busy = procsOf(account).length > 0
      if (!s && !busy) return { account, index }
      if (!s && busy) { await stopAccount(account); continue }
      if (s && !busy && Date.now() - s.at > 60_000 && !stale) stale = { account, index, runId: s.runId }
    }
    if (stale) { forget(stale.runId); return { account: stale.account, index: stale.index } }
    return null
  }
  function forget(runId: string) {
    const s = read(runId)
    if (s) for (const f of [`${s.exitFile}.oom`, `${s.exitFile}.timeout`]) try { fs.rmSync(f, { force: true }) } catch {}
    try { fs.rmSync(stateFile(runId), { force: true }) } catch {}
  }
  /** the run's writable folders get the ACL again: a file that the server moved in from outside the team folder keeps
   * no inherited ACL (chmod -R +a adds nothing that is there already; files of a slot account are not the server's
   * and fail, they have the inherited entries) */
  async function grant(folders: string[]) {
    for (const f of folders) for (const a of c.acl) await host.run(['/bin/chmod', '-R', '+a', a, f], 120_000).catch(() => null)
  }

  return {
    async spawn(s: SpawnSpec) {
      const slot = await pick()
      if (!slot) throw new Error('busy: every dev slot account is in use; try again in a minute')
      const port = c.portBase + slot.index + 1
      await grant(s.writable ?? [])
      const state: SlotState = { runId: s.runId, account: slot.account, port, exitFile: s.exitFile, pid: 0, at: Date.now() }
      fs.writeFileSync(stateFile(s.runId), JSON.stringify(state), { mode: 0o600, flag: 'wx' })
      const out = openOut(s.stdoutFile), err = s.stderrFile === s.stdoutFile ? out : openOut(s.stderrFile)
      try {
        const env = { ...s.env, PORT: String(port), TRINA_PREVIEW_PORT: String(port) }
        const limits = { ...s.limits, memoryMiB: Math.min(s.limits.memoryMiB, c.poolMiB), pids: Math.min(s.limits.pids, c.pidsMax) }
        const argv = macArgv({ account: slot.account, env, limits, poolMiB: c.poolMiB, exitFile: s.exitFile, settingsFile: s.settingsFile, command: s.command })
        const p = host.spawn(argv, { cwd: s.cwd, out, err })
        state.pid = p.pid
        fs.writeFileSync(stateFile(s.runId), JSON.stringify(state), { mode: 0o600 })
        return p
      } catch (e) { forget(s.runId); throw e } finally {
        fs.closeSync(out); if (err !== out) fs.closeSync(err)
      }
    },
    async stop(runId) {
      const s = read(runId)
      if (s) await stopAccount(s.account)
    },
    async unit(runId): Promise<UnitInfo> {
      const s = read(runId)
      if (!s) return { state: '', result: '', memoryBytes: null }
      const procs = procsOf(s.account)
      if (procs.length) return { state: 'active', result: '', memoryBytes: procs.reduce((a, p) => a + p.rssKiB, 0) * 1024 }
      if (marker(s, 'oom')) return { state: 'failed', result: 'oom-kill', memoryBytes: null }
      if (marker(s, 'timeout')) return { state: 'failed', result: 'timeout', memoryBytes: null }
      // sudo has not started run-wrap-mac yet
      if (Date.now() - s.at < 5000 && !fs.existsSync(s.exitFile)) return { state: 'activating', result: '', memoryBytes: null }
      return { state: '', result: '', memoryBytes: null }
    },
    async units() { return states().map((s) => unitOf(s.runId)).filter((u) => UNIT_RE.test(u)) },
    async forget(runId) { forget(runId) },
    oomKills(runId) { const s = read(runId); return s ? (marker(s, 'oom') ? 1 : 0) : null },
    cpuUsec(runId) {
      const s = read(runId)
      return s ? Math.round(procsOf(s.account).reduce((a, p) => a + p.cpuSec, 0) * 1e6) : null
    },
    procs(runId) {
      const s = read(runId)
      return s ? procsOf(s.account).slice(0, 50).map((p) => ({ pid: p.pid, command: p.command, seconds: Math.round(p.ageSec) })) : []
    },
    async selfTest() {
      const account = c.slots.find((a) => uidOf(a) !== null)
      if (!account) return `no dev slot account exists (${c.slots.join(', ')}): run the installer again`
      const r = await host.run([SRT_PATHS.sudo, '-n', '-u', account, SRT_PATHS.runWrapMac, 'check'], 15_000).catch((e) => ({ code: 1, out: '', err: String(e) }))
      return r.code === 0 && r.out.trim() === `ok ${account}` ? '' : `cannot run as the dev account ${account} (sudoers rule missing?): ${(r.err || r.out).trim().slice(0, 300)}`
    },
    slotOf(runId) { const s = read(runId); return s ? { account: s.account, port: s.port } : null },
  }
}
