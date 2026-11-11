// Clearing a session's data (fix/desktop-clear-storage-hang, 2026-11-11). The in-app browser clears its partition
// when another person signs in or the person signs out (pane.ts resetForNewPerson, app-window.ts checkBrowserOwner),
// and removing a team clears both of its partitions (app-window.ts removeTeam). Every AI browser call waits for the
// first of these, so a clear that never finishes stopped the in-app browser for good.
//
// Seen on macOS 26.6 with Electron 44.7.2: `clearStorageData()` with no list never settled. Without a list Electron
// passes Chromium's REMOVE_DATA_MASK_ALL, which also asks for data types this app never uses (media licences, interest
// groups, shared storage, device-bound sessions ...) and waits for every one of them; an explicit list of the types a
// page can store settled. So: always the list below, and every clear has a time limit. A clear that is not done in
// time is logged and the caller goes on (Chromium keeps clearing in the background; the data a page can store is
// removed by the time the next page loads in practice, and the time limit only frees the caller).
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
  const settled = p.then(
    (): ClearOutcome => 'done',
    (): ClearOutcome => 'failed',
  )
  return Promise.race([settled, late]).finally(() => clearTimeout(timer))
}

export type ClearableSession = Pick<Session, 'clearStorageData' | 'clearCache' | 'clearAuthCache'>
export type ClearResult = { storage: ClearOutcome; cache: ClearOutcome; logins: ClearOutcome }

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
