// The tenant's plan and the resource limits derived from it (docs/INSTALL-LINUX.md "요금제 파일", docs/DECISIONS.md
// "클라우드 리눅스 서버"). Component G.
//
// <base>/root/plan.json is written by root only (`mycel-ctl apply-plan`, run by the control plane on the hosted cloud),
// mode 0644: the server account reads it and cannot raise its own limits. The launcher reads the same file for the
// per-turn cgroup limits. A self-hosted install has no plan file: no seat limit, the admin's concurrency up to 16.
// The file is read again when its mtime changes (checked at most every 60 s), so a plan change applies without a
// restart.
//
// Resource limits that change how the server behaves on a machine (thread caps, the in-process parse cap) apply on
// Linux, or wherever a plan file exists; a Mac without one keeps today's behaviour (limitsActive()).
import fs from 'node:fs'
import os from 'node:os'
import type { Database } from 'bun:sqlite'
import { PlanFile } from '@mycel/shared/cloud-protocol'
import type { Locale } from '@mycel/shared/api'
import { getSetting } from '../admin/settings'
import { fail } from '../http/errors'

/** plan.json: the contract shared with the control plane and mycel-ctl (shared/src/cloud-protocol/files.ts PlanFile,
 * MIT) — one schema, no server-only copy. Unknown keys are ignored (the launcher's, a newer control plane's). */
export const Plan = PlanFile
export type Plan = PlanFile

const MIB = 1024 * 1024
/** the admin may pick 1–16 answers at the same time when no plan says otherwise (shared/src/api/admin.ts) */
export const CONCURRENCY_CEILING = 16
export const DEFAULT_CONCURRENCY = 3
/** read tool limit without a plan (files/store.ts READ_MAX) */
export const DEFAULT_READ_MAX_MIB = 200
export const DEFAULT_BACKUP_RETENTION_DAYS = 14
/** office documents parsed inside the server process (xlsx / xls / ods / hwp / hwpx) above this are refused where
 * limits apply: a 200 MB spreadsheet expanded in memory could take the whole tenant down */
export const IN_PROCESS_PARSE_MAX = 32 * MIB

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The numbers the launcher and the units use (3.8.5 of the Linux runtime spec): per-turn memory, converters. */
export function planLimits(p: Plan) {
  const turnBudgetMiB = p.memoryMiB - p.reserveMiB
  const turnMaxMiB = p.turnMemoryMaxMiB ?? clamp(Math.round((turnBudgetMiB / p.maxConcurrency) * 1.25), 512, 1536)
  const convMiB = p.convMemoryMaxMiB ?? clamp(Math.round(p.memoryMiB * 0.25), 512, 1536)
  return {
    turnBudgetMiB, turnMaxMiB, turnHighMiB: Math.floor(turnMaxMiB * 0.85), convMiB,
    launcherMemoryMaxMiB: turnBudgetMiB,
    serverMemoryMaxMiB: p.reserveMiB + convMiB,
    serverMemoryHighMiB: p.reserveMiB + Math.floor(convMiB * 0.75),
  }
}

// ---------------- loading ----------------
interface Loaded { file: string; mtimeMs: number; size: number; plan: Plan | null; checkedAt: number }
let configured: string | null = null
let loaded: Loaded | null = null
let override: { plan: Plan | null } | null = null
let platformOverride: NodeJS.Platform | null = null
let warn: (m: string, d?: object) => void = () => {}
/** the last time the file did not parse (diagnostics: "the plan file is not valid"), null once a good one is read */
let problem: { at: string; error: string } | null = null
const RECHECK_MS = 60_000

/** Where the plan file is: $MYCEL_PLAN_FILE (the Linux server unit sets it), else what the server configured from its
 * layout (<base>/root/plan.json of an installed server), else none. */
export function planFile(): string | null { return process.env.MYCEL_PLAN_FILE || configured }

/** Called once at start by the ops service (system/ops.ts) with the install layout's plan file. */
export function configurePlan(o: { file: string | null; log?: { warn(m: string, d?: object): void } }) {
  configured = o.file
  if (o.log) warn = (m, d) => o.log!.warn(m, d)
  loaded = null
  problem = null
}

/** Read the file again at the next currentPlan() (SIGHUP from mycel-ctl, system/managed.ts reloadManagedFiles). */
export function forgetPlanCheck() { if (loaded) loaded.checkedAt = -Infinity }

/** The plan file did not parse the last time it changed (the previous plan stays in force), else null. */
export function planFileProblem(): { at: string; error: string } | null { currentPlan(); return problem }

/** Tests: a fixed plan (null = none) instead of the file; undefined = back to the file. */
export function setPlanForTests(p: Plan | null | undefined) { override = p === undefined ? null : { plan: p } }
/** Tests: pretend to run on another platform (limitsActive). null = the real one. */
export function setLimitsPlatformForTests(p: NodeJS.Platform | null) { platformOverride = p }

/** The current plan, or null (no plan file: self-hosted without limits). A file that does not parse is reported and
 * the last good plan stays in force (a broken write must not lift the limits). */
export function currentPlan(now = Date.now()): Plan | null {
  if (override) return override.plan
  const file = planFile()
  if (!file) return null
  if (loaded && loaded.file === file && now - loaded.checkedAt < RECHECK_MS) return loaded.plan
  let st: fs.Stats
  try { st = fs.statSync(file) } catch {
    loaded = { file, mtimeMs: 0, size: 0, plan: null, checkedAt: now }
    problem = null
    return null
  }
  if (loaded && loaded.file === file && loaded.mtimeMs === st.mtimeMs && loaded.size === st.size) { loaded.checkedAt = now; return loaded.plan }
  let plan: Plan | null = loaded?.file === file ? loaded.plan : null
  try { plan = Plan.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); problem = null } catch (e) {
    problem = { at: new Date(now).toISOString(), error: String(e).slice(0, 300) }
    warn('the plan file is not valid; the previous limits stay', { file, err: problem.error })
  }
  loaded = { file, mtimeMs: st.mtimeMs, size: st.size, plan, checkedAt: now }
  return plan
}

/** Linux, or any machine with a plan: the resource limits below apply. A Mac without a plan keeps its behaviour. */
export function limitsActive(): boolean {
  return (platformOverride ?? process.platform) === 'linux' || currentPlan() !== null
}

// ---------------- what the server uses ----------------
/** The admin's "answers at the same time" (settings.concurrency, 1–16, default 3). */
export function concurrencySetting(db: Database): number {
  const v = getSetting<unknown>(db, 'concurrency')
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= CONCURRENCY_CEILING ? v : DEFAULT_CONCURRENCY
}
/** The highest concurrency the admin may set: the plan's, else 16. */
export function concurrencyMax(): number { return currentPlan()?.maxConcurrency ?? CONCURRENCY_CEILING }
/** Answers that may run at the same time: min(admin setting, plan). The stored setting is kept as is, so a bigger
 * plan later gives back what the admin chose. One function for the queue (chat/runtime.ts) and diagnostics. */
export function effectiveConcurrency(db: Database): number { return Math.min(concurrencySetting(db), concurrencyMax()) }

// ---------------- memory: queued answers wait while the machine is short of it ----------------
/** what one answer is expected to take when no plan says so (Claude Code + its tools; an estimate, not measured yet) */
export const TURN_MEMORY_ESTIMATE_MIB = 768
/** kept free for the server, converters and the kernel before another answer starts */
export const MEMORY_HEADROOM_MIB = 256
let memoryOverride: { mib: number | null } | null = null
/** Tests: a fixed available memory in MiB (null = unknown); undefined = back to the machine's. */
export function setAvailableMemoryForTests(mib: number | null | undefined) { memoryOverride = mib === undefined ? null : { mib } }

/** Memory that can still be used without swapping: MemAvailable of /proc/meminfo (counts reclaimable cache), null
 * where it is not known. A Mac returns null: os.freemem() leaves out the cache macOS reclaims, so it would hold
 * answers back on a machine that has room. */
export function availableMemoryMiB(): number | null {
  if (memoryOverride) return memoryOverride.mib
  if ((platformOverride ?? process.platform) !== 'linux') return null
  try {
    const m = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))
    return m ? Math.floor(Number(m[1]) / 1024) : null
  } catch { return null }
}
/** one answer's expected memory: the plan's per-turn high mark, else TURN_MEMORY_ESTIMATE_MIB */
export function turnMemoryEstimateMiB(): number {
  const p = currentPlan()
  return p ? planLimits(p).turnHighMiB : TURN_MEMORY_ESTIMATE_MIB
}
/** How many answers may run now, given `running` already do and the concurrency `limit`: fewer than the limit when
 * the memory left would not hold another answer. Never below the ones running (lowering never stops a turn), and one
 * always may run when none do, so a small machine still answers. Only where the resource limits apply (Linux or a
 * plan) and the available memory is known; elsewhere the limit as before. */
export function memoryAdmission(running: number, limit: number): number {
  if (!limitsActive()) return limit
  const avail = availableMemoryMiB()
  if (avail === null) return limit
  const more = Math.max(0, Math.floor((avail - MEMORY_HEADROOM_MIB) / turnMemoryEstimateMiB()))
  return Math.min(limit, Math.max(running === 0 ? 1 : running, running + more))
}

/** CPU the server's own helpers may use: the plan's cores (a container may show the host's cores), else this machine's. */
export function cpuBudget(): number {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  const plan = currentPlan()?.cpuCores
  return Math.max(1, plan ? Math.min(cores, plan) : cores)
}
/** ripgrep --threads (null = ripgrep's own choice, all cores: a Mac without a plan) */
export function rgThreads(): number | null { return limitsActive() ? Math.min(2, cpuBudget()) : null }
/** whisper.cpp -t */
export function whisperThreads(): number {
  if (!limitsActive()) return Math.max(1, Math.min(8, os.availableParallelism() - 1))
  return Math.max(1, Math.min(4, cpuBudget() - 1))
}
/** ONNX runtime threads of the embedding model (null = library default) */
export function onnxThreads(): { intraOpNumThreads: number; interOpNumThreads: number } | null {
  return limitsActive() ? { intraOpNumThreads: Math.min(2, cpuBudget()), interOpNumThreads: 1 } : null
}
/** typst compile --jobs: only the Linux bundle's typst (0.15.1) is known to take it */
export function typstJobs(): number | null { return (platformOverride ?? process.platform) === 'linux' ? 2 : null }
/** the read tool's size limit in bytes (plan readMaxMiB, else 200 MiB as before) */
export function readMaxBytes(): number { return (currentPlan()?.readMaxMiB ?? DEFAULT_READ_MAX_MIB) * MIB }
/** documents parsed inside the server process: refused above this (Infinity = no cap, a Mac without a plan) */
export function inProcessParseMax(): number { return limitsActive() ? IN_PROCESS_PARSE_MAX : Infinity }
/** local backups kept this many days (the hosted cloud keeps 3: the off-site copy is the real one) */
export function backupRetentionDays(): number { return currentPlan()?.localBackupRetentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS }
/** the plan's disk in bytes, or null */
export function planDiskBytes(): number | null { const g = currentPlan()?.diskGiB; return g ? g * 1024 * MIB : null }

// ---------------- seats ----------------
export const SEAT_MSG = {
  ko: (n: number) => `요금제의 인원 한도(${n}명)에 도달했습니다. 사용하지 않는 계정을 비활성화하거나 요금제를 바꿔 주세요.`,
  en: (n: number) => `The plan's member limit (${n}) is reached. Disable an account that is no longer used, or change the plan.`,
  id: (n: number) => `Batas anggota paket (${n}) sudah tercapai. Nonaktifkan akun yang tidak dipakai lagi, atau ubah paket.`,
}
const MANAGE = { ko: ' 요금제 변경: ', en: ' Change the plan: ', id: ' Ubah paket: ' }

/** Active accounts: what counts against the plan's seats (disabled and deleted ones do not). */
export function seatsUsed(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND deleted_at IS NULL").get() as { n: number }).n
}
export function seatLimit(): number | null { return currentPlan()?.maxActiveMembers ?? null }
/** where the owner changes the plan (the control plane's account page), shown with every over-the-limit message */
export function planManageUrl(): string | null { return currentPlan()?.links?.account ?? null }

/** Refuse (409 plan_limit) when `adding` more active accounts would go over the plan's seats. Call it inside the write
 * transaction that adds the account, so two requests at once cannot both take the last seat. */
export function assertSeatFree(db: Database, locale: Locale, adding = 1): void {
  const max = seatLimit()
  if (max === null || seatsUsed(db) + adding <= max) return
  const url = planManageUrl()
  fail('plan_limit', (SEAT_MSG[locale] ?? SEAT_MSG.en)(max) + (url ? (MANAGE[locale] ?? MANAGE.en) + url : ''), { params: { reason: 'seat_limit', limit: max, ...(url ? { manageUrl: url } : {}) } })
}

// ---------------- concurrency over the plan ----------------
export const CONCURRENCY_MSG = {
  ko: (n: number) => `요금제의 동시 실행 수(${n})보다 크게 정할 수 없습니다.`,
  en: (n: number) => `It cannot be set higher than the plan's answers at the same time (${n}).`,
  id: (n: number) => `Tidak bisa diatur lebih tinggi dari jawaban bersamaan paket (${n}).`,
}
/** PATCH /api/admin/engines and /api/admin/settings: a concurrency above the plan is refused (409 plan_limit), not cut. */
export function assertConcurrencyAllowed(n: number | undefined, locale: Locale): void {
  if (n === undefined) return
  const max = concurrencyMax()
  if (n <= max) return
  const url = planManageUrl()
  fail('plan_limit', (CONCURRENCY_MSG[locale] ?? CONCURRENCY_MSG.en)(max), { fields: { 'body.concurrency': 'concurrency_over_plan' }, params: { reason: 'concurrency_over_plan', max, ...(url ? { manageUrl: url } : {}) } })
}
