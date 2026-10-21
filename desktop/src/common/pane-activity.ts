// What the in-app browser tells the person about, and how loudly (owner feedback 2026-10-21: two yellow banners
// stacked over LinkedIn for routine events). Routine events (the AI ran a script, read a network body, a page's
// request was held back) only go to the activity log the person can open from the pane toolbar; the "AI is using
// the browser" bar shows the newest one. Only what the person has to know right now interrupts, as ONE line over
// the page that a newer one replaces (never stacked): a page load stopped because it led to an office-network or
// this-computer address, and a refused password field. Site questions are separate (prompt cards).
// Pure: unit-tested in tests/unit/e-pane-activity.test.ts; used by main/pane and ui/pane.ts.

export type ActivityKind =
  /** the AI ran javascript_tool in a page (shown every time, design tab 5) */
  | 'script'
  /** the AI read a network response body */
  | 'network'
  /** a request to an office-network address was refused */
  | 'blocked'
  /** a page the AI ran script in tried to reach a site the person has not allowed: held back (net-policy.ts) */
  | 'offsite'
  /** the person (or no answer in time) declined a site: not opened */
  | 'denied'
  /** the team's own address or this computer: never opened */
  | 'forbidden'
  /** the AI tried to type or click into a password field */
  | 'password'
  /** the AI tried to type or click into a payment-card field (card number, expiry, security code) */
  | 'payment'

export interface PaneActivity {
  id: number
  kind: ActivityKind
  host: string
  at: number
  /** shown as the one line over the page (else only in the log) */
  notice: boolean
  /** the same event repeated right after itself this many times in all (log rows are grouped: "×7") */
  count?: number
}

/** The AI's own routine actions: logged, but they do not raise the unseen count. */
export function isRoutine(kind: ActivityKind): boolean {
  return kind === 'script' || kind === 'network'
}

/** Is this event worth interrupting the person? `topLevel`: it stopped a whole page load (main frame / the tab). */
export function isNotice(kind: ActivityKind, topLevel: boolean): boolean {
  if (kind === 'password' || kind === 'payment') return true
  if (kind === 'blocked' || kind === 'forbidden') return topLevel
  return false
}

/** entries kept in the log */
export const MAX_ACTIVITY_LOG = 100

export interface ActivityView {
  /** newest first */
  log: PaneActivity[]
  /** the one line over the page, or null */
  notice: PaneActivity | null
  /** entries added while the log was closed */
  unseen: number
}

export const emptyActivity = (): ActivityView => ({ log: [], notice: null, unseen: 0 })

/**
 * Add an event: into the log (the same event right after itself becomes "×N" on that row); a notice replaces the
 * current one (one at most). Only events the person may want to look at raise the unseen count (not the AI's own
 * routine script runs and network reads, which the "AI is using the browser" bar shows while it happens).
 */
export function addActivity(v: ActivityView, a: PaneActivity, logOpen: boolean): ActivityView {
  const top = v.log[0]
  const repeat = top && !a.notice && !top.notice && top.kind === a.kind && top.host === a.host
  const log = repeat ? [{ ...a, count: (top.count ?? 1) + 1 }, ...v.log.slice(1)] : [a, ...v.log].slice(0, MAX_ACTIVITY_LOG)
  return {
    log,
    notice: a.notice ? a : v.notice,
    unseen: logOpen || isRoutine(a.kind) ? (logOpen ? 0 : v.unseen) : Math.min(v.unseen + 1, 999),
  }
}

/**
 * What the "AI is using the browser" bar shows: the AI's own latest action (a script run, a network read) since this
 * AI call started, never a refusal or an entry from another site or an earlier call (UX review: a stale "held back a
 * request … static.licdn.com" line showed on naver.com).
 */
export function drivingLine(v: ActivityView, since: number): PaneActivity | null {
  const a = v.log.find((e) => isRoutine(e.kind))
  return a && a.at >= since ? a : null
}

/** The person closed the notice, or it timed out (only that notice: a newer one stays). */
export function dismissNotice(v: ActivityView, id?: number): ActivityView {
  if (!v.notice || (id !== undefined && v.notice.id !== id)) return v
  return { ...v, notice: null }
}

/** The person opened the log. */
export function markSeen(v: ActivityView): ActivityView {
  return v.unseen ? { ...v, unseen: 0 } : v
}
