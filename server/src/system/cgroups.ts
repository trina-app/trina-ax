// Converter cgroup (linux-runtime spec 3.8.2, D9): on Linux in production the server unit delegates its cgroup S to
// the server account (Delegate=memory pids cpu). Before the server starts any other process, it moves itself and its
// bootstrap into S/main (a cgroup with processes cannot enable controllers for its children) and creates S/conv with
// the converters' shared limit. tools/isolate.ts then starts every converter through
// `mycel-sandbox cgexec --cgroup S/conv …` (the root-owned helper the unit names in MYCEL_SANDBOX_HELPER): the helper
// joins S/conv, sets rlimits and execs bwrap, so the converter and all its children are inside the limit from the
// start. A converter that runs away (a hostile PDF, a huge video) is OOM-killed alone instead of taking the server
// and the turns with it. Elsewhere (macOS, dev, no delegation, no helper) nothing changes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Logger } from '../log'

export interface ConverterCgroup {
  /** S/conv: converters run here */
  dir: string
  /** absolute path of mycel-sandbox (root-owned, from the unit's MYCEL_SANDBOX_HELPER) */
  helper: string
  memoryMiB: number
}

export type CgroupState = { state: 'delegated'; conv: ConverterCgroup } | { state: 'off' | 'none'; reason: string }

let current: CgroupState = { state: 'off', reason: 'not set up' }

/** The converter cgroup, when the server set one up at start. */
export function converterCgroup(): ConverterCgroup | null {
  return current.state === 'delegated' ? current.conv : null
}

export function cgroupState(): CgroupState { return current }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The converters' memory budget in MiB (spec 3.8.5): plan.json convMemoryMaxMiB, else clamp(RAM × 0.25, 512, 1536)
 * with RAM = the plan's memoryMiB or this machine's memory. Kept small and local; the plan file is root-owned and
 * checked by mycel-ctl apply-plan, so a value outside the plan ranges falls back to the computed one. */
export function convBudgetMiB(planFile: string | undefined, machineMiB = Math.round(os.totalmem() / 1048576)): number {
  let mem = machineMiB
  if (planFile) {
    try {
      const p = JSON.parse(fs.readFileSync(planFile, 'utf8'))
      if (Number.isInteger(p.convMemoryMaxMiB) && p.convMemoryMaxMiB >= 256 && p.convMemoryMaxMiB <= 65536) return p.convMemoryMaxMiB
      if (Number.isInteger(p.memoryMiB) && p.memoryMiB >= 1024 && p.memoryMiB <= 262144) mem = p.memoryMiB
    } catch { /* no plan (self-install): the machine's memory */ }
  }
  return clamp(Math.round(mem * 0.25), 512, 1536)
}

export interface SetupOptions {
  log?: Pick<Logger, 'info' | 'warn'>
  mode: 'dev' | 'prod'
  /** defaults: the real system (tests pass a fake cgroupfs folder) */
  platform?: NodeJS.Platform
  cgroupFs?: string
  selfCgroup?: string
  pid?: number
  ppid?: number
  uid?: number
  helper?: string
  planFile?: string
  cpus?: number
  machineMiB?: number
}

/** Set up S/main and S/conv (call first thing in the server's start, before any child process). Never throws. */
export function setupServerCgroups(o: SetupOptions): CgroupState {
  current = trySetup(o)
  if (current.state === 'delegated') o.log?.info('converter cgroup ready', { dir: current.conv.dir, memoryMiB: current.conv.memoryMiB })
  else if (current.state === 'none') o.log?.warn('converters run without a cgroup limit', { reason: current.reason })
  return current
}

function trySetup(o: SetupOptions): CgroupState {
  if ((o.platform ?? process.platform) !== 'linux') return { state: 'off', reason: 'not Linux' }
  if (o.mode !== 'prod') return { state: 'off', reason: 'not production' }
  const helper = o.helper ?? process.env.MYCEL_SANDBOX_HELPER ?? ''
  if (!helper || !path.isAbsolute(helper) || !fs.existsSync(helper)) return { state: 'none', reason: 'no MYCEL_SANDBOX_HELPER' }
  const cgfs = o.cgroupFs ?? '/sys/fs/cgroup'
  try {
    const self = o.selfCgroup ?? fs.readFileSync('/proc/self/cgroup', 'utf8')
    const line = self.split('\n').find((l) => l.startsWith('0::'))
    if (!line) return { state: 'none', reason: 'no cgroup v2' }
    const rel = line.slice(3).trim()
    if (!rel.startsWith('/') || rel.split('/').includes('..')) return { state: 'none', reason: `unexpected cgroup path ${rel}` }
    let s = path.join(cgfs, rel)
    if (path.basename(s) === 'main') s = path.dirname(s) // the bootstrap restarted us inside S/main
    const st = fs.statSync(s)
    if (st.uid !== (o.uid ?? process.getuid!())) return { state: 'none', reason: `cgroup ${s} is not delegated to this account` }
    const have = new Set(fs.readFileSync(path.join(s, 'cgroup.controllers'), 'utf8').trim().split(/\s+/))
    if (!have.has('memory') || !have.has('pids')) return { state: 'none', reason: `cgroup ${s} lacks memory or pids` }
    const main = path.join(s, 'main')
    fs.mkdirSync(main, { recursive: true, mode: 0o755 })
    // everything still in S (the bootstrap, this server) moves to S/main; one pid at a time (the kernel's rule)
    const inS = fs.readFileSync(path.join(s, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean)
    for (const p of new Set([...inS, String(o.ppid ?? process.ppid), String(o.pid ?? process.pid)])) {
      try { fs.writeFileSync(path.join(main, 'cgroup.procs'), p) } catch { /* gone, or not ours */ }
    }
    const ctrls = ['+memory', '+pids', ...(have.has('cpu') ? ['+cpu'] : [])].join(' ')
    fs.writeFileSync(path.join(s, 'cgroup.subtree_control'), ctrls)
    const conv = path.join(s, 'conv')
    fs.mkdirSync(conv, { recursive: true, mode: 0o755 })
    const mib = convBudgetMiB(o.planFile ?? process.env.MYCEL_PLAN_FILE, o.machineMiB)
    const set = (f: string, v: string, optional = false) => {
      try { fs.writeFileSync(path.join(conv, f), v) } catch (e) { if (!optional) throw e }
    }
    set('memory.max', String(mib * 1048576))
    set('memory.high', String(Math.floor(mib * 0.85) * 1048576))
    set('memory.swap.max', '0', true)
    set('pids.max', '128')
    if (have.has('cpu')) set('cpu.max', `${Math.min(2, o.cpus ?? os.availableParallelism()) * 100000} 100000`, true)
    // Leaf processes live below conv so qualified per-job leaves can share its aggregate budget.
    fs.mkdirSync(path.join(conv,'legacy'),{recursive:true,mode:0o755})
    fs.writeFileSync(path.join(conv,'cgroup.subtree_control'),ctrls)
    return { state: 'delegated', conv: { dir: conv, helper, memoryMiB: mib } }
  } catch (e) {
    return { state: 'none', reason: (e as Error).message }
  }
}

/** argv prefix that runs a converter inside the converter cgroup with rlimits (spec 3.8.2); [] without one. */
export function cgexecPrefix(timeoutMs: number): string[] {
  const c = converterCgroup()
  if (!c) return []
  return [c.helper, 'cgexec', '--cgroup', path.join(c.dir,'legacy'), '--oom-score-adj', '500', '--rlimit-cpu', String(Math.ceil(timeoutMs / 1000) + 5),
    '--rlimit-fsize', String(1024 ** 3), '--rlimit-nofile', '1024', '--']
}

/** tests only */
export function _resetCgroupsForTest() { current = { state: 'off', reason: 'not set up' } }
