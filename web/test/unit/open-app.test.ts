// "Continue in the Mac app" (lib/open-app.ts; docs/decisions/20261116-desktop-first-onboarding.md): who gets /open-app
// after setup and the files line, the link the button opens, and the code read from /app-signin's address.
import { describe, expect, test } from 'bun:test'
import { afterSetupPath, appComputer, appSignInHref, openAppLineShown, readAppSignInCode } from '../../src/lib/open-app'

const HTTPS = 'https://acme.trina.app'
const CODE = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo'

describe('who is offered the desktop app', () => {
  test('a web browser on a Mac or Windows PC, on an https team (or this machine)', () => {
    expect(appComputer({ platform: 'mac', client: 'web', origin: HTTPS })).toBe('mac')
    expect(appComputer({ platform: 'windows', client: 'web', origin: HTTPS })).toBe('windows')
    expect(appComputer({ platform: 'mac', client: 'web', origin: 'http://127.0.0.1:19143' })).toBe('mac')
    expect(appComputer({ platform: 'mac', client: 'web', origin: 'http://localhost:5173' })).toBe('mac')
  })
  test('never inside our apps, on a phone, on Linux, or on a plain-http team the app cannot open', () => {
    expect(appComputer({ platform: 'mac', client: 'desktop', origin: HTTPS })).toBeNull()
    expect(appComputer({ platform: 'windows', client: 'desktop', origin: HTTPS })).toBeNull()
    expect(appComputer({ platform: 'ios', client: 'mobile', origin: HTTPS })).toBeNull()
    expect(appComputer({ platform: 'ios', client: 'web', origin: HTTPS })).toBeNull()
    expect(appComputer({ platform: 'android', client: 'web', origin: HTTPS })).toBeNull()
    expect(appComputer({ platform: 'other', client: 'web', origin: HTTPS })).toBeNull()
    expect(appComputer({ platform: 'mac', client: 'web', origin: 'http://team.example.lan' })).toBeNull()
    expect(appComputer({ platform: 'mac', client: 'web', origin: 'null' })).toBeNull()
  })
  test('after setup: /open-app on such a computer, else the welcome steps', () => {
    expect(afterSetupPath({ platform: 'mac', client: 'web', origin: HTTPS })).toBe('/open-app')
    expect(afterSetupPath({ platform: 'windows', client: 'web', origin: HTTPS })).toBe('/open-app')
    expect(afterSetupPath({ platform: 'mac', client: 'desktop', origin: HTTPS })).toBe('/welcome')
    expect(afterSetupPath({ platform: 'android', client: 'web', origin: HTTPS })).toBe('/welcome')
    expect(afterSetupPath({ platform: 'other', client: 'web', origin: HTTPS })).toBe('/welcome')
  })
  test('the files line: the same computers, never for a guest', () => {
    expect(openAppLineShown({ platform: 'mac', client: 'web', origin: HTTPS, guest: false })).toBe(true)
    expect(openAppLineShown({ platform: 'mac', client: 'web', origin: HTTPS, guest: true })).toBe(false)
    expect(openAppLineShown({ platform: 'ios', client: 'web', origin: HTTPS, guest: false })).toBe(false)
    expect(openAppLineShown({ platform: 'windows', client: 'desktop', origin: HTTPS, guest: false })).toBe(false)
  })
})

describe('the link and the code', () => {
  test('the button opens <scheme>://open?url=<team>/app-signin#c=<code>, the code only in the fragment', () => {
    const href = appSignInHref({ scheme: 'trina-ax', origin: HTTPS, code: CODE, computer: 'mac' })!
    expect(href).toBe(`trina-ax://open?url=${encodeURIComponent(`${HTTPS}/app-signin#c=${CODE}`)}`)
    const inner = new URL(new URL(href).searchParams.get('url')!)
    expect(inner.pathname).toBe('/app-signin')
    expect(inner.search).toBe('')
    expect(inner.hash).toBe(`#c=${CODE}`)
    expect(appSignInHref({ scheme: 'trina-ax', origin: HTTPS, code: CODE, computer: 'windows' })).toBe(href)
  })
  test('/app-signin reads exactly #c=<43 characters>', () => {
    expect(readAppSignInCode(`#c=${CODE}`)).toBe(CODE)
    for (const h of ['', '#', `#c=${CODE}x`, `#c=${CODE.slice(1)}`, `#c=${CODE}&x=1`, `#x=1&c=${CODE}`, `#c=${CODE.slice(0, 42)}!`]) expect(readAppSignInCode(h)).toBeNull()
  })
})
