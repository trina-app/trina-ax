// The theme picked in Settings (store/session.ts setTheme, QA TC-239): shown at once; a save that fails (offline) puts
// back the theme in use before and tells the caller, so the screen, the selected button and the account agree (before,
// the screen stayed dark while the account kept light, and a reload or another tab flipped it back with no word). Only
// the latest of two quick picks decides.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Me, Theme } from '@mycel/shared/api'
import { currentTheme, storedTheme } from '../../src/lib/theme'
import { useSession } from '../../src/store/session'

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalFetch = globalThis.fetch
let values: Map<string, string>
const session = () => useSession.getState()
const me = (theme?: Theme): Me => ({
  user: { id: 'alice', username: 'alice', name: 'Alice', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: theme ? { theme } : {} },
  team: { name: 'Test team', defaultLocale: 'en' }, groups: [],
  session: { id: '0192f0a0-0000-7000-8000-000000000000', client: 'web', expiresAt: '2030-01-01T00:00:00.000Z' },
  server: { version: 'test', dev: true },
}) as Me
/** the server: each save waits until the test answers it (ok: the account takes the theme; not: the network is down) */
let saves: { theme: Theme; answer: (ok: boolean) => void }[] = []
beforeEach(() => {
  values = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  saves = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const theme = JSON.parse(String(init?.body ?? '{}')).prefs?.theme as Theme | undefined
    if (!theme) return Response.json({ error: { code: 'not_found', message: 'not here' } }, { status: 404 })
    return new Promise<Response>((resolve, reject) => saves.push({ theme, answer: (ok) => (ok ? resolve(Response.json(me(theme))) : reject(new TypeError('Failed to fetch'))) }))
  }) as typeof fetch
  session().signedIn(me('light'))
})
afterEach(() => {
  session().signedOut()
  useSession.setState({ status: { kind: 'loading' } })
  globalThis.fetch = originalFetch
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})
const tick = () => new Promise((r) => setTimeout(r, 0))
const account = () => { const s = session().status; return s.kind === 'signed-in' ? s.me.user.prefs.theme : null }

test('offline: shown at once, then back to the theme in use, and the caller hears why', async () => {
  expect(currentTheme()).toBe('light')
  const saving = session().setTheme('dark')
  expect([currentTheme(), storedTheme()]).toEqual(['dark', 'dark'])
  await tick()
  saves[0]!.answer(false)
  await expect(saving).rejects.toThrow()
  expect([currentTheme(), storedTheme(), account()]).toEqual(['light', 'light', 'light'])
})

test('saved: it stays, on the screen and in the account', async () => {
  const saving = session().setTheme('dark')
  await tick()
  saves[0]!.answer(true)
  await saving
  expect([currentTheme(), storedTheme(), account()]).toEqual(['dark', 'dark', 'dark'])
})

test('two quick picks: an earlier answer never undoes a later pick; a failed later pick goes back to what the account has', async () => {
  // dark, then system; dark fails after system was picked: system stays
  const a = session().setTheme('dark').catch(() => 'failed')
  const b = session().setTheme('system')
  await tick()
  saves[0]!.answer(false)
  expect(await a).toBe('failed')
  expect(currentTheme()).toBe('system')
  saves[1]!.answer(true)
  await b
  expect([currentTheme(), account()]).toEqual(['system', 'system'])
  // dark saved, then light not: dark (the account has it)
  saves = []
  const c = session().setTheme('dark')
  const d = session().setTheme('light').catch(() => 'failed')
  await tick()
  saves[0]!.answer(true)
  await c
  saves[1]!.answer(false)
  expect(await d).toBe('failed')
  expect([currentTheme(), storedTheme(), account()]).toEqual(['dark', 'dark', 'dark'])
  // both not saved: back to what was in use before both
  saves = []
  const e = session().setTheme('light').catch(() => 'failed')
  const f = session().setTheme('system').catch(() => 'failed')
  await tick()
  saves[0]!.answer(false)
  saves[1]!.answer(false)
  expect([await e, await f]).toEqual(['failed', 'failed'])
  expect([currentTheme(), storedTheme(), account()]).toEqual(['dark', 'dark', 'dark'])
})
