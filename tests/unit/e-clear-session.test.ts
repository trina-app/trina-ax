// Desktop app (fix/desktop-clear-storage-hang, 2026-11-11): on a busy Mac (macOS 26.6, Electron 44.7.2) the in-app browser's
// "new person" clear (`session.clearStorageData()` with no list) never settled. Every AI browser call waits for that
// clear, so the in-app browser stopped for good after a sign-out or a person switch, and removing a team never
// finished. Every clear now names its storage types and has a time limit (desktop/src/main/clear-session.ts).
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { clearFailed, clearSessionData, CLEAR_TIMEOUT_MS, settleWithin, STORAGE_TYPES, type ClearableSession } from '../../desktop/src/main/clear-session'

const never = () => new Promise<void>(() => {})
const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A session whose clears are given; records what clearStorageData was asked for. */
function fakeSession(o: Partial<Record<keyof ClearableSession, () => Promise<void>>> = {}) {
  const asked: unknown[] = []
  const ses: ClearableSession = {
    clearStorageData: ((opts?: unknown) => {
      asked.push(opts)
      return (o.clearStorageData ?? (() => Promise.resolve()))()
    }) as ClearableSession['clearStorageData'],
    clearCache: () => (o.clearCache ?? (() => Promise.resolve()))(),
    clearAuthCache: () => (o.clearAuthCache ?? (() => Promise.resolve()))(),
  }
  return { ses, asked }
}

let warn: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  warn?.mockRestore()
  warn = undefined
})

describe('settleWithin', () => {
  test('a promise that resolves in time is done, one that rejects is failed', async () => {
    expect(await settleWithin(Promise.resolve(), 1000)).toBe('done')
    expect(await settleWithin(later(20), 1000)).toBe('done')
    expect(await settleWithin(Promise.reject(new Error('x')), 1000)).toBe('failed')
  })

  test('a promise that never settles is a timeout after the limit, not later and not sooner', async () => {
    const t0 = Date.now()
    expect(await settleWithin(never(), 150)).toBe('timeout')
    const took = Date.now() - t0
    expect(took).toBeGreaterThanOrEqual(140)
    expect(took).toBeLessThan(1000)
  })

  test('a promise that rejects after the limit is still a timeout and is not an unhandled rejection', async () => {
    const p = later(100).then(() => {
      throw new Error('late')
    })
    expect(await settleWithin(p, 20)).toBe('timeout')
    await later(150)
  })
})

describe('clearSessionData', () => {
  test('clears an explicit list of storage types, never "all" (no options), plus the HTTP cache and HTTP logins', async () => {
    let cache = 0, logins = 0
    const { ses, asked } = fakeSession({ clearCache: async () => void cache++, clearAuthCache: async () => void logins++ })
    expect(await clearSessionData(ses, 'test')).toEqual({ storage: 'done', cache: 'done', logins: 'done' })
    expect(asked).toEqual([{ storages: [...STORAGE_TYPES] }])
    expect(cache).toBe(1)
    expect(logins).toBe(1)
  })

  test('the list holds every place a sign-in can live: cookies, local storage, IndexedDB, cache storage, service workers', () => {
    // the names are Electron's (ClearStorageDataOptions.storages; tsc checks them)
    for (const t of ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'filesystem'] as const) expect(STORAGE_TYPES).toContain(t)
  })

  test('a storage clear that never settles: the call ends at the time limit, the other clears still ran, and it is logged', async () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
    let cache = 0
    const { ses } = fakeSession({ clearStorageData: never, clearCache: async () => void cache++ })
    const t0 = Date.now()
    expect(await clearSessionData(ses, 'team x browser', 100)).toEqual({ storage: 'timeout', cache: 'done', logins: 'done' })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(cache).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0].join(' '))).toContain('team x browser')
    expect(String(warn.mock.calls[0].join(' '))).toContain('storage timeout')
  })

  test('every clear stuck at once still ends at one time limit (they run side by side)', async () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
    const { ses } = fakeSession({ clearStorageData: never, clearCache: never, clearAuthCache: never })
    const t0 = Date.now()
    expect(await clearSessionData(ses, 'x', 1000)).toEqual({ storage: 'timeout', cache: 'timeout', logins: 'timeout' })
    // one limit, not three in a row (3 s)
    expect(Date.now() - t0).toBeLessThan(2500)
  })

  test('a clear that rejects or throws is failed, logged, and does not stop the others', async () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
    let logins = 0
    const { ses } = fakeSession({
      clearStorageData: () => Promise.reject(new Error('gone')),
      clearCache: () => {
        throw new Error('destroyed')
      },
      clearAuthCache: async () => void logins++,
    })
    expect(await clearSessionData(ses, 'x', 1000)).toEqual({ storage: 'failed', cache: 'failed', logins: 'done' })
    expect(logins).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  test('clearFailed: a failed clear is tried again by the caller, one that ran out of time is not', () => {
    expect(clearFailed({ storage: 'done', cache: 'done', logins: 'done' })).toBe(false)
    expect(clearFailed({ storage: 'timeout', cache: 'timeout', logins: 'timeout' })).toBe(false)
    expect(clearFailed({ storage: 'failed', cache: 'done', logins: 'done' })).toBe(true)
    expect(clearFailed({ storage: 'done', cache: 'done', logins: 'failed' })).toBe(true)
  })

  test('the default time limit is short enough for an AI browser call to wait it out', () => {
    expect(CLEAR_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    expect(CLEAR_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
  })
})

describe('wiring', () => {
  const SRC = join(import.meta.dir, '../../desktop/src')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
    })

  test('no desktop code clears a session except through clearSessionData', () => {
    for (const f of files(SRC)) {
      if (f.endsWith(join('main', 'clear-session.ts'))) continue
      const src = readFileSync(f, 'utf8')
      for (const m of ['clearStorageData(', 'clearCache(', 'clearAuthCache(', 'clearData(']) expect({ f, has: src.includes(`.${m}`) }).toEqual({ f, has: false })
    }
  })

  test('the pane reset, the reset of a closed pane and team removal use it', () => {
    const pane = readFileSync(join(SRC, 'main/pane/pane.ts'), 'utf8')
    const win = readFileSync(join(SRC, 'main/app-window.ts'), 'utf8')
    const body = (src: string, head: string) => {
      const at = src.indexOf(head)
      expect(at).toBeGreaterThan(-1)
      return src.slice(at, src.indexOf('\n  }\n', at))
    }
    const reset = body(pane, 'async resetForNewPerson()')
    expect(reset).toContain('const cleared = await clearSessionData(this.session,')
    expect(reset).toContain('return cleared')
    const owner = body(win, 'private async checkBrowserOwner(')
    expect(owner).toContain('cleared = await pane.resetForNewPerson()')
    expect(owner).toContain('cleared = await clearSessionData(session.fromPartition(partitionFor(teamId, \'browser\')),')
    // a failed clear (not a timeout) does not record the new person: the next check clears again
    expect(owner.indexOf('if (clearFailed(cleared)) throw')).toBeGreaterThan(owner.indexOf('cleared = await clearSessionData('))
    expect(owner.indexOf('if (clearFailed(cleared)) throw')).toBeLessThan(owner.indexOf('saveBrowserOwner('))
    // team removal: off the list first, then the clears (both partitions side by side), then its files
    const remove = body(win, 'async removeTeam(id: string)')
    expect(remove).toContain("await Promise.all((['app', 'browser'] as const).map((kind) => clearSessionData(session.fromPartition(partitionFor(id, kind)),")
    expect(remove.indexOf('this.saveTeams(removeTeam(')).toBeLessThan(remove.indexOf('clearSessionData('))
    expect(remove.indexOf('clearSessionData(')).toBeLessThan(remove.indexOf('removeTeamFiles('))
  })
})
