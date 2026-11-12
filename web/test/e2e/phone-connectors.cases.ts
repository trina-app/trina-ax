// Connectors on a phone (390×844, touch; pages/Connectors.tsx), QA TC-262 step 1 as it says it: "Me › 연결한 서비스, tap
// +, open Google Drive" → "Status and Disconnect only, one line 'connect on a computer'; plain list, search scrolls
// away, 44px".
// - The line, the search box and "Add custom connector" are the top of the page and scroll away with the list (a
//   computer and a tablet keep them in the sticky title bar).
// - "Show all (n)" / "Show less" and the other small links take a 44 px tap and still read as text links; so does
//   Admin › Connectors' "Show all →".
// - In the phone app a + and "Add custom connector" show one line and Done, no form; Google Drive's page (and a Google
//   app's) offers no Google sign-in: what it is now, Disconnect, and one line to connect on a computer. A phone's
//   browser keeps Connect.
// Each test runs in WebKit (the iPhone app's engine: phone-connectors.webkit.spec.ts) and Chromium (Android's:
// phone-connectors.spec.ts).
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'
import { DICTS, translate, type MessageKey } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en
const tr = (key: MessageKey, params: Record<string, string | number>) => translate('en', key, params)
const BOB = { username: 'bob', password: 'bob password 1' }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' } as const
const account = { name: 'Drive Fixture', email: 'fixture@example.test' }
const disconnected = { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null, personalAllowed: true, teamShares: [] }
const connected = { ...disconnected, status: 'connected', account }
const box = async (l: Locator) => (await l.boundingBox())!

/** The phone app's bridge (mobile.spec.ts): a valid config (every required capability), every message answered ok and
 * kept in window.__sent, so a test sees whether Google was opened. */
async function phoneApp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; __sent: string[] }
    w.__sent = []
    w.mycelMobile = { protocol: 1, appVersion: '1.0.4', platform: 'android', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1'] }
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage
      w.__sent.push(m.type)
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
    } }
  })
}
const sentToApp = (page: Page) => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent)

/** Google Drive's addresses like a server with a Google client; `state.now` is what GET returns. */
async function fakeDrive(page: Page, start: object) {
  const state = { now: start, authorized: 0, disconnected: 0 }
  await page.route('**/api/integrations/google-drive', (r) => {
    if (r.request().method() === 'DELETE') { state.disconnected++; state.now = disconnected; return r.fulfill({ json: { disconnected: true, revocation: 'revoked' } }) }
    return r.fulfill({ json: state.now })
  })
  await page.route('**/api/integrations/google-drive/authorize', (r) => { state.authorized++; return r.fulfill({ json: { flowId: 'f', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x', expiresAt: '2099-01-01T00:00:00.000Z' } }) })
  return state
}

/** Connectors as a person reaches it on a phone: Me (the 나 tab), its Connectors row (Settings › Connectors since
 * 2026-11-12; the ☰ drawer has no Connectors) */
async function openConnectors(page: Page) {
  await page.goto('/')
  await expect(page.locator('[data-testid="nav-connectors"]')).toHaveCount(0)
  await page.getByTestId('tab-me').tap()
  await page.getByTestId('settings-row-connectors').tap()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  await expect(page.getByTestId('connector-discover')).toBeVisible()
}

/** Every button and link on the page at least 44 px tall (and wide) on a phone */
async function targets(root: Locator) {
  const small = await root.locator('button:visible, a:visible').evaluateAll((els) => els
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.height > 1 && (r.height < 44 || r.width < 44))
    .map(({ e, r }) => `${(e.getAttribute('data-testid') || e.textContent || '').trim().slice(0, 24)} ${Math.round(r.width)}×${Math.round(r.height)}`))
  expect(small).toEqual([])
}

export function connectorsCases() {
  // the app's service worker (WebKit) would answer the API itself, past page.route
  test.use({ ...PHONE, serviceWorkers: 'block' })

  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  })

  test.describe('TC-262 step 1 in the phone app (owner)', () => {
    test.beforeEach(async ({ page }) => {
      await phoneApp(page)
      await signIn(page)
      await openConnectors(page)
    })

    test('the line, the search and Add custom connector scroll away with the list; one scrolling page', async ({ page }) => {
      // Settings' column scrolls the section
      const scroller = page.getByTestId('settings-content')
      const header = page.getByTestId('connectors-header')
      const top = (await box(scroller)).y
      await expect(header).toContainText(t['connectorsPage.desc'])
      await expect(header.getByTestId('connector-search')).toBeVisible()
      await expect(header.getByTestId('integration-add')).toBeVisible()
      expect((await box(header)).y).toBeGreaterThanOrEqual(top - 1)
      // no part of the page holds its own place: the header is not sticky
      expect(await header.evaluate((e) => getComputedStyle(e).position)).not.toBe('sticky')
      // the page scrolls further than the header is tall; scrolled to its end, the header has gone off the top
      const h = (await box(header)).height
      expect(h).toBeGreaterThan(100)
      expect(await scroller.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeGreaterThan(h + 50)
      await scroller.evaluate((e) => e.scrollTo(0, e.scrollHeight))
      await expect.poll(async () => (await box(header)).y).toBeLessThan(0)
      const search = await box(page.getByTestId('connector-search'))
      expect(search.y + search.height).toBeLessThanOrEqual(top)
      // the list is what fills the screen now
      expect((await box(page.getByTestId('connector-list'))).y).toBeLessThan(top + 200)
      // nothing scrolls sideways
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    })

    test('"Show all" and "Show less" take a 44 px tap and stay text links; every button and link on the page is 44 px', async ({ page }) => {
      const all = page.getByTestId('connector-show-all')
      await expect(all).toHaveText(/\(\d+\)$/)
      let b = await box(all)
      expect(b.height).toBeGreaterThanOrEqual(44)
      expect(b.width).toBeGreaterThanOrEqual(44)
      // a text link: no border, no fill
      expect(await all.evaluate((e) => { const s = getComputedStyle(e); return [s.borderTopWidth, s.backgroundColor] })).toEqual(['0px', 'rgba(0, 0, 0, 0)'])
      await all.tap()
      await expect(all).toHaveText(t['connectors.showLess'])
      b = await box(all)
      expect(b.height).toBeGreaterThanOrEqual(44)
      expect(b.width).toBeGreaterThanOrEqual(44)
      await targets(page.getByTestId('integrations'))
    })

    test('a + and "Add custom connector" show one line "connect on a computer" and Done, no form', async ({ page }) => {
      const add = page.locator('[data-testid="connector-card"][data-id="notion"]').getByTestId('connector-add')
      const b = await box(add)
      expect(b.height).toBeGreaterThanOrEqual(44)
      expect(b.width).toBeGreaterThanOrEqual(44)
      await add.tap()
      // the sheet over Settings (Settings itself is a dialog too)
      const sheet = page.getByRole('dialog').filter({ has: page.getByTestId('integration-on-computer-done') })
      await expect(sheet.getByTestId('integration-on-computer')).toContainText(tr('integrations.onComputer', { name: 'Notion' }))
      await expect(sheet.locator('input, textarea, select')).toHaveCount(0)
      await sheet.getByTestId('integration-on-computer-done').tap()
      await expect(sheet).toHaveCount(0)

      await page.getByTestId('integration-add').tap()
      await expect(sheet.getByTestId('integration-on-computer')).toContainText(t['integrations.onComputerNew'])
      await expect(sheet.locator('input, textarea, select')).toHaveCount(0)
      await sheet.getByTestId('integration-on-computer-done').tap()
      await expect(sheet).toHaveCount(0)
    })
  })

  test.describe('TC-262 step 1: Google Drive in the phone app (member)', () => {
    test.beforeEach(async ({ page }) => {
      await phoneApp(page)
    })

    test('not connected: Drive\'s + opens its page without Google; one line "connect on a computer", no Connect or Try in chat', async ({ page }) => {
      const drive = await fakeDrive(page, disconnected)
      await signIn(page, BOB)
      await openConnectors(page)
      await targets(page.getByTestId('integrations'))
      await page.getByTestId('connector-search').fill('Drive')
      const card = page.locator('[data-testid="connector-card"][data-id="google-drive"]')
      await card.getByTestId('connector-add').tap()
      await expect(page).toHaveURL(/\/connectors\/google-drive$/)
      const detail = page.getByTestId('drive-detail')
      await expect(detail.getByTestId('drive-on-computer')).toHaveText(tr('integrations.onComputer', { name: 'Google Drive' }))
      await expect(detail.getByTestId('app-actions')).toHaveCount(0)
      for (const id of ['drive-connect', 'drive-try', 'drive-menu', 'drive-waiting', 'drive-disconnect']) await expect(page.getByTestId(id)).toHaveCount(0)
      await expect(detail.locator('input, textarea, select')).toHaveCount(0)
      expect(drive.authorized).toBe(0)
      expect(await sentToApp(page)).not.toContain('external-open')
    })

    test('connected: Connected, the account and Disconnect only; Disconnect then leaves the one line', async ({ page }) => {
      const drive = await fakeDrive(page, connected)
      await signIn(page, BOB)
      await openConnectors(page)
      await page.locator('[data-testid="connected-app"][data-id="google-drive"]').getByTestId('connector-row-open').tap()
      await expect(page).toHaveURL(/\/connectors\/google-drive$/)
      const detail = page.getByTestId('drive-detail')
      const actions = detail.getByTestId('app-actions')
      await expect(actions.getByTestId('drive-connected')).toHaveText(t['drive.status.connected'])
      await expect(actions.locator('button')).toHaveCount(1)
      await expect(actions.getByTestId('drive-disconnect')).toHaveText(t['drive.disconnect'])
      await expect(detail.getByTestId('drive-detail-line')).toHaveText(account.email)
      for (const id of ['drive-try', 'drive-menu', 'drive-reconnect', 'drive-on-computer']) await expect(page.getByTestId(id)).toHaveCount(0)
      expect((await box(actions.getByTestId('drive-disconnect'))).height).toBeGreaterThanOrEqual(44)
      // the page's other small links too: Show all tools, the privacy and terms links
      await targets(detail)

      await actions.getByTestId('drive-disconnect').tap()
      await page.getByTestId('dialog-confirm').tap()
      await expect(detail.getByTestId('drive-on-computer')).toBeVisible()
      await expect(detail.getByTestId('app-actions')).toHaveCount(0)
      expect(drive.disconnected).toBe(1)
      expect(drive.authorized).toBe(0)
    })

    test('needs a new sign-in: the warning, "reconnect on a computer" and Disconnect; no Reconnect button', async ({ page }) => {
      await fakeDrive(page, { ...connected, status: 'needs_reconnect' })
      await signIn(page, BOB)
      await page.goto('/connectors/google-drive')
      const detail = page.getByTestId('drive-detail')
      await expect(detail.getByTestId('drive-detail-line')).toHaveText(t['drive.status.needs_reconnect'])
      await expect(detail.getByTestId('drive-on-computer')).toHaveText(tr('integrations.reconnectOnComputer', { name: 'Google Drive' }))
      await expect(detail.getByTestId('app-actions').locator('button')).toHaveText([t['drive.disconnect']])
      for (const id of ['drive-reconnect', 'drive-menu', 'drive-try']) await expect(page.getByTestId(id)).toHaveCount(0)
    })

    test('a Google app works the same: its + opens its page without Google; connected: Settings and Disconnect', async ({ page }) => {
      expect((await page.request.post('/__test/google-apps', { data: { app: 'gmail', client: 'app' } })).ok()).toBeTruthy()
      await signIn(page, BOB)
      await openConnectors(page)
      await page.locator('[data-testid="connector-card"][data-id="gmail"]').getByTestId('connector-add').tap()
      await expect(page).toHaveURL(/\/connectors\/gmail$/)
      const detail = page.getByTestId('gapp-detail')
      await expect(detail.getByTestId('gapp-on-computer')).toHaveText(tr('integrations.onComputer', { name: 'Gmail' }))
      for (const id of ['gapp-connect', 'gapp-waiting', 'gapp-try']) await expect(page.getByTestId(id)).toHaveCount(0)
      expect(await sentToApp(page)).not.toContain('external-open')

      expect((await page.request.post('/__test/google-apps', { data: { app: 'gmail', connect: { userId: 'bob' } } })).ok()).toBeTruthy()
      await page.reload()
      await expect(detail.getByTestId('gapp-account-line')).toBeVisible()
      await expect(detail.getByTestId('app-actions').locator('button')).toHaveText([new RegExp(t['gapps.settings']), t['drive.disconnect']])
      for (const id of ['gapp-try', 'gapp-menu', 'gapp-reconnect', 'gapp-on-computer']) await expect(page.getByTestId(id)).toHaveCount(0)
    })
  })

  test('a phone\'s browser (not the app) keeps Google Drive\'s Connect', async ({ page }) => {
    await fakeDrive(page, disconnected)
    await signIn(page, BOB)
    await page.goto('/connectors/google-drive')
    await expect(page.getByTestId('drive-connect')).toBeVisible()
    await expect(page.getByTestId('drive-on-computer')).toHaveCount(0)
  })

  test('Admin › Connectors: "Show all →" takes a 44 px tap', async ({ page }) => {
    await signIn(page)
    await page.goto('/admin/connectors')
    const all = page.getByTestId('connector-show-all')
    await expect(all).toBeVisible()
    expect((await box(all)).height).toBeGreaterThanOrEqual(44)
    await all.tap()
    await expect(all).toHaveAttribute('aria-expanded', 'true')
    expect((await box(all)).height).toBeGreaterThanOrEqual(44)
  })

  for (const width of [820, 1440]) {
    test.describe(`a ${width} px screen`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: false, hasTouch: false })
      test('Settings › Connectors: the section in Settings\' column, its name as a heading, the list beside it', async ({ page }) => {
        await signIn(page)
        await page.goto('/settings/connectors')
        await expect(page.getByTestId('connector-discover')).toBeVisible()
        const header = page.getByTestId('connectors-header')
        await expect(page.getByTestId('settings-content').getByTestId('connectors-header')).toBeVisible()
        await expect(header.getByRole('heading', { name: t['integrations.title'], exact: true })).toBeVisible()
        await expect(header.getByTestId('connector-search')).toBeInViewport()
        await expect(page.getByTestId('settings-menu')).toBeVisible()
        // nothing scrolls sideways
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      })
    })
  }
}
