// The operator's notices on the hosted service (GET /api/managed/notices; server/src/system/managed.ts): a banner on
// every screen. The server already picked the ones for the person's role and language and sorted them critical
// first; here only what this browser hid. info / warn may be hidden (remembered per notice id on this browser);
// critical ones stay. Pure (web/test/unit/managed-notices.test.ts).
import type { ManagedNotice } from '@mycel/shared/api'

const KEY = 'teamax.notices.dismissed'
/** hidden ids kept at most (the operator's file holds at most 10; old ids fall off) */
const MAX_KEPT = 50

export function dismissedNotices(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
export function dismissNotice(id: string, before: string[] = dismissedNotices()): string[] {
  const next = [...before.filter((x) => x !== id), id].slice(-MAX_KEPT)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private window: shown again next time */ }
  return next
}

/** What the banner shows: everything not hidden on this browser (a critical notice cannot be hidden), and not past
 * its `until` (the server checks too; this covers a page left open). */
export function visibleNotices(items: ManagedNotice[] | null | undefined, dismissed: string[], now = Date.now()): ManagedNotice[] {
  const hidden = new Set(dismissed)
  return (items ?? []).filter((n) => (!n.dismissible || !hidden.has(n.id)) && (n.until === null || Date.parse(n.until) > now))
}
