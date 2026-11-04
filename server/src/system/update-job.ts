// One update run, shared by the owner's "update now" (routes/system.ts) and a Linux self-host's automatic update
// (system/ops.ts autoUpdateTick): wait for running answers (up to 10 minutes; what still runs then is interrupted),
// back up the DB, bring the version in, switch app/current and restart. The bootstrap health-checks the new version
// and rolls back to the previous one when it does not come up (native/cmd/mycel-bootstrap). Component G.
import { TeamSettings, type Locale } from '@mycel/shared/api'
import type { UpdateHistoryEntry } from '@mycel/shared/install'
import type { BackupManager } from './backup'
import { enPlural, stepText, tr } from './messages'
import { zonedDay, zonedParts, zonedToUtc } from './time-zone'
import { UpdateError, compareVersions, inRollout, releaseNeedsRoot, type ReleaseFeed, type UpdateManager } from './update'
import type { z } from 'zod'

export const UPDATE_WAIT_MS = 10 * 60_000
/** a version the bootstrap rolled back (or an automatic try of it) is not tried again automatically for this long */
export const AUTO_HOLD_MS = 7 * 86_400_000
/** the team's update window when Admin > Settings has none (team time zone) */
export const DEFAULT_UPDATE_WINDOW = '03:00-05:00'

const waitingTurns = (n: number) => ({ ko: `진행 중인 답변 ${n}개가 끝나기를 기다리는 중`, en: `Waiting for ${enPlural(n, 'running answer', 'running answers')} to finish`, id: `Menunggu ${n} jawaban selesai`, ja: `${String(n) + "件の実行中の回答"}の完了を待機中`, es: `Esperando a que termine ${enPlural(n, "respuesta en curso", "respuestas en curso")}` })
const restarting = { ko: '서버를 다시 시작해요.', en: 'Restarting the server.', id: 'Memulai ulang server.', ja: "サーバーを再起動中です。", es: "Reiniciando el servidor." }

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
}

export async function runUpdate(d: RunUpdateDeps, target: string, o: { staged: boolean; rollback: boolean }): Promise<{ fromVersion: string; toVersion: string; rolledBack: boolean }> {
  const progress = d.progress ?? (() => {})
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms))
  // 1) let running answers finish
  const deadline = Date.now() + (d.waitMs ?? UPDATE_WAIT_MS)
  for (let n = d.running(); n > 0 && Date.now() < deadline; n = d.running()) {
    progress(null, tr(d.locale, waitingTurns(n)))
    await sleep(2000)
  }
  // 2) DB backup (an update never rolls the DB back by itself)
  progress(0.2, stepText(d.locale, 'backup'))
  await d.backups.run({ kind: 'pre-update', scope: 'db' })
  // 3) bring the version in
  if (!o.staged) {
    progress(0.3, stepText(d.locale, 'download'))
    const feed = await d.updates.checkFeed()
    if (!feed || feed.version !== target) throw new UpdateError(`version ${target} is not available`)
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
 * default when empty; an invalid stored one is "00:00-00:00", which never opens) and its zone. */
export function updateWindowAnswer(s: { updateWindow: string | null }, timeZone: string): { window: string; timeZone: string; custom: boolean } {
  return { window: s.updateWindow ?? DEFAULT_UPDATE_WINDOW, timeZone, custom: s.updateWindow !== null }
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

export type AutoDecision = { go: true; version: string } | { go: false; why: 'no_feed' | 'up_to_date' | 'needs_root' | 'rollout' | 'held' | 'outside_window' | 'busy' }

/** Should this install take the feed's release by itself now? (pure: the ops service gathers the facts) */
export function autoUpdateDecision(o: {
  feed: ReleaseFeed | null; current: string; installId: string; now: Date; tz: string; window: string | null; running: number
  history: History; lastAttempt?: { version: string; at: string } | null
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
  if (releaseNeedsRoot(f, o.rootVersion ?? null)) return { go: false, why: 'needs_root' }
  if (!inRollout(f, o.installId)) return { go: false, why: 'rollout' }
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
