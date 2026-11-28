// The AI's browser in the person's own Chrome (docs/decisions/20261128-trina-in-chrome.md), the web half against the
// mock server: Settings › Browser › "Your Chrome" (how to connect; a linked Chrome with Disconnect), and the extension's
// Connect page /connect-chrome: a signed-out visitor signs in and comes back with the challenge, Connect moves the tab
// to /connect-chrome/done with the code only after #, a page opened without a challenge offers nothing. The extension
// itself is tests/e2e/chrome-extension.spec.ts.
import { expect, test } from '@playwright/test'
import { CHROME_CONNECT_DONE_PATH } from '@mycel/shared/api'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const CHALLENGE = 'abcDEF0123456789_-abcDEF0123456789_-abcDEF0'

test('Settings › Browser on a computer: how to connect, then the linked Chrome; Disconnect takes it away at once', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/settings/browser')
  const section = page.getByTestId('chrome-link')
  await expect(section.getByTestId('chrome-link-how')).toContainText('127.0.0.1')
  // the extension linked this Chrome: the next read (every 10 s, or on focus) shows it
  expect((await page.request.post('/__test/chrome', { data: { username: OWNER.username, links: [{ label: 'Chrome on Mac', online: true }] } })).ok()).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(section.getByTestId('chrome-link-label')).toHaveText('Chrome on Mac')
  await expect(section.getByTestId('chrome-link-state')).toHaveText('연결됨')
  // a browser, not the desktop app: no switch for where the AI's browser runs
  await expect(section.getByTestId('chrome-target')).toHaveCount(0)
  await section.getByTestId('chrome-link-disconnect').click()
  await expect(section.getByTestId('chrome-link-how')).toBeVisible()
  await expect(section.getByTestId('chrome-link-row')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('Settings › Browser: several profiles, each renamed in place, with its own sites and "Only these sites"', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  expect((await page.request.post('/__test/chrome', { data: { username: OWNER.username, links: [{ label: 'Chrome on Mac', online: true }, { label: 'Edge on Mac', sites: ['naver.com'] }] } })).ok()).toBe(true)
  await signIn(page)
  await page.goto('/settings/browser')
  const rows = page.getByTestId('chrome-link-row')
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId('chrome-link-another')).toBeVisible()
  // rename: the pencil, a new name, Enter
  const first = rows.first()
  await first.getByTestId('chrome-link-rename').click()
  await first.getByTestId('chrome-link-name').fill('업무 메일')
  await first.getByTestId('chrome-link-name').press('Enter')
  await expect(first.getByTestId('chrome-link-label')).toHaveText('업무 메일')
  // its sites: add one (an address is kept as its site), then only these
  await first.getByTestId('chrome-link-sites-toggle').click()
  await first.getByTestId('chrome-link-site-input').fill('https://mail.google.com/mail/u/0')
  await first.getByTestId('chrome-link-site-add').click()
  await expect(first.getByTestId('chrome-link-site')).toHaveText('mail.google.com')
  await first.getByTestId('chrome-link-only').click({ force: true })
  await expect(first.getByTestId('chrome-link-only')).toBeChecked()
  // the other profile keeps its own list; a chip's × removes its site
  const second = rows.nth(1)
  await second.getByTestId('chrome-link-sites-toggle').click()
  await second.getByTestId('chrome-link-site-remove').click()
  await expect(second.getByTestId('chrome-link-sites-none')).toBeVisible()
  const saved = await (await page.request.get('/api/chrome/links')).json() as { links: { label: string; sites: string[]; onlyListed: boolean }[] }
  expect(saved.links.map((l) => [l.label, l.sites, l.onlyListed])).toEqual([['업무 메일', ['mail.google.com'], true], ['Edge on Mac', [], false]])
  expect(realErrors(errors)).toEqual([])
})

test('/connect-chrome: signed out it signs in first and comes back; Connect goes to the done page with the code after #', async ({ page }) => {
  await reset(page)
  await page.goto(`/connect-chrome?challenge=${CHALLENGE}`)
  await expect(page).toHaveURL(/\/login\?next=/)
  await page.getByTestId('login-username').fill(OWNER.username)
  await page.getByTestId('login-password').fill(OWNER.password)
  await page.getByTestId('login-submit').click()
  await expect(page).toHaveURL(new RegExp(`/connect-chrome\\?challenge=${CHALLENGE}$`))
  await expect(page.getByTestId('connect-chrome-host')).toHaveText(new URL(page.url()).host)
  await expect(page.getByTestId('connect-chrome-account')).toContainText(`@${OWNER.username}`)
  const pair = page.waitForRequest((r) => r.url().endsWith('/api/chrome/pair') && r.method() === 'POST')
  await page.getByTestId('connect-chrome-connect').click()
  expect((await pair).postDataJSON()).toEqual({ challenge: CHALLENGE })
  await expect(page).toHaveURL(new RegExp(`${CHROME_CONNECT_DONE_PATH}#code=[A-Za-z0-9_-]{43}$`))
  await expect(page.getByTestId('connect-chrome-done')).toBeVisible()
})

test('/connect-chrome without a challenge: one plain line, no Connect; Cancel with one goes Home', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/connect-chrome')
  await expect(page.getByTestId('connect-chrome-missing')).toBeVisible()
  await expect(page.getByTestId('connect-chrome-connect')).toHaveCount(0)
  await page.goto('/connect-chrome?challenge=short')
  await expect(page.getByTestId('connect-chrome-missing')).toBeVisible()
  await page.goto(`/connect-chrome?challenge=${CHALLENGE}`)
  await page.getByTestId('connect-chrome-cancel').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
})

// docs/decisions/20261128-chrome-app-led-linking.md: inside the desktop app, Settings › Browser lists this computer's
// profiles; the app asks this page for a pair code and tells it when a profile linked (notice with Undo)
test('desktop app: the profiles of this computer, Connect / Connect all, the pair code for the app, the notice with Undo', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await page.addInitScript(() => {
    const noop = () => {}
    const w = window as unknown as Record<string, unknown>
    const calls: unknown[] = []
    let pair: ((r: { challenge: string }) => Promise<{ code: string } | null>) | null = null
    let linked: ((l: { linkId: string; label: string; browser: string }) => void) | null = null
    w.__chromeCalls = calls
    w.__askPair = (challenge: string) => pair!({ challenge })
    w.__linked = (l: { linkId: string; label: string; browser: string }) => linked!(l)
    w.mycelDesktop = {
      bridgeVersion: 1, appVersion: '0.21.0', platform: 'darwin',
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
      notify: noop,
      chromeProfiles: {
        list: async () => [
          { browser: 'chrome', dir: 'Default', name: 'Work', email: 'owner@work.example', installed: true },
          { browser: 'chrome', dir: 'Profile 1', name: 'Home', email: 'owner@home.example', installed: true },
          { browser: 'edge', dir: 'Default', name: 'Person 1', installed: false },
        ],
        connect: async (p: unknown) => { calls.push(p); return 'pair' },
        onPairRequest: (cb: typeof pair) => { pair = cb; return () => { pair = null } },
        onLinked: (cb: typeof linked) => { linked = cb; return () => { linked = null } },
      },
    }
  })
  await signIn(page)
  await page.goto('/settings/browser')
  const list = page.getByTestId('chrome-profiles')
  await expect(list.getByTestId('chrome-profile-row')).toHaveCount(3)
  await expect(list.getByTestId('chrome-profile-connect').last()).toContainText('Edge')
  await list.getByTestId('chrome-profile-connect').first().click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __chromeCalls: unknown[] }).__chromeCalls.length)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __chromeCalls: unknown[] }).__chromeCalls[0])).toEqual({ browser: 'chrome', dir: 'Default' })
  // the app asks this signed-in page for a pair code bound to the extension's challenge
  const got = await page.evaluate((c) => (window as unknown as { __askPair(c: string): Promise<{ code: string } | null> }).__askPair(c), CHALLENGE)
  expect(got?.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
  // the extension linked: it shows in the list as connected, with the notice and Undo
  expect((await page.request.post('/__test/chrome', { data: { username: OWNER.username, links: [{ label: 'Work', email: 'owner@work.example', browser: 'Chrome on Mac', online: true }] } })).ok()).toBe(true)
  const linkId = (await (await page.request.get('/api/chrome/links')).json()).links[0].id as string
  await page.evaluate((id) => (window as unknown as { __linked(l: unknown): void }).__linked({ linkId: id, label: 'Work', browser: 'Chrome' }), linkId)
  const toast = page.getByTestId('toast').filter({ hasText: 'Work' })
  await expect(toast).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(list.getByTestId('chrome-profile-linked')).toHaveCount(1)
  // Undo disconnects that link
  await toast.getByTestId('toast-link').click()
  await expect.poll(async () => (await (await page.request.get('/api/chrome/links')).json()).links.length).toBe(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(list.getByTestId('chrome-profile-linked')).toHaveCount(0)
  // Connect all: every profile not linked, one after the other
  await list.getByTestId('chrome-profiles-all').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __chromeCalls: unknown[] }).__chromeCalls.length), { timeout: 15_000 }).toBe(4)
  expect(realErrors(errors)).toEqual([])
})
