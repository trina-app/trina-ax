// Office mode automatic updates in the web app (docs/OFFICE.md "자동 업데이트"): when the owner's or an admin's view
// shows the "new version" banner, and when the update card's run has finished. Pure (web/test/unit/officeUpdate.test.ts).
import type { Me, OfficeUpdateStatus } from '@mycel/shared/api'
import { browserTimeZone } from './time-zones'

const KEY = 'teamax.officeUpdate.dismissed'

/** The zone of every time on the update card, named next to the time: the team's, from the status. A server too old to
 * send it (a page left open after a roll back): the team's zone from /api/me, else this browser's, else UTC. */
export const cardZone = (s: Pick<OfficeUpdateStatus, 'timeZone'>, teamZone?: string | null): string => s.timeZone || teamZone || browserTimeZone() || 'UTC'

/** What an office Mac runs while the update window in Team settings is empty, when that is not the plain default: a time
 * `teamax update time` of an older version set (server/src/office/update.ts officeSchedule). Null once the team has saved
 * a window of its own, and on any other server (no status). */
export function legacyWindow(s: OfficeUpdateStatus | null | undefined, saved: string | null | undefined): { window: string; zone: string } | null {
  if (s?.windowSource !== 'legacy' || saved || !s.window || !s.timeZone) return null
  return { window: s.window, zone: s.timeZone }
}

/** The banner for owners and admins: a newer version on the feed, not being installed, not dismissed for that
 * version. `nightly` is the team's update window and its zone, when it installs by itself, as the server gives them
 * and the update card shows them (null when nothing installs by itself: automatic updates off, no update agent, a window
 * that never opens). Members never see it. `updateReady`: the server already answers with a new version (the page
 * says "A new version is ready. Reload", store/live.ts), so this status is from before the update. */
export function bannerFor(me: Me | null, s: OfficeUpdateStatus | null | undefined, dismissed: string | null, updateReady = false): { version: string; nightly: { window: string; zone: string } | null } | null {
  const role = me?.user.role
  if (role !== 'owner' && role !== 'admin') return null
  if (updateReady) return null
  if (!s?.available || s.running || s.requested) return null
  if (dismissed === s.available.version) return null
  return { version: s.available.version, nightly: s.paused || !s.agentInstalled || !s.nextWindowAt ? null : { window: s.window ?? s.time, zone: cardZone(s, me?.server.timeZone) } }
}

export function dismissedVersion(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}
export function dismissVersion(v: string) {
  try { localStorage.setItem(KEY, v) } catch { /* private window: shown again next time */ }
}

/** A run that was going (running or requested) has ended: what it did, for a toast. */
export function finishedRun(before: OfficeUpdateStatus | null, now: OfficeUpdateStatus): 'updated' | 'rolled-back' | 'failed' | null {
  const was = !!before && (!!before.running || before.requested)
  if (!was || now.running || now.requested || !now.last) return null
  if (before?.last && before.last.at === now.last.at) return null
  return now.last.kind === 'updated' ? 'updated' : now.last.kind === 'rolled-back' ? 'rolled-back' : now.last.kind === 'failed' || now.last.kind === 'refused' ? 'failed' : null
}

const STATUS_EVENT = 'mycel:office-update-status'
/** The update card loaded a status (a pause, another time, a finished run): the banner shows the same at once. */
export function shareOfficeStatus(s: OfficeUpdateStatus) {
  try { window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: s })) } catch { /* no window (tests) */ }
}
export function onOfficeStatus(f: (s: OfficeUpdateStatus) => void): () => void {
  const h = (e: Event) => f((e as CustomEvent<OfficeUpdateStatus>).detail)
  window.addEventListener(STATUS_EVENT, h)
  return () => window.removeEventListener(STATUS_EVENT, h)
}
