// Quiet desktop updates, the parts without Electron (docs/decisions/20261116-quiet-desktop-updates.md; unit-tested in
// tests/unit/desktop-update-guard.test.ts). A verified update installs when the app quits, or by itself when the
// computer is idle and nothing on screen could be lost. There is no "Restart" question any more.
//
// macOS: Squirrel.Mac's ShipIt installs only after every copy of the app has quit, and it gives up for good ("App Still
// Running Error", the update is dropped) when the app is opened again during the 10–70 s it takes. Reproduced on
// 2026-11-16 with the released 0.5.7 → 0.5.9: Restart, then a Dock click 0.3 s later, left 0.5.7. So an app that
// starts while ShipIt is still installing it steps aside at once (launchDecision 'wait') and a small shell waiter
// opens the app again when ShipIt is done: the click still ends in the new version.
import { compareVersions } from './update'

/** user data: the update Squirrel has staged (or the Windows installer that is ready), read at the next start */
export const PENDING_FILE = 'update-pending.json'
/** user data: the team page that was open when the app restarted by itself to update */
export const RESUME_FILE = 'update-resume.json'
/** the team page's function that says whether a reload now would lose something (web/src/lib/reload-guard.ts) */
export const PAGE_BUSY_GLOBAL = '__mycelBusy'

/** the screen the app restarted from is opened again only this soon after */
export const RESUME_WITHIN_MS = 15 * 60_000
/** how long the computer must be untouched before the app restarts by itself to update */
export const IDLE_RESTART_AFTER_S = 20 * 60
/** the "couldn't update" line only after this many starts on the old version: one failed install is retried quietly */
export const FAILED_STARTS_BEFORE_NOTICE = 2

export interface Pending {
  version: string
  /** when the update was staged */
  at: number
  /** starts on the old version since it was staged */
  failedStarts: number
  /** when a start stepped aside for ShipIt (once per staged version: a ShipIt that never ends cannot keep delaying starts) */
  waitedAt: number | null
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,40})?$/

export function parsePending(json: string | null): Pending | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as Partial<Pending>
    if (typeof p.version !== 'string' || !VERSION_RE.test(p.version) || typeof p.at !== 'number') return null
    return { version: p.version, at: p.at, failedStarts: typeof p.failedStarts === 'number' && p.failedStarts >= 0 ? Math.floor(p.failedStarts) : 0, waitedAt: typeof p.waitedAt === 'number' ? p.waitedAt : null }
  } catch {
    return null
  }
}

/** the pending record for a newly staged `version` (the failed-start count is kept when it is the same version again) */
export function stagedPending(prev: Pending | null, version: string, now: number): Pending {
  return { version, at: now, failedStarts: prev?.version === version ? prev.failedStarts : 0, waitedAt: null }
}

export type LaunchDecision =
  /** nothing was waiting */
  | { kind: 'none' }
  /** the update is in: forget the record */
  | { kind: 'updated' }
  /** ShipIt is installing this app right now: quit at once, a waiter opens the app again */
  | { kind: 'wait'; pending: Pending }
  /** still the old version and nothing installing: keep the record, try again quietly, or say so (`notice`) */
  | { kind: 'failed'; pending: Pending; notice: boolean }

/** What a starting app does about an update staged by an earlier run. Only the first copy of the app asks (a second
 * copy hands over to the running one and quits anyway). `installing`: ShipIt's launchd job has a process (macOS).
 * A start steps aside at most once per staged version. */
export function launchDecision(o: { pending: Pending | null; current: string; installing: boolean; now: number }): LaunchDecision {
  const p = o.pending
  if (!p) return { kind: 'none' }
  if (compareVersions(o.current, p.version) >= 0) return { kind: 'updated' }
  if (o.installing && p.waitedAt === null && p.failedStarts === 0) return { kind: 'wait', pending: { ...p, waitedAt: o.now } }
  const failedStarts = p.failedStarts + 1
  return { kind: 'failed', pending: { ...p, failedStarts }, notice: failedStarts >= FAILED_STARTS_BEFORE_NOTICE }
}

/** ShipIt's launchd label for a bundle id (Squirrel.Mac: `<bundle id>.ShipIt`) */
export const shipItLabel = (bundleId: string) => `${bundleId}.ShipIt`

/** the PID in `launchctl list <label>` output, or null (job not loaded, or loaded without a process) */
export function launchctlPid(out: string): number | null {
  const m = /"PID"\s*=\s*(\d+);/.exec(out)
  return m ? Number(m[1]) : null
}

/** The macOS waiter that a start which stepped aside leaves behind (/bin/sh -c, $0 = label, $1 = app bundle): wait while
 * ShipIt runs (at most 180 s; it took 9–66 s on a test Mac), then open the app. When ShipIt relaunched it already, `open` only
 * brings it forward. */
export const MAC_WAITER =
  'i=0; while [ $i -lt 180 ] && /bin/launchctl list "$0" 2>/dev/null | /usr/bin/grep -q \'"PID" =\'; do sleep 1; i=$((i+1)); done; sleep 1; /usr/bin/open "$1"'

/** the .app bundle of a macOS executable (…/X.app/Contents/MacOS/X), or null */
export function bundleOf(execPath: string): string | null {
  const m = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return m ? m[1]! : null
}

/** CFBundleIdentifier of an XML Info.plist (what electron-builder writes), or null */
export function bundleIdOf(plist: string | null): string | null {
  const m = plist ? /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9.-]{1,200})<\/string>/.exec(plist) : null
  return m ? m[1]! : null
}

/** how the window was before an update restart: it comes back the same way and never takes the focus */
export type ResumeWindow = 'shown' | 'minimized' | 'none'

export interface Resume {
  /** the team page that was open and its path; null: no team page open (the window closed, or the team list) */
  page: { teamId: string; path: string } | null
  window: ResumeWindow
  at: number
}

const safePath = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') && p.length <= 2000

/** the team page to open again after an update restart: the path of its address (same origin only) */
export function resumePage(teamId: string, pageUrl: string, origins: string[]): Resume['page'] {
  let u: URL
  try { u = new URL(pageUrl) } catch { return null }
  if (!origins.includes(u.origin)) return null
  // the one-time sign-in pages are never opened again (the code is spent; the page takes it out of the address at once):
  // "Continue in the Mac app", a new team's owner setup page and Sign in with Google's return
  if (/^\/app-(?:signin|setup)\/?$/i.test(u.pathname) || /^\/login\/google\/?$/i.test(u.pathname)) return null
  const path = u.pathname + u.search + u.hash
  return safePath(path) ? { teamId, path } : null
}

export function parseResume(json: string | null, now: number): Resume | null {
  if (!json) return null
  try {
    const r = JSON.parse(json) as Partial<Resume>
    if (typeof r.at !== 'number' || now - r.at < 0 || now - r.at > RESUME_WITHIN_MS) return null
    const window: ResumeWindow = r.window === 'minimized' || r.window === 'none' ? r.window : 'shown'
    const p = r.page
    const page = p && typeof p === 'object' && typeof p.teamId === 'string' && safePath(p.path) ? { teamId: p.teamId, path: p.path } : null
    return { page, window, at: r.at }
  } catch {
    return null
  }
}

/** The app may restart by itself to install a ready update only when nobody uses the app and nothing would be lost:
 * no window of it focused, the computer untouched for IDLE_RESTART_AFTER_S (or the screen locked), the team page says
 * a reload would lose nothing (web/src/lib/reload-guard.ts mayReloadNow: uploads, drafts, unsaved edits, a recording,
 * an answer streaming, a message not sent, the server unreachable; `pageBusy` null = it could not tell, so no) and
 * the in-app browser shows no page. */
export function idleRestartAllowed(o: { ready: boolean; focused: boolean; idleSeconds: number; locked: boolean; pageBusy: boolean | null; browserTabs: number }): boolean {
  if (!o.ready || o.focused) return false
  if (!o.locked && o.idleSeconds < IDLE_RESTART_AFTER_S) return false
  return o.pageBusy === false && o.browserTabs === 0
}

/** Squirrel.Mac's refusal for an app that runs from a read-only place: the dmg, or a translocated download */
export const readOnlyRefusal = (message: string) => /read-only volume|move the application/i.test(message)
