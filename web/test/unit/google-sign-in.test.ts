// Sign in with Google per client (web/src/lib/googleSignIn.ts; docs/decisions/20261122-google-login-apps.md): the button
// shows in the way this client can, the app's secret is random and only its SHA-256 leaves the page, the kept sign-in
// is taken once, and the desktop page reads the code only in its exact shape.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GOOGLE_SIGNIN_BRIDGE_VERSION } from '@mycel/shared'
import { afterGoogleSignIn, appSecretHash, googleSignInWay, keepGoogleSignIn, newAppSecret, readGoogleCode, takeGoogleSignIn } from '../../src/lib/googleSignIn'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

describe('Sign in with Google per client', () => {
  test('a browser: where the server offers it at this address; the apps: with the server\'s app flag and their own', () => {
    expect(googleSignInWay({ client: 'web', googleSignIn: true, googleAppSignIn: true })).toBe('web')
    expect(googleSignInWay({ client: 'web', googleSignIn: false, googleAppSignIn: true })).toBeNull()
    // the desktop app: the bridge flag; an older app keeps the password only
    expect(googleSignInWay({ client: 'desktop', googleSignIn: true, googleAppSignIn: true, desktopBridge: GOOGLE_SIGNIN_BRIDGE_VERSION })).toBe('desktop')
    expect(googleSignInWay({ client: 'desktop', googleSignIn: true, googleAppSignIn: true })).toBeNull()
    // an office address: no browser flow there, but the app's
    expect(googleSignInWay({ client: 'desktop', googleSignIn: false, googleAppSignIn: true, desktopBridge: 1 })).toBe('desktop')
    expect(googleSignInWay({ client: 'desktop', googleSignIn: true, googleAppSignIn: false, desktopBridge: 1 })).toBeNull()
    // the phone app: google-signin-v1
    expect(googleSignInWay({ client: 'mobile', googleAppSignIn: true, phone: true })).toBe('mobile')
    expect(googleSignInWay({ client: 'mobile', googleSignIn: true, googleAppSignIn: true, phone: false })).toBeNull()
  })

  test('the secret is 32 random bytes; only its SHA-256 (hex) goes to the server', async () => {
    const a = newAppSecret(), b = newAppSecret()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
    expect(newAppSecret((x) => x.fill(255))).toBe(Buffer.alloc(32, 255).toString('base64url'))
    expect(await appSecretHash(a)).toBe(createHash('sha256').update(a).digest('hex'))
  })

  test('the kept sign-in is for one kind of app, taken once, and not when too old', () => {
    const store = memory()
    const secret = newAppSecret()
    expect(keepGoogleSignIn({ secret, client: 'desktop', next: '/rooms', at: 1000 }, store)).toBe(true)
    expect(takeGoogleSignIn('desktop', 2000, store)).toEqual({ secret, client: 'desktop', next: '/rooms', at: 1000 })
    expect(takeGoogleSignIn('desktop', 2000, store)).toBeNull()
    keepGoogleSignIn({ secret, client: 'desktop', next: null, at: 1000 }, store)
    expect(takeGoogleSignIn('mobile', 2000, store)).toBeNull()
    keepGoogleSignIn({ secret, client: 'desktop', next: null, at: 1000 }, store)
    expect(takeGoogleSignIn('desktop', 1000 + 21 * 60_000, store)).toBeNull()
    store.setItem('mycel.googleSignIn', '{"secret":"short","client":"desktop","at":1}')
    expect(takeGoogleSignIn('desktop', 2, store)).toBeNull()
    expect(keepGoogleSignIn({ secret, client: 'desktop', next: null, at: 1 }, null)).toBe(false)
  })

  test('the code only in its exact shape; the landing keeps ?next=', () => {
    const code = 'A'.repeat(43)
    expect(readGoogleCode(`#code=${code}`)).toBe(code)
    for (const h of ['', `#code=${code}x`, `#code=${code}&x=1`, `#c=${code}`, '#code=short']) expect(readGoogleCode(h)).toBeNull()
    expect(afterGoogleSignIn(null)).toBe('/login')
    expect(afterGoogleSignIn('/rooms/abc?m=1')).toBe('/login?next=%2Frooms%2Fabc%3Fm%3D1')
  })

  test('the sign-in page offers it per client and the return page takes the code out of the address first', () => {
    const auth = readFileSync(join(import.meta.dir, '../../src/pages/Auth.tsx'), 'utf8')
    expect(auth).toContain('googleSignInWay({ client: clientKind(), googleSignIn: !!status.googleSignIn, googleAppSignIn: !!status.googleAppSignIn, desktopBridge: desktop()?.googleSignIn, phone: phoneGoogleSignIn() })')
    const take = auth.slice(auth.indexOf('function takeGoogleCodeOnce()'), auth.indexOf('/** One redeem per code'))
    expect(take.indexOf('readGoogleCode(window.location.hash)')).toBeLessThan(take.indexOf('window.history.replaceState'))
    // only the desktop app redeems there; a plain browser sends nothing
    expect(auth).toContain("const inApp = clientKind() === 'desktop'")
    const app = readFileSync(join(import.meta.dir, '../../src/App.tsx'), 'utf8')
    expect(app.match(/<Route path="\/login\/google" element={<GoogleReturn \/>} \/>/g)).toHaveLength(2)
  })
})
