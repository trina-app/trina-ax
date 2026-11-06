// The plan caps of the dev environment on srt: <base>/root/dev-env.json (format 1, from PR #58). The same file and the
// same rules as mycel-boxd's parseEntitlement (native/cmd/mycel-boxd/plan.go), so a server with the box reads the same
// file during the move. Root owns the file. The install writes the devenv slice from it too, so the server cannot
// raise these caps. An unknown key or a bad value is an error: the dev environment is then not available (fail closed).
import fs from 'node:fs'
import path from 'node:path'
import type { DevEnvLimits } from '@mycel/shared/api'

export interface DevEnvPlan {
  format: 1
  plan: string
  /** jobs at the same time, and dev servers at the same time */
  maxRunning: number
  /** the CPU of the whole devenv slice, and the maximum for one run */
  cpus: number
  /** the memory of the whole devenv slice, and the maximum for one run */
  memoryMiB: number
  /** the maximum tasks of one run */
  pids: number
  /** not used by srt; kept so that the file of the box still parses */
  diskGiB: number
  /** "open" or "offline"; "" = offline */
  network: '' | 'open' | 'offline'
}

const KEYS = new Set(['format', 'plan', 'maxRunning', 'cpus', 'memoryMiB', 'pids', 'diskGiB', 'network'])
const MAX_BYTES = 4 << 10
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** Parse the file's text. Throws with a short reason. */
export function parsePlan(text: string): DevEnvPlan {
  if (text.length > MAX_BYTES) throw new Error('dev-env.json: too large')
  let v: unknown
  try { v = JSON.parse(text) } catch { throw new Error('dev-env.json: not JSON') }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('dev-env.json: not an object')
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) if (!KEYS.has(k)) throw new Error(`dev-env.json: unknown key ${k}`)
  if (o.format !== 1) throw new Error('dev-env.json: format must be 1')
  if (typeof o.plan !== 'string' || o.plan === '' || o.plan.length > 32) throw new Error('dev-env.json: plan name must be 1-32 characters')
  const { maxRunning, cpus, memoryMiB, pids } = o
  const diskGiB = o.diskGiB ?? 0
  if (!isInt(maxRunning) || maxRunning < 1 || maxRunning > 4 || typeof cpus !== 'number' || cpus < 0.25 || cpus > 4
    || !isInt(memoryMiB) || memoryMiB < 256 || memoryMiB > 8192 || !isInt(pids) || pids < 64 || pids > 4096
    || !isInt(diskGiB) || diskGiB < 1 || diskGiB > 32) throw new Error('dev-env.json: a value is out of range')
  const network = o.network ?? ''
  if (network !== '' && network !== 'open' && network !== 'offline') throw new Error('dev-env.json: network must be open or offline')
  return { format: 1, plan: o.plan, maxRunning, cpus, memoryMiB, pids, diskGiB, network }
}

export type PlanState = { ok: true; plan: DevEnvPlan | null } | { ok: false; reason: string }

/** Read the file. No file = no plan (self-hosted: the fixed ranges apply). The file and its folder must belong to root,
 * and only root may write to them. */
export function loadPlan(file: string): PlanState {
  let st: fs.Stats
  try { st = fs.lstatSync(file) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, plan: null }
    return { ok: false, reason: `cannot read ${file}` }
  }
  for (const [p, s] of [[file, st], [path.dirname(file), fs.lstatSync(path.dirname(file))]] as const) {
    const isRight = p === file ? s.isFile() : s.isDirectory()
    if (!isRight || s.uid !== 0 || (s.mode & 0o022) !== 0) return { ok: false, reason: `${p} must belong to root, and only root may write to it` }
  }
  try { return { ok: true, plan: parsePlan(fs.readFileSync(file, 'utf8')) } } catch (e) { return { ok: false, reason: (e as Error).message } }
}

/** The fixed ranges when there is no plan (self-hosted). */
export const NO_PLAN_MAX_RUNNING = 2

/** The limits of one run: the project's wish, cut to the plan caps. The plan's network "offline" (or "") forces
 * offline, the same as the box. */
export function effectiveLimits(wish: DevEnvLimits, network: 'open' | 'offline', plan: DevEnvPlan | null): { cpus: number; memoryMiB: number; pids: number; network: 'open' | 'offline'; maxRunning: number } {
  if (!plan) return { cpus: wish.cpus, memoryMiB: wish.memoryMiB, pids: wish.pids, network, maxRunning: NO_PLAN_MAX_RUNNING }
  return {
    cpus: Math.min(wish.cpus, plan.cpus),
    memoryMiB: Math.min(wish.memoryMiB, plan.memoryMiB),
    pids: Math.min(wish.pids, plan.pids),
    network: plan.network === 'open' ? network : 'offline',
    maxRunning: plan.maxRunning,
  }
}

/** The devenv slice's values that the install writes (scripts/dev-env/srt/install-srt.sh), as text for a test. */
export function sliceValues(plan: DevEnvPlan): { MemoryMax: string; CPUQuota: string; TasksMax: number } {
  return { MemoryMax: `${plan.memoryMiB}M`, CPUQuota: `${Math.round(plan.cpus * 100)}%`, TasksMax: plan.pids * (2 * plan.maxRunning + 2) }
}
