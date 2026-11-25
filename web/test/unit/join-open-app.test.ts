// The join pages open the desktop app first on a computer (lib/join-open-app.ts;
// docs/decisions/20261125-invite-open-app-first.md): when the page tries the app, which button leads, the remembered
// browser choice, guests, the download link and how the try is made.
import { beforeEach, describe, expect, test } from 'bun:test'
import { appFirst, appFirstLine, autoTries, browserChosen, canAutoTry, desktopDownloadHref, JOIN_IN_BROWSER_KEY, LAUNCH_FRAME_MS, launchWay, rememberBrowser, resetAutoTry, takeAutoTry } from '../../src/lib/join-open-app'
import { openInAppHref } from '../../src/lib/team-link'

const HTTPS = 'https://acme.trina.app'
const HREF = 'trina-ax://open?url=https%3A%2F%2Facme.trina.app%2Finvite%2Fabc'
const base = { platform: 'mac' as const, client: 'web' as const, origin: HTTPS, guest: false, browserChosen: false, googleBack: false, href: HREF }

describe('when the join page tries the app', () => {
  test('a member in a Mac, Windows or Linux web browser on an https team', () => {
    expect(appFirst(base)).toBe(true)
    expect(appFirst({ ...base, platform: 'windows' })).toBe(true)
    expect(appFirst({ ...base, platform: 'linux' })).toBe(true)
    // this machine (development and the tests), as lib/open-app.ts appComputer
    expect(appFirst({ ...base, origin: 'http://localhost:5173' })).toBe(true)
  })
  test('a guest keeps the browser first: someone from outside the team, usually joining once', () => {
    expect(appFirst({ ...base, guest: true })).toBe(false)
  })
  test('never on a phone, inside our apps, on a plain-http team or without a link', () => {
    expect(appFirst({ ...base, platform: 'ios' })).toBe(false)
    expect(appFirst({ ...base, platform: 'android' })).toBe(false)
    expect(appFirst({ ...base, platform: 'other' })).toBe(false)
    expect(appFirst({ ...base, client: 'desktop' })).toBe(false)
    expect(appFirst({ ...base, client: 'mobile' })).toBe(false)
    expect(appFirst({ ...base, origin: 'http://acme.example.com' })).toBe(false)
    expect(appFirst({ ...base, href: null })).toBe(false)
  })
  test('not after the person chose the browser in this browser, or came back from Google', () => {
    expect(appFirst({ ...base, browserChosen: true })).toBe(false)
    expect(appFirst({ ...base, googleBack: true })).toBe(false)
  })
  test('the link is the same "앱에서 열기" link as before, with the token where it always was', () => {
    const href = openInAppHref({ scheme: 'trina-ax', origin: HTTPS, path: '/join#t=TOKEN_TOKEN_TOKEN_1', platform: 'windows', androidPackage: '' })
    expect(href).toBe(`trina-ax://open?url=${encodeURIComponent(`${HTTPS}/join#t=TOKEN_TOKEN_TOKEN_1`)}`)
  })
})

describe('the automatic try happens once per page load', () => {
  beforeEach(() => resetAutoTry())
  test('the first ask gets it, every later one (a remount, a re-render) does not', () => {
    expect(takeAutoTry()).toBe(true)
    expect(takeAutoTry()).toBe(false)
    expect(takeAutoTry()).toBe(false)
  })
})

describe('the page never guesses whether the app opened', () => {
  test('one neutral line after any try; before a try, what the page is for', () => {
    expect(appFirstLine(false)).toBe('auth.appReady')
    expect(appFirstLine(true)).toBe('auth.appTried')
  })
  test('the automatic try waits for the tab to be seen (a link opened in a background tab)', () => {
    expect(canAutoTry('hidden')).toBe(false)
    expect(canAutoTry('visible')).toBe(true)
  })
  test('tries by itself where that is harmless: not in Safari (its alert would cover the page)', () => {
    expect(autoTries('page')).toBe(true)
    expect(autoTries('frame')).toBe(true)
    expect(autoTries('press')).toBe(false)
  })
})

describe('the download link for this computer', () => {
  const links = { page: 'https://ax.trina.app/download', mac: '', windows: '' }
  test("the system's store listing when the edition has one, else the download page", () => {
    expect(desktopDownloadHref('mac', links)).toBe(links.page)
    expect(desktopDownloadHref('windows', links)).toBe(links.page)
    expect(desktopDownloadHref('linux', links)).toBe(links.page)
    expect(desktopDownloadHref('windows', { ...links, windows: 'https://apps.microsoft.com/detail/x' })).toBe('https://apps.microsoft.com/detail/x')
    expect(desktopDownloadHref('linux', { ...links, mac: 'https://apps.apple.com/app/x' })).toBe(links.page)
  })
  test('none without an https address (a self-hosted build with no page)', () => {
    expect(desktopDownloadHref('mac', { page: '', mac: '', windows: '' })).toBeNull()
    expect(desktopDownloadHref('mac', { page: 'http://plain.example.com', mac: '', windows: '' })).toBeNull()
  })
})

describe('how the try is made', () => {
  test('a hidden frame on Firefox, a press on Safari (its alert would cover the join page), the page itself elsewhere', () => {
    expect(launchWay('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('frame')
    expect(launchWay('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('page')
    expect(launchWay('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15')).toBe('press')
    expect(LAUNCH_FRAME_MS).toBeGreaterThanOrEqual(60_000)
    expect(launchWay('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('page')
  })
})

describe('the remembered browser choice', () => {
  const store = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  test('Continue in the browser is kept for this browser; later invites go straight to the form', () => {
    const s = store()
    expect(browserChosen(s)).toBe(false)
    rememberBrowser(s)
    expect(s.m.get(JOIN_IN_BROWSER_KEY)).toBe('1')
    expect(browserChosen(s)).toBe(true)
  })
  test('blocked storage: nothing remembered, nothing thrown, the app is tried', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(browserChosen(blocked)).toBe(false)
    expect(() => rememberBrowser(blocked)).not.toThrow()
    expect(browserChosen(null)).toBe(false)
  })
})
