// "Continue in the Mac app" (pages/OpenApp.tsx, lib/open-app.ts; docs/decisions/20261116-desktop-first-onboarding.md):
// /open-app with its one button and the line after a press, the quiet line in the welcome files step and in My files,
// and /app-signin outside the app, inside it (a stand-in desktop bridge) and with a dead code. Screenshots at 1440 and
// 390, light and dark, when OPEN_APP_SHOTS names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const dir = process.env.OPEN_APP_SHOTS
const WIDTHS = [1440, 390] as const
const SCHEMES = ['light', 'dark'] as const

async function shot(page: Page, name: string) {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
}

/** a desktop app's bridge, as much of it as these pages read (shared/src/desktop-bridge.ts) */
async function fakeDesktop(page: Page, o: { store?: boolean } = {}) {
  await page.addInitScript((store) => {
    const noop = () => {}
    ;(window as unknown as { mycelDesktop: unknown }).mycelDesktop = {
      bridgeVersion: 1, appVersion: '0.5.10', platform: 'darwin', ...(store ? { store: true } : {}),
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: 'https://acme.trina.app', fingerprintMismatch: false }), onChange: () => noop },
      notify: noop,
      openTeams: noop,
      // the page draws the team address under its card (DesktopTeamLine) instead of the app's strip
      hostLine: noop,
    }
  }, o.store === true)
}

/** a fresh code for olga, made by her browser's cookie session */
async function codeFor(page: Page): Promise<string> {
  const r = await page.request.post('/api/auth/app-signin', { headers: { 'x-mycel-csrf': '1' } })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { code: string }).code
}

test.describe('in a Mac browser', () => {
  test.use({ userAgent: MAC_CHROME, locale: 'en-US' })

  for (const width of WIDTHS) for (const scheme of SCHEMES) {
    test(`/open-app, the button, and the lines in the files step and My files · ${width} · ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await page.goto('/open-app')
      await expect(page.getByRole('heading', { name: /^Continue in the .+ app$/ })).toBeVisible()
      const button = page.getByTestId('open-app-button')
      await expect(button).toHaveText('Continue in the Mac app')
      await expect(page.getByTestId('open-app-browser')).toHaveText('Continue in the browser')
      // one primary action
      await expect(page.getByTestId('auth-frame').locator('button.bg-accent')).toHaveCount(1)
      await expect(page.getByTestId('open-app-after')).toHaveCount(0)
      await shot(page, `${width}-${scheme}-1-open-app`)
      // the press: a code, the app's link (the browser has no app for it here and stays), then the quiet line
      let minted = 0
      page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/auth/app-signin')) minted++ })
      await button.click()
      await expect(page.getByTestId('open-app-after')).toBeVisible()
      await expect(page.getByTestId('open-app-download')).toHaveAttribute('target', '_blank')
      await expect(page.getByTestId('open-app-after')).toContainText('If the app opened, you can close this tab.')
      await expect(page).toHaveURL(/\/open-app$/)
      await shot(page, `${width}-${scheme}-2-open-app-pressed`)
      // pressed again: a new code
      await button.click()
      await expect.poll(() => minted).toBe(2)
      // the browser instead: the welcome steps
      await page.getByTestId('open-app-browser').click()
      await expect(page).toHaveURL(/\/welcome/)
      // the files step: the quiet line under the folder buttons, leading back to /open-app
      await page.getByTestId('welcome-profile').getByRole('button', { name: 'Do this later' }).click()
      await page.getByTestId('skills-later').click()
      const line = page.getByTestId('open-app-line')
      await expect(line).toBeVisible()
      await expect(line).toContainText('Finding work files on this computer works in the Mac and Windows app.')
      await expect(page.getByTestId('welcome-team-files-computer')).toHaveCount(0)
      await shot(page, `${width}-${scheme}-3-files-step-line`)
      // My files: the same line, only at My files' top
      await page.goto('/files?path=users/olga')
      await expect(page.getByTestId('open-app-line')).toBeVisible()
      await shot(page, `${width}-${scheme}-4-my-files-line`)
      await page.goto('/files?path=shared')
      await expect(page.getByTestId('file-table')).toBeVisible()
      await expect(page.getByTestId('open-app-line')).toHaveCount(0)
      // the line leads to /open-app
      await page.goto('/files?path=users/olga')
      await page.getByTestId('open-app-line-link').click()
      await expect(page).toHaveURL(/\/open-app$/)
      // from the line, "Continue in the browser" goes back to it
      await page.getByTestId('open-app-browser').click()
      await expect(page).toHaveURL(/\/files\?path=users/)
    })

    test(`/app-signin: outside the app, inside it, expired · ${width} · ${scheme}`, async ({ page, browser }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      const code = await codeFor(page)
      // a plain browser (signed out): nothing spent, the code leaves the address at once
      const plain = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US', viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme })
      const p1 = await plain.newPage()
      await p1.goto(`/app-signin#c=${code}`)
      await expect(p1.getByRole('heading', { name: /^This link opens in the .+ app$/ })).toBeVisible()
      expect(new URL(p1.url()).hash).toBe('')
      await expect(p1.getByTestId('app-signin-home')).toBeVisible()
      await shot(p1, `${width}-${scheme}-5-app-signin-outside`)
      await plain.close()
      // inside the app (signed out there): the code signs in; who and which team, Continue, "This isn't me"
      const app = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US', viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme })
      const p2 = await app.newPage()
      await fakeDesktop(p2)
      await p2.goto(`/app-signin#c=${code}`)
      await expect(p2.getByRole('heading', { name: /^Signed in to .+ as .+$/ })).toBeVisible()
      expect(new URL(p2.url()).hash).toBe('')
      await expect(p2.getByTestId('app-signin-not-me')).toHaveText("This isn't me")
      await expect(p2.getByTestId('app-signin-store')).toHaveCount(0)
      await shot(p2, `${width}-${scheme}-6-app-signin-done`)
      await p2.getByTestId('app-signin-continue').click()
      await expect(p2).not.toHaveURL(/app-signin/)
      await expect(p2.getByTestId('composer-input').or(p2.getByTestId('welcome-progress')).first()).toBeVisible()
      // the same code again: expired, with a way to sign in
      const again = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US', viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme })
      const p3 = await again.newPage()
      await fakeDesktop(p3)
      await p3.goto(`/app-signin#c=${code}`)
      await expect(p3.getByRole('heading', { name: 'This link has expired' })).toBeVisible()
      await expect(p3.getByTestId('app-signin-login')).toBeVisible()
      await shot(p3, `${width}-${scheme}-7-app-signin-expired`)
      await p3.getByTestId('app-signin-login').click()
      await expect(p3).toHaveURL(/\/login/)
      await again.close()
      await app.close()
    })
  }

  test('/app-signin in the Mac App Store build says it cannot find files, with the download version; "This isn\'t me" signs out', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const code = await codeFor(page)
    const app = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US', viewport: { width: 1440, height: 900 } })
    const p = await app.newPage()
    await fakeDesktop(p, { store: true })
    await p.goto(`/app-signin#c=${code}`)
    await expect(p.getByTestId('app-signin-store')).toContainText("This version of the app can't find files on your computer.")
    await shot(p, '1440-light-8-app-signin-store-app')
    await p.getByTestId('app-signin-not-me').click()
    await expect(p).toHaveURL(/\/login/)
    await app.close()
  })

  test('right after setup in a Mac browser: /open-app, then the browser goes on to the welcome steps', async ({ page }) => {
    await reset(page, { setup: true, teamLocale: 'en' })
    await page.goto('/')
    await page.getByLabel('Setup code').fill('setup-token-0123456789')
    await page.getByTestId('setup-team').fill('Acme')
    await page.getByLabel('Your name').fill('Kim Owner')
    await page.getByLabel('Username').fill('kim')
    await page.getByLabel('Password', { exact: true }).fill('a long password 1')
    await page.getByRole('button', { name: 'Create team and start' }).click()
    await expect(page).toHaveURL(/\/open-app$/)
    await expect(page.getByTestId('open-app-button')).toHaveText('Continue in the Mac app')
    await page.getByTestId('open-app-browser').click()
    await expect(page).toHaveURL(/\/welcome$/)
    await expect(page.getByTestId('welcome-progress')).toBeVisible()
  })
})

test.describe('on a phone', () => {
  test.use({ userAgent: IPHONE, locale: 'en-US', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('setup goes straight to the welcome steps; /open-app is never shown; no files line', async ({ page }) => {
    await reset(page, { setup: true, teamLocale: 'en' })
    await page.goto('/')
    await page.getByLabel('Setup code').fill('setup-token-0123456789')
    await page.getByTestId('setup-team').fill('Acme')
    await page.getByLabel('Your name').fill('Kim Owner')
    await page.getByLabel('Username').fill('kim')
    await page.getByLabel('Password', { exact: true }).fill('a long password 1')
    await page.getByRole('button', { name: 'Create team and start' }).click()
    await expect(page).toHaveURL(/\/welcome/)
    await page.goto('/open-app')
    await expect(page).toHaveURL(/\/welcome/)
    await page.goto('/files?path=users/kim')
    await expect(page.getByTestId('open-app-line')).toHaveCount(0)
  })
})
