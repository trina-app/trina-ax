// Where a Google Drive sign-in starts (lib/driveSignIn.ts): Google's own page, or on a hosted team the hosting
// service's start page when the server sent one in its exact shape; the phone app always gets Google's page. And the
// window it opens in: a browser reserves one during the click, the desktop app opens the address once it is known.
import { expect, test } from 'bun:test'
import { driveSignInUrl, googleAuthorization, openSignInWindow, reserveSignInWindow, type SignInPlace } from '../../src/lib/driveSignIn'

const google = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=abc'
const state = 'A'.repeat(43)
const page = `https://account.trina.app/drive-broker/connect?state=${state}`

test('Google only: a sign-in address that is not Google\'s page is refused', () => {
  expect(googleAuthorization(google)).toBe(google)
  for (const bad of ['https://accounts.google.com.evil.test/o/oauth2/v2/auth', 'https://accounts.google.com/other', 'http://accounts.google.com/o/oauth2/v2/auth', 'https://u:p@accounts.google.com/o/oauth2/v2/auth'])
    expect(() => googleAuthorization(bad)).toThrow()
  expect(() => driveSignInUrl({ authorizationUrl: 'https://evil.test/o/oauth2/v2/auth', connectUrl: page }, false)).toThrow()
})

test('the browser opens the hosting service\'s start page; the phone app opens Google', () => {
  expect(driveSignInUrl({ authorizationUrl: google, connectUrl: page }, false)).toBe(page)
  expect(driveSignInUrl({ authorizationUrl: google, connectUrl: page }, true)).toBe(google)
  expect(driveSignInUrl({ authorizationUrl: google }, false)).toBe(google)
  // a development control plane on this machine
  const local = `http://127.0.0.1:47900/drive-broker/connect?state=${state}`
  expect(driveSignInUrl({ authorizationUrl: google, connectUrl: local }, false)).toBe(local)
})

test('a start page in any other shape falls back to Google', () => {
  for (const bad of [
    `http://account.trina.app/drive-broker/connect?state=${state}`,
    `https://account.trina.app/drive-broker/other?state=${state}`,
    `https://account.trina.app/drive-broker/connect?state=short`,
    `https://account.trina.app/drive-broker/connect?state=${state}&next=https://evil.test`,
    `https://account.trina.app/drive-broker/connect?state=${state}#x`,
    `https://u:p@account.trina.app/drive-broker/connect?state=${state}`,
    'javascript:alert(1)', 'not a url',
  ]) expect(driveSignInUrl({ authorizationUrl: google, connectUrl: bad }, false)).toBe(google)
})

/** window.open as each place answers it: a browser gives a window; the desktop app's handler opens http(s) addresses in
 * the system browser and answers every call with no window (desktop/src/main/security.ts). */
function fakeOpen(place: SignInPlace) {
  const calls: string[] = [], external: string[] = [], replaced: string[] = []
  const open = (url: string) => {
    calls.push(url)
    if (place === 'desktop') { if (/^https?:\/\//.test(url)) external.push(url); return null }
    return { opener: {}, location: { replace: (u: string) => void replaced.push(u) } } as unknown as Window
  }
  return { open, calls, external, replaced }
}

test('the desktop app reserves no blank window and opens Google\'s address in the system browser once it is known', () => {
  const f = fakeOpen('desktop')
  const reserved = reserveSignInWindow('desktop', f.open)
  expect(reserved).toBeNull()
  expect(f.calls).toEqual([])
  openSignInWindow('desktop', reserved, google, f.open)
  expect(f.calls).toEqual([google])
  expect(f.external).toEqual([google])
})

test('a browser reserves a blank window in the click and sends it to the address; the phone app opens none here', () => {
  const f = fakeOpen('browser')
  const reserved = reserveSignInWindow('browser', f.open)
  expect(f.calls).toEqual(['about:blank'])
  expect(reserved!.opener).toBeNull()
  openSignInWindow('browser', reserved, page, f.open)
  expect(f.replaced).toEqual([page])
  expect(f.calls).toEqual(['about:blank'])
  // a blocked window: nothing more is opened (the page shows "Continue with Google")
  openSignInWindow('browser', null, page, f.open)
  expect(f.calls).toEqual(['about:blank'])
  const p = fakeOpen('phone')
  expect(reserveSignInWindow('phone', p.open)).toBeNull()
  openSignInWindow('phone', null, google, p.open)
  expect(p.calls).toEqual([])
})
