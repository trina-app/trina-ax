// Storage use of the team's disk (docs/DECISIONS.md "클라우드 리눅스 서버"). Component G.
//
// The truth is statfs of the team folder's file system: a hosted cloud tenant's disk is the plan's size (an LXC rootfs
// or a VM disk of that size), so no separate quota ledger can drift from it. Levels: below 80% ok; from 80% the owner
// and admins are told (a notice, at most once per 24 h, audited as storage.warn); from 90% diagnostics warn; from 95%
// diagnostics fail. Writes into the team folder are refused (507 storage_full) when the free space minus the write
// would drop under max(512 MiB, 2% of the disk): AI write / edit / make_file, file saves, uploads, chat attachments.
// The refusal applies where the resource limits apply (Linux, a plan: system/limits.ts); a Mac keeps its own checks
// (upload sessions' 1 GB margin, backups' 2 GB) and behaviour.
//
// What uses the space (Admin > System) is measured 5 minutes after start and then hourly, walking the folders with a
// pause every 1000 entries: team (the team folder without .system), history (.system/history), trash (.system/trash),
// backups (.system/backups + data/backups), models (data/models), data (the rest of the server data), app (installed
// versions), other (what is left: the engine folders the server account cannot read, the OS).
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Locale, StorageBreakdown, StorageLevel, StorageStatus } from '@mycel/shared/api'
import { HttpError } from '../http/errors'
import { ToolError } from '../policy/errors'
import { getSetting, setSetting } from '../admin/settings'
import { limitsActive, planDiskBytes, planManageUrl } from './limits'

const MIB = 1024 * 1024
export const RESERVE_MIN_BYTES = 512 * MIB
export const RESERVE_FRACTION = 0.02
export const WARN_PERCENT = 80
export const HIGH_PERCENT = 90
export const FULL_PERCENT = 95
const SNAPSHOT_MS = 30_000
const ALERT_EVERY_MS = 24 * 3600_000
export const ALERT_KEY = 'system.storageWarnAt'

export interface StatFs { bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint }
export interface Snapshot { totalBytes: number; freeBytes: number; usedBytes: number; percent: number }

export function levelOf(percent: number): StorageLevel {
  return percent >= FULL_PERCENT ? 'full' : percent >= HIGH_PERCENT ? 'high' : percent >= WARN_PERCENT ? 'warn' : 'ok'
}

export function reserveBytes(total: number): number { return Math.max(RESERVE_MIN_BYTES, Math.floor(total * RESERVE_FRACTION)) }

export function snapshotOf(s: StatFs): Snapshot {
  const b = Number(s.bsize)
  const total = Number(s.blocks) * b
  const free = Number(s.bavail) * b
  const used = (Number(s.blocks) - Number(s.bfree)) * b
  // percent of what users can have (used + available): the root-reserved blocks are not theirs
  const usable = used + free
  return { totalBytes: total, freeBytes: free, usedBytes: used, percent: usable > 0 ? Math.round((used / usable) * 1000) / 10 : 0 }
}

// ---------------- the process's guard (one team per server process) ----------------
interface GuardConf { root: string; statfs: (p: string) => StatFs; enforce: () => boolean }
let guard: GuardConf | null = null
let cached: { at: number; s: Snapshot } | null = null

/** Set by the ops service at start (and by tests): which file system, how to read it, whether writes are refused. */
export function configureStorageGuard(c: { root: string; statfs?: (p: string) => StatFs; enforce?: () => boolean } | null) {
  guard = c ? { root: c.root, statfs: c.statfs ?? ((p) => fs.statfsSync(p)), enforce: c.enforce ?? limitsActive } : null
  cached = null
}

/** statfs of the team folder (30 s cache); null when not configured or unreadable. */
export function storageSnapshot(fresh = false): Snapshot | null {
  if (!guard) return null
  if (!fresh && cached && Date.now() - cached.at < SNAPSHOT_MS) return cached.s
  try { cached = { at: Date.now(), s: snapshotOf(guard.statfs(guard.root)) } } catch { return null }
  return cached.s
}

/** Is there room for `bytes` more? null = not enforced here (a Mac without a plan, no guard). */
export function storageRoom(bytes: number): { ok: boolean; freeBytes: number; reserveBytes: number } | null {
  if (!guard || !guard.enforce()) return null
  // fresh for the decision: the 30 s cache could let a burst of uploads through
  const s = storageSnapshot(true)
  if (!s) return null
  const reserve = reserveBytes(s.totalBytes)
  return { ok: s.freeBytes - Math.max(0, bytes) >= reserve, freeBytes: s.freeBytes, reserveBytes: reserve }
}

/** HTTP writes (uploads, saves, attachments): 507 storage_full in the caller's language, with the plan's page. */
export function assertStorageRoom(bytes: number): void {
  const r = storageRoom(bytes)
  if (!r || r.ok) return
  const url = planManageUrl()
  throw new HttpError('storage_full', undefined, { params: { reason: 'storage_full', freeBytes: r.freeBytes, ...(url ? { manageUrl: url } : {}) } })
}

/** The AI's writes (write, edit, make_file): a tool error the AI can tell the person about. */
export function assertStorageRoomForAI(bytes: number): void {
  const r = storageRoom(bytes)
  if (!r || r.ok) return
  throw new ToolError('the team\'s storage is full: nothing can be saved until space is freed (empty the trash or delete files; an admin sees the details in Admin > System)', 'storage_full')
}

// ---------------- the monitor (ops service) ----------------
type Measure = StorageBreakdown
const ZERO: Measure = { team: 0, history: 0, trash: 0, backups: 0, models: 0, data: 0, app: 0, other: 0 }

/** Bytes on disk of a folder tree (lstat blocks × 512; links not followed), yielding every 1000 entries. */
export async function treeBytes(dir: string, skip: (abs: string) => boolean = () => false): Promise<number> {
  let total = 0
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let names: string[]
    try { names = fs.readdirSync(d) } catch { continue }
    for (const name of names) {
      const abs = path.join(d, name)
      if (skip(abs)) continue
      let st: fs.Stats
      try { st = fs.lstatSync(abs) } catch { continue }
      total += st.blocks !== undefined ? st.blocks * 512 : st.size
      if (st.isDirectory()) stack.push(abs)
      if (++n % 1000 === 0) await new Promise((r) => setImmediate(r))
    }
  }
  return total
}

export interface MonitorOptions {
  db: Database
  teamRoot: string
  dataDir: string
  /** app/ of an installed server (null in dev) */
  appDir: string | null
  now?: () => number
  /** tell the owner and admins (realtime notice); returns how many were told */
  notify: (message: Record<Locale, string>) => void
  audit: (detail: Record<string, unknown>) => void
}

const ALERT = {
  ko: (p: number) => `저장 공간을 ${p}% 쓰고 있습니다. 휴지통을 비우거나 오래된 파일·버전을 정리해 주세요(관리자 > 시스템에서 항목별 사용량을 볼 수 있습니다).`,
  en: (p: number) => `${p}% of the storage is used. Empty the trash or clean up old files and versions (Admin > System shows what uses the space).`,
  id: (p: number) => `${p}% penyimpanan sudah terpakai. Kosongkan tempat sampah atau rapikan berkas dan versi lama (Admin > Sistem menunjukkan rinciannya).`,
}

export class StorageMonitor {
  private breakdown: Measure | null = null
  private measuredAt: string | null = null
  private measuring: Promise<void> | null = null
  constructor(private o: MonitorOptions) {}
  private now() { return this.o.now?.() ?? Date.now() }

  /** Walk the folders (one walk at a time). */
  measure(): Promise<void> {
    return (this.measuring ??= (async () => {
      const t = this.o.teamRoot, d = this.o.dataDir
      const sys = path.join(t, '.system')
      const m: Measure = { ...ZERO }
      m.team = await treeBytes(t, (a) => a === sys)
      m.history = await treeBytes(path.join(sys, 'history'))
      m.trash = await treeBytes(path.join(sys, 'trash'))
      m.backups = await treeBytes(path.join(sys, 'backups')) + await treeBytes(path.join(d, 'backups'))
      m.models = await treeBytes(path.join(d, 'models'))
      m.data = await treeBytes(d, (a) => a === path.join(d, 'backups') || a === path.join(d, 'models'))
      m.app = this.o.appDir ? await treeBytes(this.o.appDir) : 0
      const s = storageSnapshot(true)
      const known = m.team + m.history + m.trash + m.backups + m.models + m.data + m.app
      m.other = s ? Math.max(0, s.usedBytes - known) : 0
      this.breakdown = m
      this.measuredAt = new Date(this.now()).toISOString()
    })().finally(() => { this.measuring = null }))
  }

  /** From 80%: tell the owner and admins, at most once per 24 h (kept in the settings table across restarts). */
  checkAlert(): boolean {
    const s = storageSnapshot(true)
    if (!s || levelOf(s.percent) === 'ok') return false
    const last = getSetting<string>(this.o.db, ALERT_KEY)
    if (last && this.now() - Date.parse(last) < ALERT_EVERY_MS) return false
    setSetting(this.o.db, ALERT_KEY, new Date(this.now()).toISOString())
    const p = Math.floor(s.percent)
    this.o.audit({ percent: s.percent, freeBytes: s.freeBytes, totalBytes: s.totalBytes })
    this.o.notify({ ko: ALERT.ko(p), en: ALERT.en(p), id: ALERT.id(p) })
    return true
  }

  /** GET /api/admin/storage */
  status(): StorageStatus {
    const s = storageSnapshot() ?? { totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0 }
    const disk = planDiskBytes()
    return {
      totalBytes: s.totalBytes, usedBytes: s.usedBytes, freeBytes: s.freeBytes, percent: s.percent, level: levelOf(s.percent),
      reserveBytes: reserveBytes(s.totalBytes),
      writesRefused: (storageRoom(0)?.ok ?? true) === false,
      breakdown: this.breakdown, measuredAt: this.measuredAt,
      planDiskGiB: disk === null ? null : disk / 1024 ** 3,
    }
  }
}
