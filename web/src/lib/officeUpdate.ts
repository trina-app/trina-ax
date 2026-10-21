// Office mode automatic updates in the web app (docs/OFFICE.md "자동 업데이트"): when the owner's or an admin's view
// shows the "new version" banner, and when the update card's run has finished. Pure (web/test/unit/officeUpdate.test.ts).
import type { Me, OfficeUpdateStatus } from '@mycel/shared/api'

const KEY = 'teamax.officeUpdate.dismissed'

/** The banner for owners and admins: a newer version on the feed, not being installed, not dismissed for that
 * version. `nightly` is the time it installs by itself (null while automatic updates are off). Members never see it. */
export function bannerFor(me: Me | null, s: OfficeUpdateStatus | null | undefined, dismissed: string | null): { version: string; nightly: string | null } | null {
  const role = me?.user.role
  if (role !== 'owner' && role !== 'admin') return null
  if (!s?.available || s.running || s.requested) return null
  if (dismissed === s.available.version) return null
  return { version: s.available.version, nightly: s.paused || !s.agentInstalled ? null : s.time }
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
