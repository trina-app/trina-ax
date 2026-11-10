// Where a Google Drive sign-in starts (lib/driveSignIn.ts): Google's own page, or on a hosted team the hosting
// service's start page when the server sent one in its exact shape; the phone app always gets Google's page.
import { expect, test } from 'bun:test'
import { driveSignInUrl, googleAuthorization } from '../../src/lib/driveSignIn'

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
