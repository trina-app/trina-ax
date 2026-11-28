// "Copy link" on a connect wait in the desktop app (owner 2026-11-28: Connect always opens the default browser; to
// finish in another browser or profile, copy the same address; docs/AGENTS/plan/20261128-0048-connect-copy-link.md).
// Only in the desktop app: in a browser, Connect opens a tab of this same browser, and a copied link in another browser
// has no session there (the web flow refuses it). SHOTS_DIR=<folder>: each state at 1440 and 390, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

test.use({ serviceWorkers: 'block' })
test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'clipboard and layout in Chromium'))

const WIDTHS = [{ w: 1440, h: 900 }, { w: 390, h: 844 }] as const
const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-copy'
const GO = '/api/integrations/google-drive/go?flow=fixture-flow&k=' + 'K'.repeat(43)

async function shots(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(dir, `${name}-${page.viewportSize()!.width}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** a desktop app's bridge, as much as these pages read (shared/src/desktop-bridge.ts) */
async function fakeDesktop(page: Page) {
  await page.addInitScript(() => {
    const noop = () => {}
    ;(window as unknown as { mycelDesktop: unknown }).mycelDesktop = {
      bridgeVersion: 1, appVersion: '0.20.3', platform: 'darwin',
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: 'https://acme.trina.app', fingerprintMismatch: false }), onChange: () => noop },
      notify: noop, openTeams: noop, hostLine: noop,
    }
  })
}

/** Google Drive's page waiting for Google: the start answers the go page for the desktop app, Google's page else */
async function driveWait(page: Page, o: { desktop: boolean; locale: 'ko' | 'en' }) {
  await reset(page, { teamLocale: o.locale, usersFollowTeam: true })
  if (o.desktop) await fakeDesktop(page)
  const expiresAt = '2099-01-01T00:00:00.000Z'
  await page.context().route('https://accounts.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic Google consent</p>' }))
  await page.context().route('**/api/integrations/google-drive/go**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Synthetic go page</p>' }))
  await page.route('**/api/integrations/google-drive', (r) => r.fulfill({ json: { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null } }))
  // each start a new key, as the server gives (the first one is GO)
  let starts = 0
  await page.route('**/api/integrations/google-drive/authorize', (r) => r.fulfill({ json: { flowId: 'fixture-flow', authorizationUrl: GOOGLE, expiresAt, ...(o.desktop ? { openPath: starts++ ? GO.replace(/K+$/, (k) => 'N'.repeat(k.length)) : GO } : {}) } }))
  await page.route('**/api/integrations/google-drive/flows/**', (r) => r.request().method() === 'DELETE'
    ? r.fulfill({ status: 204 })
    : r.fulfill({ json: { flowId: 'fixture-flow', state: 'pending', account: null, expiresAt, reason: null } }))
  await signIn(page)
  await page.goto('/connectors/google-drive')
  const detail = page.getByTestId('drive-detail')
  const popup = page.waitForEvent('popup')
  await detail.getByTestId('drive-connect').click()
  await (await popup).close()
  const wait = detail.getByTestId('drive-waiting')
  await expect(wait).toBeVisible()
  await page.mouse.move(0, 0)
  return wait
}

for (const vp of WIDTHS) {
  test.describe(`${vp.w} px`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h } })
    for (const locale of ['ko', 'en'] as const) {
      test(`shots: the Drive wait as it is, desktop app and browser (${locale})`, async ({ page }) => {
        const wait = await driveWait(page, { desktop: true, locale })
        await shots(page, `drive-wait-desktop-${locale}`)
        const copy = wait.getByTestId('drive-waiting-copy-link')
        if (await copy.count()) {
          // a phone's target is 44 px tall; the link never pushes the page sideways
          if (vp.w < 768) expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44)
          await copy.click()
          await expect(copy).toHaveText(DICTS[locale]['connect.copiedLink'])
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.w)
          await page.mouse.move(0, 0)
          await shots(page, `drive-wait-desktop-copied-${locale}`)
        }
        await page.context().clearCookies()
        const p2 = await page.context().newPage()
        await driveWait(p2, { desktop: false, locale })
        await shots(p2, `drive-wait-browser-${locale}`)
      })
    }
  })
}

test('desktop app: Copy link copies the address Connect opened, says it was copied, and Connect still opens the default browser', async ({ page }) => {
  const t = DICTS.en
  const wait = await driveWait(page, { desktop: true, locale: 'en' })
  const copy = wait.getByTestId('drive-waiting-copy-link')
  await expect(copy).toHaveText(t['connect.copyLink'])
  await copy.click()
  // the very address the system browser was given: the go page of this team, which names whose Drive it is
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(GO, page.url()).href)
  await expect(copy).toHaveText(t['connect.copiedLink'])
  await shots(page, 'drive-wait-desktop-copied-en')
  // Try again and Cancel stay where they were; Try again makes a new sign-in, whose link is not copied yet
  await expect(wait.getByTestId('drive-cancel')).toBeVisible()
  const again = page.waitForEvent('popup')
  await wait.getByTestId('drive-retry-wait').click()
  await (await again).close()
  await expect(copy).toHaveText(t['connect.copyLink'])
  // Cancel: the wait and its link are gone
  await wait.getByTestId('drive-cancel').click()
  await expect(page.getByTestId('drive-waiting-copy-link')).toHaveCount(0)
})

test('a browser: no Copy link (another browser has no session; the tab Connect opened is this browser)', async ({ page }) => {
  const wait = await driveWait(page, { desktop: false, locale: 'en' })
  await expect(wait.getByTestId('drive-waiting-copy-link')).toHaveCount(0)
})
