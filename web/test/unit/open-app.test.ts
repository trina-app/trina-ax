// "Continue in the Mac app" (lib/open-app.ts; docs/decisions/20261116-desktop-first-onboarding.md): who gets /open-app
// after setup and the files line, the link the button opens, and the code read from /app-signin's address.
import { describe, expect, test } from 'bun:test'
import { afterSetupPath, APP_SETUP_PATH, appComputer, appSignInHref, openAppLineShown, readAppSetupClaim, readAppSignInCode, takeAppSetupClaim, type AppSetupClaimStore } from '../../src/lib/open-app'

const HTTPS = 'https://acme.trina.app'
const CODE = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo'

describe('who is offered the desktop app', () => {
  test('a web browser on a Mac, Windows or Linux PC, on an https team (or this machine)', () => {
    expect(appComputer({ platform: 'mac', client: 'web', origin: HTTPS })).toBe('mac')
    expect(appComputer({ platform: 'windows', client: 'web', origin: HTTPS })).toBe('windows')
    // QA TC-5352 / TC-5072: a Linux browser was sent from /open-app to Home and could not hand back to the app
    expect(appComputer({ platform: 'linux', client: 'web', origin: HTTPS })).toBe('linux')
    expect(appComputer({ platform: 'linux', client: 'web', origin: 'http://localhost:5173' })).toBe('linux')
    expect(appComputer({ platform: 'mac', client: 'web', origin: 'http://127.0.0.1:19143' })).toBe('mac')
    expect(appComputer({ platform: 'mac', client: 'web', origin: 'http://localhost:5173' })).toBe('mac')
  })
  test('never inside our apps, on a phone, on another system, or on a plain-http team the app cannot open', () => {
    expect(appComputer({ platform: 'mac', client: 'desktop', origin: HTTPS })).toBeNull()
    expect(appComputer({ platform: 'linux', client: 'desktop', origin: HTTPS })).toBeNull()
    expect(appComputer({ platform: 'linux', client: 'web', origin: 'http://team.example.lan' })).toBeNull()
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
    expect(afterSetupPath({ platform: 'linux', client: 'web', origin: HTTPS })).toBe('/open-app')
    expect(afterSetupPath({ platform: 'mac', client: 'desktop', origin: HTTPS })).toBe('/welcome')
    expect(afterSetupPath({ platform: 'android', client: 'web', origin: HTTPS })).toBe('/welcome')
    expect(afterSetupPath({ platform: 'other', client: 'web', origin: HTTPS })).toBe('/welcome')
  })
  test('the files line: Mac and Windows browsers, never for a guest', () => {
    expect(openAppLineShown({ platform: 'mac', client: 'web', origin: HTTPS, guest: false })).toBe(true)
    expect(openAppLineShown({ platform: 'windows', client: 'web', origin: HTTPS, guest: false })).toBe(true)
    // not Linux: the Linux app has no Find work files, which is all the line is about
    expect(openAppLineShown({ platform: 'linux', client: 'web', origin: HTTPS, guest: false })).toBe(false)
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
    // the sign-in hand-back on Linux (QA TC-5072): the same link, answered by the .deb's link handler
    expect(appSignInHref({ scheme: 'trina-ax', origin: HTTPS, code: CODE, computer: 'linux' })).toBe(href)
  })
  test('/app-signin reads exactly #c=<43 characters>', () => {
    expect(readAppSignInCode(`#c=${CODE}`)).toBe(CODE)
    for (const h of ['', '#', `#c=${CODE}x`, `#c=${CODE.slice(1)}`, `#c=${CODE}&x=1`, `#x=1&c=${CODE}`, `#c=${CODE.slice(0, 42)}!`]) expect(readAppSignInCode(h)).toBeNull()
  })
  test('/app-setup (a team made from the desktop app) reads exactly #c=<43 characters>', () => {
    expect(APP_SETUP_PATH).toBe('/app-setup')
    expect(readAppSetupClaim(`#c=${CODE}`)).toBe(CODE)
    for (const h of ['', '#', `#c=${CODE}x`, `#c=${CODE.slice(1)}`, `#c=${CODE}&x=1`, `#x=1&c=${CODE}`, `#c=${CODE.slice(0, 42)}!`]) expect(readAppSetupClaim(h)).toBeNull()
  })
  // QA 0202: a reload showed "This link has expired" (the claim was out of the address), and a claim the app sent again
  // into the page on screen was never read (the page kept its first one, which the new claim had revoked)
  test('/app-setup keeps its claim for a reload of the tab; a newer claim in the address replaces it', () => {
    const box: { kept: string | null } = { kept: null }
    const store: AppSetupClaimStore = { get: () => box.kept, set: (c) => { box.kept = c }, remove: () => { box.kept = null } }
    const NEWER = CODE.slice(1) + 'A'
    expect(takeAppSetupClaim(`#c=${CODE}`, store)).toBe(CODE)
    expect(box.kept).toBe(CODE)
    // the reload: no fragment, the kept claim
    expect(takeAppSetupClaim('', store)).toBe(CODE)
    // the app opened the team again: the new claim wins and is the one kept
    expect(takeAppSetupClaim(`#c=${NEWER}`, store)).toBe(NEWER)
    expect(takeAppSetupClaim('', store)).toBe(NEWER)
    // used or refused: nothing to go on with
    store.remove()
    expect(takeAppSetupClaim('', store)).toBeNull()
    // a kept value that is not a claim is never sent
    box.kept = 'not a claim'
    expect(takeAppSetupClaim('', store)).toBeNull()
    expect(takeAppSetupClaim('#c=short', store)).toBeNull()
  })
})
