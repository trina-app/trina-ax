// One update run, shared by the owner's "update now" (routes/system.ts) and a Linux self-host's automatic update
// (system/ops.ts autoUpdateTick): wait for running answers (up to 30 minutes, none when the owner chose "Update now
// anyway"; what still runs then is interrupted and says so, with Try again; system/update-wait.ts),
// back up the DB, bring the version in, switch app/current and restart. The bootstrap health-checks the new version
// and rolls back to the previous one when it does not come up (native/cmd/mycel-bootstrap). Component G.
import type { Database } from 'bun:sqlite'
import { TeamSettings, type Locale } from '@mycel/shared/api'
import type { UpdateHistoryEntry } from '@mycel/shared/install'
import type { BackupManager } from './backup'
import { enPlural, stepText, tr } from './messages'
import { zonedDay, zonedParts, zonedToUtc } from './time-zone'
import { beginUpdateWait, endUpdateWait, updateWaitEndsBy, updateWaitOver, updateWaitSkipped } from './update-wait'
import { UpdateError, compareVersions, inRollout, releaseNeedsRoot, type ReleaseFeed, type UpdateManager } from './update'
import type { z } from 'zod'

/** the longest an update waits for running work before it restarts the server (mycel-ctl's --max-wait default too) */
export const UPDATE_WAIT_MS = 30 * 60_000
/** a version the bootstrap rolled back (or an automatic try of it) is not tried again automatically for this long */
export const AUTO_HOLD_MS = 7 * 86_400_000
/** the team's update window when Admin > Settings has none (team time zone) */
export const DEFAULT_UPDATE_WINDOW = '03:00-05:00'

export const waitingTasks = (n: number) => ({ ko: `업데이트가 진행 중인 작업 ${n}개가 끝나기를 기다리고 있어요`, en: `An update is waiting for ${enPlural(n, 'running task', 'running tasks')} to finish`, id: `Pembaruan menunggu ${n} tugas yang sedang berjalan selesai`, ja: `更新は実行中のタスク${n}件の完了を待っています`, es: `Una actualización espera a que ${n === 1 ? 'termine 1 tarea en curso' : `terminen ${n} tareas en curso`}`, zh: `更新正在等待${n}个运行中的任务完成` })
const restarting = { ko: '서버를 다시 시작해요.', en: 'Restarting the server.', id: 'Memulai ulang server.', ja: "サーバーを再起動中です。", es: "Reiniciando el servidor.", zh: "正在重启服务器。" }

export interface RunUpdateDeps {
  updates: UpdateManager
  backups: BackupManager
  /** running answers now */
  running: () => number
  restart: (why: string) => void
  locale: Locale
  progress?: (fraction: number | null, message: string | null) => void
  sleep?: (ms: number) => Promise<void>
  waitMs?: number
  /** the owner chose "Update now anyway": no wait (what runs is stopped and says so) */
  force?: boolean
}

export async function runUpdate(d: RunUpdateDeps, target: string, o: { staged: boolean; rollback: boolean }): Promise<{ fromVersion: string; toVersion: string; rolledBack: boolean }> {
  // from here until the restart (or a failure) no scheduled run or long foreground command starts
  // (system/update-wait.ts): the backup and the download after the wait take time too
  const deadline = Date.now() + (d.force ? 0 : d.waitMs ?? UPDATE_WAIT_MS)
  beginUpdateWait(new Date(), new Date(deadline))
  // a run that switched keeps the mark until the restart it asked for (a few seconds; at most 10 minutes if that
  // restart never came); a failed one clears it
  try {
    const r = await updateSteps(d, target, o, deadline)
    updateWaitEndsBy(new Date(Date.now() + 10 * 60_000))
    return r
  } catch (e) { endUpdateWait(); throw e }
}

async function updateSteps(d: RunUpdateDeps, target: string, o: { staged: boolean; rollback: boolean }, deadline: number) {
  const progress = d.progress ?? (() => {})
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms))
  // 1) let running work finish (up to the deadline, or until the owner picks "Update now anyway")
  for (let n = d.running(); n > 0 && Date.now() < deadline && !updateWaitSkipped(); n = d.running()) {
    progress(null, tr(d.locale, waitingTasks(n)))
    await sleep(2000)
  }
  updateWaitOver()
  // 2) DB backup (an update never rolls the DB back by itself)
  progress(0.2, stepText(d.locale, 'backup'))
  await d.backups.run({ kind: 'pre-update', scope: 'db' })
  // 3) bring the version in
  if (!o.staged) {
    progress(0.3, stepText(d.locale, 'download'))
    const feed = await d.updates.checkFeed()
    if (!feed || feed.version !== target) throw new UpdateError(`version ${target} is not available`)
    if (feed.rollout?.hold) throw new UpdateError(`the publisher paused version ${target}; it is not installed until the roll-out resumes`)
    if (d.updates.needsRoot(feed)) throw new UpdateError(`version ${target} also changes root-owned parts: run \`sudo mycel-ctl update\``)
    await d.updates.download(feed, (f) => progress(0.3 + 0.5 * f, stepText(d.locale, 'download')))
  }
  // 4) switch and restart; the bootstrap health-checks and rolls back on failure
  progress(0.9, stepText(d.locale, 'switch'))
  const r = await d.updates.switchTo(target)
  progress(1, tr(d.locale, restarting))
  d.restart(`update to ${target}`)
  return { fromVersion: r.from, toVersion: r.to, rolledBack: o.rollback }
}

// ---------------- automatic updates (Linux self-host, update.auto) ----------------
type History = z.infer<typeof UpdateHistoryEntry>[]

/** What the root update timer keeps (admin.js update-window, native/cmd/mycel-ctl/schedule.go): the team's window (the
 * default when empty; an invalid stored one is "00:00-00:00", which never opens) and its zone, and the install id its
 * staged roll-out uses (system/rollout.ts; left out when the install has none yet: the timer then takes the last wave). */
export function updateWindowAnswer(s: { updateWindow: string | null }, timeZone: string, installId?: string | null): { window: string; timeZone: string; custom: boolean; installId?: string } {
  return { window: s.updateWindow ?? DEFAULT_UPDATE_WINDOW, timeZone, custom: s.updateWindow !== null, ...(installId ? { installId } : {}) }
}

/** "HH:mm-HH:mm" in the team's zone; a window may pass midnight ("23:00-01:00"). */
export function inWindow(window: string | null, now: Date, tz: string): boolean {
  if (!TeamSettings.shape.updateWindow.safeParse(window).success) return false
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window ?? DEFAULT_UPDATE_WINDOW)
  if (!m) return false
  const from = +m[1]! * 60 + +m[2]!, to = +m[3]! * 60 + +m[4]!
  const p = zonedParts(now, tz)
  const at = p.h * 60 + p.min
  return from <= to ? at >= from && at < to : at >= from || at < to
}

/** When the window next opens, for Admin Home ("tonight 03:00-05:00"): now when inside it, else the next start. `day` is
 * the start's calendar day in the team's zone against today's. null: the window never opens (invalid, or equal ends). */
export function nextWindow(window: string | null, now: Date, tz: string): { at: Date; day: 'now' | 'today' | 'tomorrow' } | null {
  if (!TeamSettings.shape.updateWindow.safeParse(window).success) return null
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window ?? DEFAULT_UPDATE_WINDOW)
  if (!m || (+m[1]! === +m[3]! && +m[2]! === +m[4]!)) return null
  if (inWindow(window, now, tz)) return { at: now, day: 'now' }
  const p = zonedParts(now, tz)
  const today = zonedDay(now, tz)
  for (let k = 0; k <= 2; k++) {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + k))
    const at = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), +m[1]!, +m[2]!, tz)
    if (at.getTime() > now.getTime()) return { at, day: zonedDay(at, tz) === today ? 'today' : 'tomorrow' }
  }
  return null
}

export type AutoDecision = { go: true; version: string } | { go: false; why: 'no_feed' | 'up_to_date' | 'paused' | 'needs_root' | 'rollout' | 'held' | 'outside_window' | 'busy' }

/** Should this install take the feed's release by itself now? (pure: the ops service gathers the facts) */
export function autoUpdateDecision(o: {
  feed: ReleaseFeed | null; current: string; installId: string; now: Date; tz: string; window: string | null; running: number
  history: History; lastAttempt?: { version: string; at: string } | null
  /** the install's update channel (server.json update.channel): the beta channel skips the roll-out's ramp. Required:
   * a caller that left it out would hold beta servers to the stable ramp */
  channel: 'stable' | 'beta'
  /** root/VERSION of this install (releaseNeedsRoot); null = unknown */
  rootVersion?: string | null
  /** the version root's update failed here (root/update-failed.json, native/cmd/mycel-ctl schedule.go), held or not:
   * the root update timer tries it again after its own back-off, so this updater leaves it (0.2.19 review S1) */
  rootHold?: string | null
  /** decide as if the window were open and no answer ran (Admin Home asks what holds a release back, not when) */
  ignoreWindow?: boolean
}): AutoDecision {
  const f = o.feed
  if (!f) return { go: false, why: 'no_feed' }
  if (compareVersions(f.version, o.current) <= 0) return { go: false, why: 'up_to_date' }
  // the publisher paused this release's roll-out (system/rollout.ts hold): nobody takes it by itself until it resumes
  if (f.rollout?.hold) return { go: false, why: 'paused' }
  if (releaseNeedsRoot(f, o.rootVersion ?? null)) return { go: false, why: 'needs_root' }
  // the staged roll-out (system/rollout.ts): this install's turn may come a day or two after the release
  if (!inRollout(f, o.installId, { now: o.now, channel: o.channel })) return { go: false, why: 'rollout' }
  if (o.rootHold && o.rootHold === f.version) return { go: false, why: 'held' }
  const recent = (at: string) => o.now.getTime() - Date.parse(at) < AUTO_HOLD_MS
  // the bootstrap records a roll-back as from <failed> to <previous> (native/cmd/mycel-bootstrap), a refused version as
  // to <it>
  const failed = (h: History[number]) => h.result !== 'ok' && (h.to === f.version || (h.result === 'rolled_back' && h.from === f.version))
  if (o.history.some((h) => failed(h) && recent(h.at))) return { go: false, why: 'held' }
  if (o.lastAttempt && o.lastAttempt.version === f.version && recent(o.lastAttempt.at)) return { go: false, why: 'held' }
  if (o.ignoreWindow) return { go: true, version: f.version }
  if (!inWindow(o.window, o.now, o.tz)) return { go: false, why: 'outside_window' }
  if (o.running > 0) return { go: false, why: 'busy' }
  return { go: true, version: f.version }
}

// ---------------- an update job whose version did not stay (QA TC-336) ----------------
type Msg = Record<Locale, string>
const UPDATE_NOT_KEPT = {
  goBack: (to: string, cur: string): Msg => ({ ko: `${to}(으)로 되돌리지 못했어요. 지금도 ${cur}(으)로 실행 중이에요.`, en: `Could not go back to ${to}; still on ${cur}.`, id: `Tidak bisa kembali ke ${to}; masih memakai ${cur}.`, ja: `${to}に戻せませんでした。現在も${cur}で動いています。`, es: `No se pudo volver a ${to}; sigue en ${cur}.`, zh: `无法回退到${to}；仍在${cur}。` }),
  update: (to: string, cur: string): Msg => ({ ko: `${to}(으)로 업데이트하지 못했어요. 지금도 ${cur}(으)로 실행 중이에요.`, en: `Could not update to ${to}; still on ${cur}.`, id: `Tidak bisa memperbarui ke ${to}; masih memakai ${cur}.`, ja: `${to}に更新できませんでした。現在も${cur}で動いています。`, es: `No se pudo actualizar a ${to}; sigue en ${cur}.`, zh: `无法更新到${to}；仍在${cur}。` }),
  cannotRead: (to: string, cur: string): Msg => ({ ko: `${to}은(는) ${cur}이(가) 이미 바꾼 데이터베이스를 읽지 못해요. 잃은 데이터는 없어요. ${to}(으)로 돌아가려면 업데이트 전에 만든 백업을 복원해야 해요(백업·복원 안내 참고).`, en: `${to} cannot read the database that ${cur} has already updated. Nothing was lost. To return to ${to}, the backup made before the update has to be restored (see the backup and restore guide).`, id: `${to} tidak dapat membaca basis data yang sudah diperbarui ${cur}. Tidak ada yang hilang. Untuk kembali ke ${to}, cadangan yang dibuat sebelum pembaruan harus dipulihkan (lihat panduan cadangan dan pemulihan).`, ja: `${to}は、${cur}がすでに更新したデータベースを読み込めません。失われたデータはありません。${to}に戻すには、更新前に作成したバックアップを復元する必要があります（バックアップと復元のガイドを参照）。`, es: `${to} no puede leer la base de datos que ${cur} ya actualizó. No se perdió nada. Para volver a ${to}, hay que restaurar la copia de seguridad hecha antes de la actualización (consulte la guía de copia y restauración).`, zh: `${to}无法读取已被${cur}更新过的数据库。没有丢失任何数据。要回到${to}，需要恢复更新前创建的备份（见备份与恢复指南）。` }),
  why: (detail: string): Msg => ({ ko: `이유: ${detail}`, en: `Reason: ${detail}`, id: `Alasan: ${detail}`, ja: `理由：${detail}`, es: `Motivo: ${detail}`, zh: `原因：${detail}` }),
}

/**
 * An update job is "done" once it has switched app/current and asked for the restart: the bootstrap tries the version
 * after that, and may send app/current back (a version that does not come up, or one that cannot read the database:
 * exit 75). At the next start, the newest update job, finished within a day, that started from the version running
 * again and named another one, which the bootstrap recorded sending back (history rolled_back <it> -> <running>), did
 * not stay: it becomes `failed` with what happened ("Could not go back to 0.4.0; still
 * on 0.5.0" and why), so a client that reads the job after the restart is told the truth. QA TC-336: a Go back to 0.4.0
 * bounced and the job said rolledBack to 0.4.0. Returns the job id it changed (null: none).
 */
export function settleUpdateJob(o: {
  db: Database; running: string; history: History; now: Date
  /** can this staged version open the database as it is now (UpdateManager.canRead) */
  canRead: (version: string) => boolean
  locale: (userId: string | null) => Locale
}): string | null {
  type Row = { id: string; user_id: string | null; status: string; result: string | null; finished_at: string | null }
  let row: Row | null
  try {
    row = o.db.query("SELECT id, user_id, status, result, finished_at FROM jobs WHERE kind = 'update' ORDER BY created_at DESC, id DESC LIMIT 1").get() as Row | null
  } catch { return null }
  if (!row || row.status !== 'done' || !row.result || !row.finished_at || o.now.getTime() - Date.parse(row.finished_at) > 86_400_000) return null
  let r: { fromVersion?: unknown; toVersion?: unknown; rolledBack?: unknown }
  try { r = JSON.parse(row.result) } catch { return null }
  if (typeof r.toVersion !== 'string' || typeof r.fromVersion !== 'string' || r.toVersion === o.running || r.fromVersion !== o.running) return null
  const to = r.toVersion, finished = row.finished_at
  const l = o.locale(row.user_id)
  // only when the bootstrap recorded sending it back: rolled_back <to> -> <running>, after the job finished (a server
  // that only restarted, or an administrator's switch back, is not a version that did not stay)
  const h = [...o.history].reverse().find((x) => x.result === 'rolled_back' && x.from === to && x.to === o.running && Date.parse(x.at) >= Date.parse(finished) - 60_000)
  if (!h) return null
  const head = (r.rolledBack === true ? UPDATE_NOT_KEPT.goBack : UPDATE_NOT_KEPT.update)(to, o.running)[l]
  // why: the reader levels say it best; else the bootstrap's own line
  const reason = !o.canRead(to) ? UPDATE_NOT_KEPT.cannotRead(to, o.running)[l] : h.detail ? UPDATE_NOT_KEPT.why(h.detail)[l] : ''
  const err = { code: 'conflict', message: reason ? `${head} ${reason}` : head }
  o.db.query("UPDATE jobs SET status = 'failed', error = ? WHERE id = ? AND status = 'done'").run(JSON.stringify(err), row.id)
  return row.id
}
