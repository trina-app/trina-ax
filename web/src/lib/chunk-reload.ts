// A page part that cannot be loaded after a server update (tab 5 "버전 불일치"). An open tab keeps running the build it
// started with; after the server updates, that build's lazy chunks (routes, side panels, viewers, libraries) are gone
// (404: the server serves only the current build, and the service worker keeps only the current build's files), so the
// next click that needs one fails to import. The tab already reloads by itself once the server reports its new version
// and nothing is busy (components/Layout.tsx UpdateWatcher); this covers the seconds before that. A lazy route, side
// panel or admin section that cannot be imported used to leave a blank page (no error boundary); now
// components/ChunkErrorBoundary catches it and reloads the page once, at once, with a spinner meanwhile, or shows a Reload
// button where no reload happens. Libraries a component imports by itself (highlighting, diagrams, Office viewers)
// already show their content without them on a failure, so they do not reload the page: on a weak connection that would
// only trade a plain code block for the offline page.
// No loop: at most one automatic reload per CHUNK_RELOAD_GUARD_MS in a tab (sessionStorage); a failure soon after one
// (the new build cannot load either: offline, a broken server) stays on screen with the button. Not while something would
// be lost (an upload, a draft, a recording, a message still being sent or not sent, an answer streaming) or the server
// cannot be reached (lib/reload-guard.ts, the same check as the UpdateWatcher), and not without sessionStorage (nothing
// would stop a loop). Where it does not reload because something would be lost, the line says so.
import { mayReloadNow } from './reload-guard'

export const CHUNK_RELOAD_KEY = 'mycel.chunkReloadAt'
export const CHUNK_RELOAD_GUARD_MS = 5 * 60_000

// Chrome / Edge, Firefox, Safari (dynamic import), Vite's CSS preload, webpack-style names
const CHUNK_RE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk [\w-]+ failed/i

/** a failed dynamic import (the error Vite's helper or React.lazy hands on) */
export function isChunkLoadError(e: unknown): boolean {
  if (!e) return false
  if (typeof e === 'string') return CHUNK_RE.test(e)
  const err = e as { name?: unknown; message?: unknown }
  if (err.name === 'ChunkLoadError') return true
  return typeof err.message === 'string' && CHUNK_RE.test(err.message)
}

export interface ReloadOnceDeps {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  now: number
  /** a reload now would lose something, or the server cannot be reached (lib/reload-guard.ts mayReloadNow) */
  busy: boolean
  reload: () => void
}

/** Reload unless one was done less than CHUNK_RELOAD_GUARD_MS ago in this tab, something is busy, or there is no storage
 * to remember it in. true = reloading. A busy page does not use up the one reload. */
export function reloadOnce(d: ReloadOnceDeps): boolean {
  if (d.busy || !guardAllows(d.storage, d.now)) return false
  try { d.storage!.setItem(CHUNK_RELOAD_KEY, String(d.now)) } catch { return false }
  d.reload()
  return true
}

/** The guard alone: there is storage to remember a reload in, and none was made in the last CHUNK_RELOAD_GUARD_MS. */
function guardAllows(storage: ReloadOnceDeps['storage'], now: number): boolean {
  if (!storage) return false
  let last: number
  try { last = Number(storage.getItem(CHUNK_RELOAD_KEY) ?? NaN) } catch { return false }
  return !(Number.isFinite(last) && now >= last && now - last < CHUNK_RELOAD_GUARD_MS)
}

/** Whether the guard would let this tab reload for a failed chunk now (nothing else asked): the boundary says the part
 * loads by itself once the connection is back only then. */
export function chunkReloadAllowed(now = Date.now()): boolean {
  let storage: Storage | null = null
  try { storage = window.sessionStorage } catch {}
  return guardAllows(storage, now)
}

let reloading = false
/** a reload for a failed chunk is under way */
export const chunkReloading = () => reloading
/** tests only */
export function _resetChunkReloadForTest() { reloading = false }

/** Reload for `e` when it is a failed chunk (reloadOnce). true = reloading (also when one already is). */
export function reloadForChunkError(e: unknown): boolean {
  if (reloading) return true
  if (!isChunkLoadError(e)) return false
  let storage: Storage | null = null
  try { storage = window.sessionStorage } catch {}
  reloading = reloadOnce({ storage, now: Date.now(), busy: !mayReloadNow(), reload: () => location.reload() })
  return reloading
}
