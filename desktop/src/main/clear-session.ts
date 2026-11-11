// Clearing a session's data (fix/desktop-clear-storage-hang, 2026-11-11). The in-app browser clears its partition
// when another person signs in or the person signs out (pane.ts resetForNewPerson, app-window.ts checkBrowserOwner),
// and removing a team clears both of its partitions (app-window.ts removeTeam). Every AI browser call waits for the
// first of these, so a clear that never finished stopped the in-app browser for good.
//
// Seen on a Mac (macOS 26.6, Electron 44.7.2) under heavy load: `clearStorageData()` with no list, and `clearData()`,
// never settled, in this app and in a bare Electron app alike, while each type in the list below, and the list
// together, settled in 1-2 s at the same time. The likely reason (docs/DECISIONS.md): with no list Electron asks
// Chromium for every data type (REMOVE_DATA_MASK_ALL), some of the extra subtasks run on Chromium's background-priority
// threads, and macOS runs those only when the efficiency cores are free (a process started at background priority did
// not run for minutes; one at default priority ran at once). The promise settles only when the last subtask reports
// back, and a pending one also kept the app from quitting. So: always the list, and every clear has a time limit.
// Chromium starts all subtasks at once, so a clear that runs out of time has still removed what its other subtasks
// cover; the limit only frees the caller, which logs it and goes on. (A clear that runs out of time and finishes
// later also removes what the next person stored meanwhile: harmless, they sign in again.)
import type { Session } from 'electron'
import { debug } from './debug'

/** Everything a page can store, by Electron's names (`ClearStorageDataOptions.storages`): a sign-in lives in cookies,
 * local storage, IndexedDB, cache storage or a service worker; file systems and the shader cache for completeness.
 * Session storage goes with local storage (Chromium clears it with REMOVE_DATA_MASK_LOCAL_STORAGE). */
export const STORAGE_TYPES = ['cookies', 'localstorage', 'indexdb', 'filesystem', 'serviceworkers', 'cachestorage', 'shadercache'] as const

/** Each clear took under 2 s on a Mac with a used partition; ten times that is a clear that is stuck. */
export const CLEAR_TIMEOUT_MS = 10_000

export type ClearOutcome = 'done' | 'failed' | 'timeout'

/** How `p` ended within `ms`: done, failed (rejected) or timeout (still running). Never rejects, never waits longer. */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<ClearOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<ClearOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  const settled = Promise.resolve(p).then(
    (): ClearOutcome => 'done',
    (): ClearOutcome => 'failed',
  )
  return Promise.race([settled, late]).finally(() => clearTimeout(timer))
}

export type ClearableSession = Pick<Session, 'clearStorageData' | 'clearCache' | 'clearAuthCache'>
export type ClearResult = { storage: ClearOutcome; cache: ClearOutcome; logins: ClearOutcome }

/** A clear that failed (rejected or threw: the session is gone, say), not one that ran out of time. The caller tries
 * again at its next chance, as before this file existed; a clear that ran out of time is not tried again. */
export const clearFailed = (r: ClearResult) => Object.values(r).includes('failed')

/**
 * Clear a session's stored data (the list above), its HTTP cache and its HTTP logins, side by side, each for at most
 * `timeoutMs`. `what` names the session in the log line. Resolves within `timeoutMs` (plus a tick), never rejects.
 */
export async function clearSessionData(ses: ClearableSession, what: string, timeoutMs = CLEAR_TIMEOUT_MS): Promise<ClearResult> {
  const start = (f: () => Promise<void>): Promise<void> => {
    try {
      return f()
    } catch (e) {
      return Promise.reject(e)
    }
  }
  const [storage, cache, logins] = await Promise.all([
    settleWithin(start(() => ses.clearStorageData({ storages: [...STORAGE_TYPES] })), timeoutMs),
    settleWithin(start(() => ses.clearCache()), timeoutMs),
    settleWithin(start(() => ses.clearAuthCache()), timeoutMs),
  ])
  const r: ClearResult = { storage, cache, logins }
  const bad = Object.entries(r).filter(([, v]) => v !== 'done')
  if (bad.length) console.warn('[desktop] clearing', what, 'did not finish:', bad.map(([k, v]) => `${k} ${v}`).join(', '))
  else debug('cleared', what)
  return r
}
