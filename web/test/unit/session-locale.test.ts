// Recovery hints never become account preferences or outlive a known sign-out.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Locale, Me } from '@mycel/shared/api'
import { currentLocale, recentLocale, storedLocale, storeLocale, storeRecentLocale, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalFetch = globalThis.fetch
let values: Map<string, string>
const session = () => useSession.getState()
const offline = () => { throw new TypeError('offline') }
function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: handler })
}
const me = (locale: Locale, team: Locale = 'en', choice: Locale | null = locale): Me => ({
  user: { id: 'alice', username: 'alice', name: 'Alice', email: null, role: 'member', locale, localeChoice: choice, mustChangePassword: false, prefs: {} },
  team: { name: 'Test team', defaultLocale: team }, groups: [],
  session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: '2030-01-01T00:00:00.000Z' },
  server: { version: 'test', dev: true },
})

beforeEach(() => {
  values = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  session().signedOut()
  useSession.setState({ status: { kind: 'loading' } })
  useLocaleStore.getState().setLocale('en')
  mockFetch(offline)
})
afterEach(() => {
  session().signedOut()
  useSession.setState({ status: { kind: 'loading' } })
  useLocaleStore.getState().setLocale('en')
  globalThis.fetch = originalFetch
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('session recovery language', () => {
  for (const locale of ['ko', 'en', 'id', 'ja', 'es'] as const) {
    test(`${locale}: successful lookup is remembered separately, offline retry keeps it, server recovery replaces it`, async () => {
      mockFetch(async () => Response.json(me(locale)))
      await session().load()
      expect(recentLocale()).toBe(locale)
      expect(storedLocale()).toBeNull()
      // Fresh page memory, same origin storage.
      useLocaleStore.getState().setLocale('en')
      useSession.setState({ status: { kind: 'loading' } })
      mockFetch(offline)
      await session().load()
      expect(session().status.kind).toBe('error')
      expect(currentLocale()).toBe(locale)
      await session().load()
      expect(currentLocale()).toBe(locale)
      const next = locale === 'id' ? 'ko' : 'id'
      mockFetch(async () => Response.json(me(next, next, null)))
      await session().load()
      expect(session().status.kind).toBe('signed-in')
      expect(currentLocale()).toBe(next)
      expect(recentLocale()).toBe(next)
      expect(storedLocale()).toBeNull()
    })
  }

  test('sign-out clears recovery; another account follows its team, not the remembered account or an old login pick', () => {
    storeLocale('id')
    session().signedIn(me('ko'))
    expect(storedLocale()).toBe('id')
    session().signedOut()
    expect(currentLocale()).toBe('id')
    expect(recentLocale()).toBeNull()
    session().signedIn({ ...me('en', 'en', null), user: { ...me('en', 'en', null).user, id: 'bob' } }, { adoptPick: true })
    expect(currentLocale()).toBe('en')
    expect(recentLocale()).toBe('en')
    expect(storedLocale()).toBe('id')
  })

  test('a 401 clears recovery even if setup is unreachable, then a new team default wins', async () => {
    session().signedIn(me('ko'))
    mockFetch(async (url) => {
      if (url === '/api/me') return Response.json({ error: { code: 'unauthorized', message: 'Signed out' } }, { status: 401 })
      return offline()
    })
    await session().load()
    expect(session().status.kind).toBe('signed-out')
    expect(recentLocale()).toBeNull()
    expect(currentLocale()).toBe('en')
    mockFetch(async (url) => url === '/api/me'
      ? Response.json({ error: { code: 'unauthorized', message: 'Signed out' } }, { status: 401 })
      : Response.json({ needed: false, teamName: null, defaultLocale: 'id' }))
    await session().load()
    expect(currentLocale()).toBe('id')
  })

  test('empty or unknown recovery hints preserve the usual default or explicit login choice', async () => {
    for (const invalid of [null, 'fr', '', '{"locale":"ko"}']) {
      storeLocale(null)
      if (invalid === null) values.delete('mycel.recentLocale')
      else values.set('mycel.recentLocale', invalid)
      expect(recentLocale()).toBeNull()
      useLocaleStore.getState().setLocale('en')
      await session().load()
      expect(currentLocale()).toBe('en')
      storeLocale('id')
      useLocaleStore.getState().setLocale(storedLocale()!)
      await session().load()
      expect(currentLocale()).toBe('id')
    }
  })

  test('denied storage does not prevent sign-in, error rendering or sign-out', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied') } })
    expect(() => storeRecentLocale('ko')).not.toThrow()
    expect(recentLocale()).toBeNull()
    session().signedIn(me('ko'))
    expect(currentLocale()).toBe('ko')
    useLocaleStore.getState().setLocale('en')
    await session().load()
    expect(currentLocale()).toBe('en')
    expect(session().status.kind).toBe('error')
    expect(() => session().signedOut()).not.toThrow()
  })

  test('failed optimistic language writes do not replace the last successful language', async () => {
    session().signedIn(me('ko'))
    await expect(session().setLocale('id')).rejects.toThrow('offline')
    expect(currentLocale()).toBe('ko')
    expect(recentLocale()).toBe('ko')
    mockFetch(async () => Response.json(me('id')))
    await session().setLocale('id')
    expect(recentLocale()).toBe('id')
    expect(storedLocale()).toBeNull()
  })

  test('storage quota/write failures leave the normal reload fallback usable', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: () => null,
      setItem: () => { throw new DOMException('Full', 'QuotaExceededError') },
      removeItem: () => { throw new DOMException('Blocked', 'SecurityError') },
    } })
    session().signedIn(me('ko'))
    expect(currentLocale()).toBe('ko')
    expect(recentLocale()).toBeNull()
    useLocaleStore.getState().setLocale('en')
    await session().load()
    expect(session().status.kind).toBe('error')
    expect(currentLocale()).toBe('en')
    expect(() => session().signedOut()).not.toThrow()
  })
})
