// Every console call the desktop app makes (desktop/src/main/console-signin.ts) sends no cookies. With Electron's
// cookie encryption on (the packaged app), the first request of a session that reads cookies waits for the cookie
// store, which waits for the "<app> Safe Storage" key in the macOS keychain; when macOS asks "allow?" for it (an item
// another copy of the app made), the "Create a team for free" check waited for that answer and never came back.
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// every name another test file's electron mock exports is here too (bun keeps one module for the run): only the
// keychain is used
mock.module('electron', () => ({
  app: {}, shell: {}, powerMonitor: {}, BaseWindow: {}, session: {}, autoUpdater: {}, dialog: {},
  safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'unknown', encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
const { ConsoleSignIn } = await import('../../desktop/src/main/console-signin')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const ORIGIN = 'https://console.example.test'
const token = { token: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3600_000).toISOString(), store: false }

function setup(answer: (path: string) => { status: number; body?: unknown }, openExternal: (url: string) => void = () => {}) {
  const calls: { path: string; init: RequestInit | undefined }[] = []
  const dir = mkdtempSync(join(tmpdir(), 'console-signin-omit-'))
  dirs.push(dir)
  const signin = new ConsoleSignIn({
    origin: ORIGIN, userData: dir, locale: () => 'en', donePage: () => 'You can close this tab.', openExternal,
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      calls.push({ path, init })
      const a = answer(path)
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } })
    },
  })
  return { signin, calls }
}

describe('console calls send no cookies', () => {
  test('the "Create a team for free" check (GET /api/app/v1/me without a token)', async () => {
    const { signin, calls } = setup(() => ({ status: 401 }))
    expect(await signin.probe()).not.toBe('unknown')
    expect(calls.map((c) => c.path)).toEqual(['/api/app/v1/me'])
    expect(calls[0]?.init?.credentials).toBe('omit')
  })

  test('the browser sign-in\'s token exchange (code + verifier)', async () => {
    const { signin, calls } = setup(() => ({ status: 200, body: token }), (url) => {
      const u = new URL(url)
      // the console's return to the app's own listener
      void fetch(`http://127.0.0.1:${u.searchParams.get('port')}/console-callback?state=${u.searchParams.get('state')}&code=${'c'.repeat(43)}`)
    })
    expect(await signin.signIn(false)).toMatchObject({ ok: true })
    expect(calls.map((c) => c.path)).toEqual(['/api/app/v1/token'])
    expect(calls[0]?.init?.credentials).toBe('omit')
  })

  test('the e-mail sign-in and the calls with the token', async () => {
    const { signin, calls } = setup((path) => (path.endsWith('/verify') ? { status: 200, body: token } : { status: 200, body: {} }))
    expect(await signin.emailStart('owner@example.com', false)).toEqual({ ok: true })
    expect(await signin.emailVerify('123456')).toEqual({ ok: true })
    await signin.api('GET', '/api/app/v1/me')
    expect(calls.length).toBe(3)
    for (const c of calls) expect(c.init?.credentials).toBe('omit')
  })
})
