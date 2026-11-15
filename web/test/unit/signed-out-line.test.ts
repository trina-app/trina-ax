// TC-1974: the sign-in page's line says why the person was signed out. A removed member hears that they are no longer
// in the team (the server's 401 reason 'account_removed', only for their own sign-in), not "you signed out elsewhere
// or your password changed".
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ApiError } from '@mycel/shared/api'
import { t } from '../../src/i18n'
import { accountRemoved, signedOutLine } from '../../src/lib/signedOut'
import { useSession } from '../../src/store/session'

const originalFetch = globalThis.fetch
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const session = () => useSession.getState()
function mockFetch(handler: () => Promise<Response>) {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: handler })
}
const unauthorized = (params?: Record<string, string>) => async () =>
  Response.json({ error: { code: 'unauthorized', message: 'Please sign in.', ...(params ? { params } : {}) } }, { status: 401 })
const settle = () => new Promise((r) => setTimeout(r, 20))
const reason = () => { const s = session().status; return s.kind === 'signed-out' ? s.reason : 'not signed out' }

beforeEach(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) }, removeItem: (k: string) => { values.delete(k) },
  } })
})
afterEach(() => {
  globalThis.fetch = originalFetch
  useSession.setState({ status: { kind: 'loading' } })
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('the sign-in page line', () => {
  test('each reason has its own line; a plain visit has none', () => {
    expect(signedOutLine('removed')).toBe('auth.accountRemoved')
    expect(t(signedOutLine('removed')!)).toBe("You're no longer a member of this team. Ask the team owner if this is a mistake.")
    expect(signedOutLine('ended')).toBe('auth.sessionEnded')
    expect(signedOutLine('expired')).toBe('auth.sessionExpired')
    expect(signedOutLine(undefined)).toBeUndefined()
  })

  test('only a 401 with the reason account_removed counts as removed', () => {
    const body = (params?: Record<string, string>) => ({ code: 'unauthorized' as const, message: 'Please sign in.', ...(params ? { params } : {}) })
    expect(accountRemoved(new ApiError(401, body({ reason: 'account_removed' })))).toBe(true)
    expect(accountRemoved(new ApiError(401, body()))).toBe(false)
    expect(accountRemoved(new ApiError(403, { code: 'forbidden', message: 'No', params: { reason: 'account_removed' } }))).toBe(false)
    expect(accountRemoved(new Error('account_removed'))).toBe(false)
  })
})

describe('after the live link ends the sign-in', () => {
  test('the server says the account was removed: the page says so', async () => {
    mockFetch(unauthorized({ reason: 'account_removed' }))
    useSession.setState({ status: { kind: 'loading' } })
    session().signedOut('ended')
    await settle()
    expect(reason()).toBe('removed')
  })

  test('a plain 401 keeps "signed out elsewhere" (and an expired one its own line)', async () => {
    for (const r of ['ended', 'expired'] as const) {
      mockFetch(unauthorized())
      session().signedOut(r)
      await settle()
      expect(reason()).toBe(r)
    }
  })

  test('opening the page again with that sign-in: the same line', async () => {
    let n = 0
    mockFetch(async () => (n++ === 0 ? unauthorized({ reason: 'account_removed' })() : Response.json({ needed: false, teamName: null, defaultLocale: 'en' })))
    useSession.setState({ status: { kind: 'loading' } })
    await session().load()
    expect(reason()).toBe('removed')
  })
})
