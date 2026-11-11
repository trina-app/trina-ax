// Storage use of the team's disk (docs/DECISIONS.md "클라우드 리눅스 서버"). Component G.
//
// The truth is statfs of the team folder's file system, the only measure of use: no separate ledger of team files. A
// hosted cloud tenant's disk is normally the plan's size, but it can be larger: a Proxmox disk cannot shrink, so a team
// moved to a smaller plan (a refund, a forced move) keeps the larger disk. Then the plan's bytes are the capped total
// and every reader uses that view (planView); `used` stays statfs, so a downgraded VM acts like a VM created on that
// plan, overhead included. The physical disk shrinks only when the VM is moved or rebuilt. No plan, or a plan that is
// not smaller than the disk: the real disk, as before.
//
// Levels: below 80% ok; from 80% the owner and admins are told (a notice, at most once per 24 h, audited as
// storage.warn); from 90% diagnostics warn; from 95% diagnostics fail. Writes into the team folder are refused (507
// storage_full) when the free space minus the write would drop under max(512 MiB, 2% of the disk): AI write / edit /
// make_file, file saves, uploads, chat attachments. The refusal applies where the resource limits apply (Linux, a plan:
// system/limits.ts); a Mac keeps its own checks (upload sessions' 1 GB margin, backups' 2 GB) and behaviour.
//
// A disk larger than the plan has a softer rule for the plan's limit. "Over" means used + the plan's reserve is above
// the plan's bytes: the point where a real disk of that size refuses. The first time the team is over, a grace period
// of 7 days starts (GRACE_KEY in the settings table: when usage first went over; audited as storage.grace, the owner
// and admins are told once). A write that first crosses the limit is allowed and starts it. After the grace period,
// new saves, uploads and AI writes are refused; read, download and delete keep working and no data is deleted. A hard
// cap of 2x the plan's bytes applies at all times. The real-disk check above still applies. When usage drops under the
// limit writes work again at once. The grace state itself clears only under 80% of the plan's bytes, so a small dip
// (a backup prune, a temporary file) does not give a new 7 days; an upgrade clears it too, because the cap rises.
// Local backups count in `used`, so a full backup stops when the plan leaves no room for it (system/backup.ts), as on a
// real disk of that size.
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
import { getSetting, setSetting, teamTimeZone } from '../admin/settings'
import { limitsActive, planDiskBytes, planManageUrl } from './limits'
import { zonedParts } from './time-zone'

const MIB = 1024 * 1024
export const RESERVE_MIN_BYTES = 512 * MIB
export const RESERVE_FRACTION = 0.02
export const WARN_PERCENT = 80
export const HIGH_PERCENT = 90
export const FULL_PERCENT = 95
const SNAPSHOT_MS = 30_000
const ALERT_EVERY_MS = 24 * 3600_000
export const ALERT_KEY = 'system.storageWarnAt'
/** when usage first went over the plan's limit (ISO time; null or missing = not over) */
export const GRACE_KEY = 'system.storageOverSince'
/** when the owner and admins were last told that a grace period started (ISO time) */
export const GRACE_TOLD_KEY = 'system.storageGraceToldAt'
export const GRACE_MS = 7 * 24 * 3600_000
export const HARD_CAP_FACTOR = 2

export interface StatFs { bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint }
export interface Snapshot { totalBytes: number; freeBytes: number; usedBytes: number; percent: number }

export function levelOf(percent: number): StorageLevel {
  return percent >= FULL_PERCENT ? 'full' : percent >= HIGH_PERCENT ? 'high' : percent >= WARN_PERCENT ? 'warn' : 'ok'
}

export function reserveBytes(total: number): number { return Math.max(RESERVE_MIN_BYTES, Math.floor(total * RESERVE_FRACTION)) }

/** Where the Mac's rule decides (a Mac, dev, anything but a Linux production install: system/ops.ts): under this much
 * free space answers, uploads and saves can fail and the disk check fails. The storage card uses it too, so the card
 * never says "여유 있음" on a small disk the check below it calls almost full (QA TC-209). */
export function absoluteFloor(total: number): number { return Math.max(10 * 1024 ** 3, total * 0.05) }

/** An error from a full disk: ENOSPC / EDQUOT from the file system, SQLITE_FULL ("database or disk is full") from the
 * database, also as the cause of another error. */
export function isDiskFullError(e: unknown): boolean {
  for (let x = e, depth = 0; x && typeof x === 'object' && depth < 4; x = (x as { cause?: unknown }).cause, depth++) {
    const code = (x as { code?: unknown }).code
    if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'SQLITE_FULL') return true
    if (DISK_FULL_TEXT.test(String((x as { message?: unknown }).message ?? ''))) return true
  }
  return false
}
/** what a process says when the disk is full (Node, libc, SQLite) */
export const DISK_FULL_TEXT = /\bENOSPC\b|no space left on device|disk quota exceeded|database or disk is full/i

/** Is one of these folders' disks (almost) out of space right now (fresh statfs)? For telling a crash apart from a
 * full disk after the fact: under `floor` (64 MiB) nothing works reliably. */
export function diskAlmostFull(paths: string[], floor = 64 * MIB, statfs: (p: string) => StatFs = (p) => fs.statfsSync(p)): boolean {
  for (const p of paths) {
    try { if (snapshotOf(statfs(p)).freeBytes < floor) return true } catch {}
  }
  return false
}

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
/** The settings table, or a fake in tests. null = no value. */
export interface GuardStore { get(key: string): string | null; set(key: string, value: string | null): void }
interface GuardConf { root: string; statfs: (p: string) => StatFs; enforce: () => boolean; store: GuardStore; now: () => number }
let guard: GuardConf | null = null
let cached: { at: number; s: Snapshot } | null = null

function memoryStore(): GuardStore {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { if (v === null) m.delete(k); else m.set(k, v) } }
}

/** Set by the ops service at start (and by tests): which file system, how to read it, whether writes are refused,
 * where the grace state is kept (without a store: in memory only), the clock. */
export function configureStorageGuard(c: { root: string; statfs?: (p: string) => StatFs; enforce?: () => boolean; store?: GuardStore; now?: () => number } | null) {
  guard = c ? { root: c.root, statfs: c.statfs ?? ((p) => fs.statfsSync(p)), enforce: c.enforce ?? limitsActive, store: c.store ?? memoryStore(), now: c.now ?? Date.now } : null
  cached = null
}

/** statfs of the team folder (30 s cache); null when not configured or unreadable. */
export function storageSnapshot(fresh = false): Snapshot | null {
  if (!guard) return null
  if (!fresh && cached && Date.now() - cached.at < SNAPSHOT_MS) return cached.s
  try { cached = { at: Date.now(), s: snapshotOf(guard.statfs(guard.root)) } } catch { return null }
  return cached.s
}

/** The plan's bytes when the plan is smaller than the real disk, else null (no plan, or a plan the disk does not exceed). */
function capOf(real: Snapshot): number | null {
  const plan = planDiskBytes()
  return plan !== null && plan < real.totalBytes ? plan : null
}

/** The view every reader uses: the plan's bytes as the total when the disk is larger. `used` stays the real value. */
export function planView(real: Snapshot): Snapshot {
  const cap = capOf(real)
  if (cap === null) return real
  // 100 at most: at the hard cap the real ratio is 200 (StorageStatus.percent)
  return { totalBytes: cap, usedBytes: real.usedBytes, freeBytes: Math.min(real.freeBytes, Math.max(0, cap - real.usedBytes)), percent: Math.min(100, Math.round((real.usedBytes / cap) * 1000) / 10) }
}

/** The capped view of storageSnapshot (same cache). */
export function cappedSnapshot(fresh = false): Snapshot | null {
  const s = storageSnapshot(fresh)
  return s && planView(s)
}

/** Over the plan's limit: a real disk of that size would refuse at this point. */
const isOver = (used: number, cap: number) => used + reserveBytes(cap) > cap

function readOverSince(): number | null {
  const v = guard!.store.get(GRACE_KEY)
  const t = v ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}

function writeOverSince(t: number | null): number | null {
  guard!.store.set(GRACE_KEY, t === null ? null : new Date(t).toISOString())
  return t
}

/** Start or clear the grace state from what is used now. A settings write only when it changes. No plan known (no plan
 * file, or it cannot be read now): no change at all, not even a settings read, so the state outlives a bad plan file. */
function syncOverSince(real: Snapshot): number | null {
  if (planDiskBytes() === null) return null
  const cap = capOf(real)
  const since = readOverSince()
  if (cap === null) return since === null ? null : writeOverSince(null)
  const now = guard!.now()
  if (since === null) return isOver(real.usedBytes, cap) ? writeOverSince(now) : null
  if (real.usedBytes < cap * (WARN_PERCENT / 100)) return writeOverSince(null)
  // written while the clock was ahead: the grace period must not grow by that error
  return since > now ? writeOverSince(now) : since
}

/** The decision for `bytes` more. `since`: when usage first went over. `pending`: bytes already promised and not yet in
 * `used`, which only the hard cap counts. Changes nothing. */
function refusedBy(real: Snapshot, bytes: number, since: number | null, pending = 0): boolean {
  if (real.freeBytes - bytes < reserveBytes(real.totalBytes)) return true
  const cap = capOf(real)
  if (cap === null) return false
  if (real.usedBytes + bytes + pending > cap * HARD_CAP_FACTOR) return true
  return isOver(real.usedBytes, cap) && since !== null && guard!.now() >= since + GRACE_MS
}

/** Is there room for `bytes` more? null = not enforced here (a Mac without a plan, no guard). The write paths call this:
 * it starts and clears the grace state. Read paths use storageState. `pending`: see refusedBy. */
export function storageRoom(bytes: number, pending = 0): { ok: boolean; freeBytes: number; reserveBytes: number } | null {
  if (!guard || !guard.enforce()) return null
  // fresh for the decision: the 30 s cache could let a burst of uploads through
  const s = storageSnapshot(true)
  if (!s) return null
  const n = Math.max(0, bytes)
  // measured use only: a write that first crosses the limit passes, and the next check starts the grace period. A check
  // for a write that never lands (a canceled upload, a failed download) must not start it.
  const since = syncOverSince(s)
  const ok = !refusedBy(s, n, since, pending)
  const v = planView(s)
  return { ok, freeBytes: v.freeBytes, reserveBytes: reserveBytes(v.totalBytes) }
}

/** For the read paths (GET /api/admin/storage, diagnostics): are writes refused now, when does the grace period end.
 * Changes nothing, so a look at the page does not start a grace period. */
export function storageState(): { writesRefused: boolean; graceEndsAt: string | null } {
  const s = guard && storageSnapshot(true)
  if (!guard || !s) return { writesRefused: false, graceEndsAt: null }
  const cap = capOf(s)
  const since = cap !== null && isOver(s.usedBytes, cap) ? readOverSince() : null
  return { writesRefused: guard.enforce() && refusedBy(s, 0, since), graceEndsAt: since === null ? null : new Date(since + GRACE_MS).toISOString() }
}

/** For the backup gate: what a plan smaller than the disk leaves free. null = no such plan, or no guard in this process
 * (a mycel-ctl command): the real disk decides. */
export function planFreeBytes(): number | null {
  const s = storageSnapshot(true)
  return s && capOf(s) !== null ? planView(s).freeBytes : null
}

/** An instant in the team's time zone, to the minute (the grace end in messages: refusal starts at that time). */
export function timeIn(iso: string, tz: string): string {
  const p = zonedParts(new Date(iso), tz)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${p.y}-${two(p.m)}-${two(p.d)} ${two(p.h)}:${two(p.min)}`
}

/** HTTP writes (uploads, saves, attachments): 507 storage_full in the caller's language, with the plan's page. */
export function assertStorageRoom(bytes: number, pending = 0): void {
  const r = storageRoom(bytes, pending)
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
  /** the Mac's absolute rule decides the disk check here (not a Linux production install): the card follows it */
  absoluteRule?: () => boolean
  /** storage.warn, or storage.grace when a grace period starts */
  audit: (detail: Record<string, unknown>, action?: 'storage.warn' | 'storage.grace') => void
}

const ALERT = {
  ko: (p: number) => `저장 공간을 ${p}% 쓰고 있어요. 휴지통을 비우거나 오래된 파일·버전을 정리해 주세요(관리자 > 시스템에서 항목별 사용량을 볼 수 있어요).`,
  en: (p: number) => `${p}% of the storage is used. Empty the trash or clean up old files and versions (Admin > System shows what uses the space).`,
  id: (p: number) => `${p}% penyimpanan sudah terpakai. Kosongkan tempat sampah atau rapikan berkas dan versi lama (Admin > Sistem menunjukkan rinciannya).`, ja: (p: number) => `ストレージの${p}%を使用しています。ゴミ箱を空にするか、古いファイルやバージョンを整理してください（管理 > システムで容量の内訳を確認できます）。`, es: (p: number) => `Se usa el ${p}% del almacenamiento. Vacíe la papelera o elimine archivos y versiones antiguos (Administración > Sistema muestra qué ocupa espacio).`,
}

const GRACE_ALERT: Record<Locale, (date: string) => string> = {
  ko: (d) => `저장 공간이 요금제 한도를 넘었어요. ${d}까지 사용량을 줄이지 않으면 그 뒤로 저장, 업로드, AI의 파일 쓰기가 거부돼요. 읽기, 내려받기, 삭제는 계속되고 데이터는 지워지지 않아요. 삭제한 파일은 휴지통에 남아 사용량에 계속 포함되니 휴지통도 비워 주세요.`,
  en: (d) => `The storage is over the plan's limit. If the use is not under the limit by ${d}, saves, uploads and the AI's file writes are refused from that time. Read, download and delete keep working, and no data is deleted. Deleted files stay in the trash and still count, so empty the trash too.`,
  id: (d) => `Penyimpanan melewati batas paket. Jika pemakaian belum di bawah batas pada ${d}, penyimpanan, unggahan, dan penulisan berkas AI ditolak setelah waktu itu. Membaca, mengunduh, dan menghapus tetap berfungsi, dan tidak ada data yang dihapus. Berkas yang dihapus tetap ada di tempat sampah dan masih dihitung, jadi kosongkan juga tempat sampah.`,
  ja: (d) => `ストレージがプランの上限を超えました。${d}までに使用量を上限より減らさないと、その後は保存、アップロード、AIによるファイル書き込みが拒否されます。読み取り、ダウンロード、削除は引き続き使え、データは削除されません。削除したファイルはゴミ箱に残って使用量に含まれるため、ゴミ箱も空にしてください。`,
  es: (d) => `El almacenamiento supera el límite del plan. Si el uso no baja del límite antes del ${d}, después de esa hora se rechazan los guardados, las cargas y las escrituras de archivos de la IA. Leer, descargar y eliminar siguen funcionando, y no se borra ningún dato. Los archivos eliminados quedan en la papelera y siguen contando, así que vacíe también la papelera.`,
}

/** The grace period starts when writes are refused already: the hard cap, or the real disk. */
const REFUSED_ALERT: Record<Locale, string> = {
  ko: '저장 공간이 요금제 한도를 넘어 저장, 업로드, AI의 파일 쓰기가 거부돼요. 읽기, 내려받기, 삭제는 계속되고 데이터는 지워지지 않아요. 삭제한 파일은 휴지통에 남아 사용량에 계속 포함되니 휴지통도 비워 주세요.',
  en: 'The storage is over the plan\'s limit: saves, uploads and the AI\'s file writes are refused. Read, download and delete keep working, and no data is deleted. Deleted files stay in the trash and still count, so empty the trash too.',
  id: 'Penyimpanan melewati batas paket: penyimpanan, unggahan, dan penulisan berkas AI ditolak. Membaca, mengunduh, dan menghapus tetap berfungsi, dan tidak ada data yang dihapus. Berkas yang dihapus tetap ada di tempat sampah dan masih dihitung, jadi kosongkan juga tempat sampah.',
  ja: 'ストレージがプランの上限を超えているため、保存、アップロード、AIによるファイル書き込みは拒否されます。読み取り、ダウンロード、削除は引き続き使え、データは削除されません。削除したファイルはゴミ箱に残って使用量に含まれるため、ゴミ箱も空にしてください。',
  es: 'El almacenamiento supera el límite del plan: se rechazan los guardados, las cargas y las escrituras de archivos de la IA. Leer, descargar y eliminar siguen funcionando, y no se borra ningún dato. Los archivos eliminados quedan en la papelera y siguen contando, así que vacíe también la papelera.',
}

export class StorageMonitor {
  private breakdown: Measure | null = null
  private measuredAt: string | null = null
  private measuring: Promise<void> | null = null
  constructor(private o: MonitorOptions) {}
  private now() { return this.o.now?.() ?? guard?.now() ?? Date.now() }

  /** Walk the folders (one walk at a time). */
  measure(): Promise<void> {
    return (this.measuring ??= (async () => {
      const t = this.o.teamRoot, d = this.o.dataDir
      const sys = path.join(t, '.system')
      const m: Measure = { ...ZERO }
      // the team's own files, and the files sent in its chat rooms (kept in .system/rooms, rooms/files.ts)
      m.team = await treeBytes(t, (a) => a === sys) + await treeBytes(path.join(sys, 'rooms'))
      m.history = await treeBytes(path.join(sys, 'history'))
      m.trash = await treeBytes(path.join(sys, 'trash'))
      m.backups = await treeBytes(path.join(sys, 'backups')) + await treeBytes(path.join(d, 'backups'))
      m.models = await treeBytes(path.join(d, 'models'))
      m.data = await treeBytes(d, (a) => a === path.join(d, 'backups') || a === path.join(d, 'models'))
      m.app = this.o.appDir ? await treeBytes(this.o.appDir) : 0
      // the real value, not the capped view: "other" is what is left on the real disk
      const s = storageSnapshot(true)
      const known = m.team + m.history + m.trash + m.backups + m.models + m.data + m.app
      m.other = s ? Math.max(0, s.usedBytes - known) : 0
      this.breakdown = m
      this.measuredAt = new Date(this.now()).toISOString()
    })().finally(() => { this.measuring = null }))
  }

  /** Tell the owner and admins once that a grace period started. A write can start it, so the "told" time has its own
   * key. A team that goes over and back again is not told more than once per 24 h. */
  private tellGrace(s: Snapshot, since: number, refused: boolean): boolean {
    const told = guard!.store.get(GRACE_TOLD_KEY)
    if (told && (Date.parse(told) >= since || this.now() - Date.parse(told) < ALERT_EVERY_MS)) return false
    const now = new Date(this.now()).toISOString()
    guard!.store.set(GRACE_TOLD_KEY, now)
    // the 80% notice waits: one message at a time
    setSetting(this.o.db, ALERT_KEY, now)
    const ends = new Date(since + GRACE_MS).toISOString()
    const at = timeIn(ends, teamTimeZone(this.o.db))
    this.o.audit({ percent: s.percent, freeBytes: s.freeBytes, totalBytes: s.totalBytes, graceEndsAt: ends }, 'storage.grace')
    this.o.notify(refused ? REFUSED_ALERT : { ko: GRACE_ALERT.ko(at), en: GRACE_ALERT.en(at), id: GRACE_ALERT.id(at), ja: GRACE_ALERT.ja(at), es: GRACE_ALERT.es(at) })
    return true
  }

  /** The regular check (ops timer). The grace state starts and clears here too, so a team already over the limit gets
   * its grace period with no write. Then from 80%: tell the owner and admins, at most once per 24 h (kept in the
   * settings table across restarts). */
  checkAlert(): boolean {
    const real = storageSnapshot(true)
    if (!real) return false
    const s = planView(real)
    const since = syncOverSince(real)
    // a state kept after a dip under the limit tells nobody: the team is not over now
    if (since !== null && isOver(s.usedBytes, s.totalBytes) && this.tellGrace(s, since, refusedBy(real, 0, since))) return true
    if (levelOf(s.percent) === 'ok') return false
    const last = getSetting<string>(this.o.db, ALERT_KEY)
    if (last && this.now() - Date.parse(last) < ALERT_EVERY_MS) return false
    setSetting(this.o.db, ALERT_KEY, new Date(this.now()).toISOString())
    const p = Math.floor(s.percent)
    this.o.audit({ percent: s.percent, freeBytes: s.freeBytes, totalBytes: s.totalBytes })
    this.o.notify({ ko: ALERT.ko(p), en: ALERT.en(p), id: ALERT.id(p), ja: ALERT.ja(p), es: ALERT.es(p) })
    return true
  }

  /** GET /api/admin/storage */
  status(): StorageStatus {
    const state = storageState()
    const s = cappedSnapshot() ?? { totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0 }
    const disk = planDiskBytes()
    return {
      totalBytes: s.totalBytes, usedBytes: s.usedBytes, freeBytes: s.freeBytes, percent: s.percent,
      // where the disk check uses the absolute floor, under it the card says what the check says (QA TC-209)
      level: s.totalBytes > 0 && this.o.absoluteRule?.() && s.freeBytes < absoluteFloor(s.totalBytes) ? 'full' : levelOf(s.percent),
      reserveBytes: reserveBytes(s.totalBytes),
      writesRefused: state.writesRefused, graceEndsAt: state.graceEndsAt,
      breakdown: this.breakdown, measuredAt: this.measuredAt,
      planDiskGiB: disk === null ? null : disk / 1024 ** 3,
    }
  }
}
