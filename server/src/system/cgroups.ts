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

/** S/print: HTML printing (files/html-pdf.ts), beside S/conv, never inside it. A headless Chromium is several processes
 * and about a hundred threads (each one a pid) and, measured, more memory than the smallest converter budget, so in
 * S/conv it took the pids LibreOffice and whisper need and did not fit. Each print runs in a leaf of its own below
 * (S/print/<id>, PRINT_ONE_MIB and PRINT_ONE_PIDS, the whole leaf killed together); `parallel` prints fit the budget.
 * Absent (null): the machine is too small for one print, and HTML printing is not offered. */
export interface PrintCgroup { dir: string; helper: string; memoryMiB: number; parallel: number }

export type CgroupState = { state: 'delegated'; conv: ConverterCgroup; print: PrintCgroup | null } | { state: 'off' | 'none'; reason: string }

let current: CgroupState = { state: 'off', reason: 'not set up' }

/** The converter cgroup, when the server set one up at start. */
export function converterCgroup(): ConverterCgroup | null {
  return current.state === 'delegated' ? current.conv : null
}

/** The print cgroup: null off Linux production (no limits apply: macOS, dev), and where the machine cannot hold one
 * print (see printCgroupState) */
export function printCgroup(): PrintCgroup | null {
  return current.state === 'delegated' ? current.print : null
}
/** Whether HTML printing fits here: 'free' (no cgroup limits: macOS, dev, no delegation), 'ok', or 'too_small'. */
export function printCgroupState(): 'free' | 'ok' | 'too_small' {
  return current.state !== 'delegated' ? 'free' : current.print ? 'ok' : 'too_small'
}

/** One print, measured in its S/print leaf on Debian 13 (arm64, kernel 6.8, the real mycel-sandbox cgexec; memory.peak
 * and pids.peak; docs/DECISIONS.md "HTML to PDF"). Debian's chromium 156: a one-page quote 243 MiB and 123 tasks, 600
 * table rows with twelve 5 MB photos 290 MiB and 121 tasks, 190 pages with a photo and a table on each 486 MiB and 124
 * tasks. chromium-headless-shell 156: 89, 188 and 285 MiB, 71–76 tasks. The limits are about 1.5 times the worst. */
export const PRINT_ONE_MIB = 768
export const PRINT_ONE_PIDS = 192
/** The memory HTML printing may use (S/print): a quarter of the plan's or the machine's memory, at most two prints. */
export function printBudgetMiB(planFile: string | undefined, machineMiB = Math.round(os.totalmem() / 1048576)): number {
  let mem = machineMiB
  if (planFile) {
    try {
      const p = JSON.parse(fs.readFileSync(planFile, 'utf8'))
      if (Number.isInteger(p.memoryMiB) && p.memoryMiB >= 1024 && p.memoryMiB <= 262144) mem = p.memoryMiB
    } catch { /* no plan (self-install): the machine's memory */ }
  }
  return Math.min(Math.round(mem * 0.25), PRINT_ONE_MIB * 2)
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
    // HTML printing beside conv (PrintCgroup); none where one print does not fit
    let print: PrintCgroup | null = null
    const printMib = printBudgetMiB(o.planFile ?? process.env.MYCEL_PLAN_FILE, o.machineMiB)
    const parallel = Math.min(2, Math.floor(printMib / PRINT_ONE_MIB))
    if (parallel >= 1) {
      const dir = path.join(s, 'print')
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      const pset = (f: string, v: string, optional = false) => {
        try { fs.writeFileSync(path.join(dir, f), v) } catch (e) { if (!optional) throw e }
      }
      pset('memory.max', String(parallel * PRINT_ONE_MIB * 1048576))
      pset('memory.swap.max', '0', true)
      pset('pids.max', String(parallel * PRINT_ONE_PIDS))
      if (have.has('cpu')) pset('cpu.max', `${Math.min(2, o.cpus ?? os.availableParallelism()) * 100000} 100000`, true)
      fs.writeFileSync(path.join(dir, 'cgroup.subtree_control'), ctrls)
      // leaves an earlier server left (it stopped during a print): their processes killed, the leaves removed
      for (const leaf of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!leaf.isDirectory() || !leaf.name.startsWith('p-')) continue
        try { fs.writeFileSync(path.join(dir, leaf.name, 'cgroup.kill'), '1') } catch { /* an older kernel */ }
        try { fs.rmdirSync(path.join(dir, leaf.name)) } catch { /* still emptying: the next start */ }
      }
      print = { dir, helper, memoryMiB: parallel * PRINT_ONE_MIB, parallel }
    } else {
      // a print cgroup left by an earlier start on a bigger plan: nothing runs there any more
      try { fs.rmdirSync(path.join(s, 'print')) } catch { /* none, or not empty */ }
    }
    return { state: 'delegated', conv: { dir: conv, helper, memoryMiB: mib }, print }
  } catch (e) {
    return { state: 'none', reason: (e as Error).message }
  }
}

/** argv prefix that runs a converter inside the converter cgroup with rlimits (spec 3.8.2); [] without one. The CPU
 * limit is the wall-clock limit for each of `threads` threads (RLIMIT_CPU counts them all: whisper.cpp -t 2 would be
 * stopped at half its time otherwise). */
export function cgexecPrefix(timeoutMs: number, threads = 1, leaf?: { dir: string; oomScoreAdj: number }): string[] {
  const c = converterCgroup()
  if (!c) return []
  return [c.helper, 'cgexec', '--cgroup', leaf?.dir ?? path.join(c.dir,'legacy'), '--oom-score-adj', String(leaf?.oomScoreAdj ?? 500), '--rlimit-cpu', String(Math.ceil((timeoutMs / 1000) * Math.max(1, Math.floor(threads))) + 5),
    '--rlimit-fsize', String(1024 ** 3), '--rlimit-nofile', '1024', '--']
}

/**
 * A leaf of S/print for one print: its own memory and pids limits, swap off, and the whole leaf killed together when
 * its memory runs out (memory.oom.group). The caller kills what is left (killPrintLeaf) and removes it. Null where
 * there are no cgroup limits (macOS, dev).
 */
export function makePrintLeaf(): string | null {
  const p = printCgroup()
  if (!p) return null
  const dir = path.join(p.dir, `p-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { mode: 0o755 })
  const set = (f: string, v: string, optional = false) => { try { fs.writeFileSync(path.join(dir, f), v) } catch (e) { if (!optional) throw e } }
  set('memory.max', String(PRINT_ONE_MIB * 1048576))
  set('memory.swap.max', '0', true)
  set('pids.max', String(PRINT_ONE_PIDS))
  set('memory.oom.group', '1', true)
  return dir
}

/** Peak memory (MiB) and tasks of a print leaf, where the kernel keeps them (memory.peak, pids.peak) */
export function printLeafPeak(dir: string): { memoryMiB?: number; pids?: number } {
  const num = (f: string) => { try { const v = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim()); return Number.isFinite(v) ? v : undefined } catch { return undefined } }
  const mem = num('memory.peak')
  return { ...(mem !== undefined ? { memoryMiB: Math.round(mem / 1048576) } : {}), ...(num('pids.peak') !== undefined ? { pids: num('pids.peak') } : {}) }
}

/** Kill every process left in a print leaf (cgroup.kill: also one that left the browser's process group) and remove
 * the leaf; a leaf that still holds a process a moment later is left for the next start. */
export async function killPrintLeaf(dir: string): Promise<void> {
  try { fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1') } catch { /* gone, or an older kernel */ }
  for (let i = 0; i < 40; i++) {
    try { fs.rmdirSync(dir); return } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return }
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** tests only */
export function _resetCgroupsForTest() { current = { state: 'off', reason: 'not set up' } }
