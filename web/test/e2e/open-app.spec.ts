// "Continue in the Mac app" (pages/OpenApp.tsx, lib/open-app.ts; docs/decisions/20261116-desktop-first-onboarding.md):
// /open-app with its one button and the line after a press, the quiet line in the welcome files step and in My files,
// and /app-signin outside the app, inside it (a stand-in desktop bridge) and with a dead code. Screenshots at 1440 and
// 390, light and dark, when OPEN_APP_SHOTS names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const dir = process.env.OPEN_APP_SHOTS
const WIDTHS = [1440, 390] as const
const SCHEMES = ['light', 'dark'] as const

async function shot(page: Page, name: string) {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
}

/** a desktop app's bridge, as much of it as these pages read (shared/src/desktop-bridge.ts) */
async function fakeDesktop(page: Page, o: { store?: boolean; locale?: string } = {}) {
  await page.addInitScript(({ store, locale }) => {
    const noop = () => {}
    ;(window as unknown as { mycelDesktop: unknown }).mycelDesktop = {
      bridgeVersion: 1, appVersion: '0.5.10', platform: 'darwin', ...(store ? { store: true } : {}), ...(locale ? { locale } : {}),
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: 'https://acme.trina.app', fingerprintMismatch: false }), onChange: () => noop },
      notify: noop,
      openTeams: noop,
      // the page draws the team address under its card (DesktopTeamLine) instead of the app's strip
      hostLine: noop,
    }
  }, { store: o.store === true, locale: o.locale ?? null })
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
      // olga's team is from before the steps were started at setup (no progress row): Home, never the steps
      await expect(p2.getByTestId('composer-input')).toBeVisible()
      await expect(p2.getByTestId('welcome-progress')).toHaveCount(0)
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

  test('/app-signin in an app signed in as someone else: refused, that person stays signed in, the code unspent', async ({ page, browser }) => {
    // login CSRF: Bob sends his own code to Olga's app (server/src/auth/app-signin.ts)
    await page.setViewportSize({ width: 1440, height: 900 })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page, { username: 'bob', password: 'bob password 1' })
    const code = await codeFor(page)
    const app = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US', viewport: { width: 1440, height: 900 } })
    const p = await app.newPage()
    await fakeDesktop(p)
    await signIn(p)
    await p.goto(`/app-signin#c=${code}`)
    await expect(p.getByRole('heading', { name: 'Someone else is signed in here' })).toBeVisible()
    await expect.poll(() => new URL(p.url()).hash).toBe('')
    await shot(p, '1440-light-9-app-signin-other-person')
    const me = await p.request.get('/api/me')
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe('olga')
    await p.getByTestId('app-signin-continue').click()
    await expect(p).not.toHaveURL(/app-signin/)
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

// A fresh owner who goes on in the app (docs/decisions/20261119-welcome-steps-in-app.md): the setup started the welcome
// steps on the server, with the link's website, so the app's /app-signin → Continue lands in them, the company profile
// step has the website, and Home keeps "Continue setup · n/5" while they are unfinished. Screenshots when
// WELCOME_SHOTS names a folder.
const welcomeDir = process.env.WELCOME_SHOTS
test.describe('a fresh owner who goes on in the Mac app', () => {
  test.use({ userAgent: MAC_CHROME, locale: 'en-US' })
  for (const width of WIDTHS) for (const scheme of SCHEMES) {
    test(`the welcome steps open in the app, the website prefilled, then Continue setup on Home · ${width} · ${scheme}`, async ({ page, browser }) => {
      const viewport = { width, height: width === 390 ? 844 : 900 }
      const snap = async (p: Page, name: string) => { if (welcomeDir) await p.screenshot({ path: `${welcomeDir}/${width}-${scheme}-${name}.png`, fullPage: true }) }
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: scheme })
      await reset(page, { setup: true, teamLocale: 'en' })
      // the account console's link, with the company website
      await page.goto('/setup#token=setup-token-0123456789&team=Acme&lang=en&site=acme.example')
      await page.getByLabel('Your name').fill('Kim Owner')
      await page.getByLabel('Username').fill('kim')
      await page.getByLabel('Password', { exact: true }).fill('a long password 1')
      // the link names the team: "Create account and start" since the setup page asks only for the owner then (#74)
      await page.getByRole('button', { name: /^Create (team|account) and start$/ }).click()
      await expect(page).toHaveURL(/\/open-app$/)
      // the server has the steps already, with the website, before /welcome was ever opened
      const progress = (await (await page.request.get('/api/onboarding/welcome')).json()).progress
      expect(progress.site).toBe('https://acme.example/')
      expect(progress.finishedAt).toBeNull()
      const code = await codeFor(page)
      // the desktop app: a new window that never saw this tab's storage
      const app = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US', viewport, colorScheme: scheme })
      const p = await app.newPage()
      await fakeDesktop(p)
      await p.goto(`/app-signin#c=${code}`)
      await p.getByTestId('app-signin-continue').click()
      // the welcome steps, at the company profile, with the website from the link
      await expect(p).toHaveURL(/\/welcome/)
      await expect(p.getByTestId('welcome-progress')).toBeVisible()
      await expect(p.getByTestId('composer-input')).toHaveCount(0)
      const siteField = p.getByTestId('profile-step-site').getByRole('textbox')
      await expect(siteField).toHaveValue('https://acme.example/')
      await snap(p, '1-app-welcome-profile-site')
      // put off: Home, and the way back to the steps stays (Home's top row, on a computer too:
      // docs/decisions/20261120-my-setup-card.md)
      await p.getByTestId('welcome-profile').getByRole('button', { name: 'Do this later' }).click()
      await expect(p.getByTestId('welcome-progress')).toBeVisible()
      await p.goto('/')
      const resume = p.getByTestId('welcome-resume-text')
      await expect(resume).toContainText('Continue setup')
      await expect(resume).toContainText(/\d\/\d/)
      await snap(p, '2-app-home-continue-setup')
      // the browser tab the owner left: the same steps, the same place
      await page.goto('/')
      await expect(page).toHaveURL(/\/welcome/)
      await expect(page.getByTestId('welcome-progress')).toBeVisible()
      await app.close()
    })
  }
})

// QA TC-5352 / TC-5072: a Linux browser was "other" and /open-app sent it Home, so it could never hand the sign-in back
test.describe('in a Linux browser', () => {
  test.use({ userAgent: LINUX_FIREFOX, locale: 'en-US', viewport: { width: 1440, height: 900 } })
  test('/open-app offers the Linux app and makes its link; no files line (no Find work files on Linux)', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/open-app')
    await expect(page.getByTestId('open-app-button')).toHaveText('Continue in the Linux app')
    await expect(page.getByTestId('auth-frame')).toContainText('the AI can use programs on this computer')
    await expect(page.getByTestId('auth-frame')).not.toContainText('find work files')
    const minted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/auth/app-signin'))
    await page.getByTestId('open-app-button').click()
    await minted
    await expect(page.getByTestId('open-app-after')).toBeVisible()
    await page.goto('/files?path=users/olga')
    // the folder has loaded (rows or its empty state), and My files has no line
    await expect(page.getByTestId('file-table').or(page.getByTestId('files-empty-upload'))).toBeVisible()
    await expect(page.getByTestId('open-app-line')).toHaveCount(0)
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

// A hosted team made from the desktop app (pages/OpenApp.tsx AppSetup, server/src/auth/setup-console.ts). The test
// server is not hosted, so the two setup calls are answered by the test (the server side is tests/unit/a-setup-console);
// this checks the real page: the claim leaves the address, the welcome, the password field of an e-mail owner, a weak
// password at the field, a failure with Try again (the preview asked again), an expired claim, and outside the app.
test.describe('/app-setup (a team made from the desktop app)', () => {
  const CLAIM = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
  const PREVIEW = { teamName: 'Acme Studio', name: 'Alex Kim', email: 'alex@example.com', google: false, username: 'alex' }
  test('welcome, password at the field, Try again after a failure, expired, outside the app', async ({ page, browser }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    const ctx = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US' })
    const p = await ctx.newPage()
    await fakeDesktop(p)
    const previews: string[] = []
    let previewAnswer: 'ok' | 'down' | 'gone' = 'down'
    await p.route('**/api/setup/console/preview', async (r) => {
      previews.push((r.request().postDataJSON() as { claim: string }).claim)
      if (previewAnswer === 'ok') return r.fulfill({ status: 200, json: PREVIEW })
      if (previewAnswer === 'gone') return r.fulfill({ status: 410, json: { error: { code: 'gone', message: 'This link has expired. Go back to the app and try again.' } } })
      return r.fulfill({ status: 503, json: { error: { code: 'unavailable', message: "The hosting service can't be reached right now. Try again in a minute." } } })
    })
    const setups: unknown[] = []
    await p.route('**/api/setup/console', (r) => { setups.push(r.request().postDataJSON()); return r.fulfill({ status: 400, json: { error: { code: 'validation', message: 'Please choose a stronger password. This password is too common.', fields: { 'body.password': 'this password is too common' } } } }) })
    await p.goto(`/app-setup#c=${CLAIM}`)
    await expect.poll(() => new URL(p.url()).hash).toBe('')
    // the hosting service was down: its own title and Try again, not "expired" or a password sign-in
    await expect(p.getByRole('heading', { name: "Couldn't finish setting up your team" })).toBeVisible()
    await expect(p.getByTestId('app-setup-login')).toHaveCount(0)
    previewAnswer = 'ok'
    await p.getByTestId('app-setup-retry').click()
    await expect(p.getByRole('heading', { name: 'Welcome to Acme Studio, Alex Kim' })).toBeVisible()
    expect(previews).toEqual([CLAIM, CLAIM])
    // the username the person never chose is said, with Copy; the name is asked, prefilled
    await expect(p.getByTestId('app-setup-username')).toContainText('Your username is alex')
    await expect(p.getByTestId('app-setup-username')).toContainText('You can also sign in with your email.')
    await expect(p.getByTestId('app-setup-copy')).toHaveText('Copy')
    await expect(p.getByTestId('app-setup-name')).toHaveValue('Alex Kim')
    await p.getByTestId('app-setup-name').fill('Alex K.')
    await expect(p.getByTestId('app-setup-continue')).toBeDisabled()
    await p.getByTestId('app-setup-password').fill('password1')
    await p.getByTestId('app-setup-continue').click()
    await expect(p.getByText('Please choose a stronger password.', { exact: false })).toBeVisible()
    expect(setups[0]).toMatchObject({ claim: CLAIM, password: 'password1', name: 'Alex K.' })
    // still on the welcome: the claim stays usable
    await expect(p.getByRole('heading', { name: 'Welcome to Acme Studio, Alex Kim' })).toBeVisible()
    await ctx.close()
    // an expired claim
    const c2 = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US' })
    const p2 = await c2.newPage()
    await fakeDesktop(p2)
    await p2.route('**/api/setup/console/preview', (r) => r.fulfill({ status: 410, json: { error: { code: 'gone', message: 'x' } } }))
    await p2.goto(`/app-setup#c=${CLAIM}`)
    await expect(p2.getByRole('heading', { name: 'This link has expired' })).toBeVisible()
    await c2.close()
    // a plain browser: nothing asked, the claim leaves the address
    const c3 = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US' })
    const p3 = await c3.newPage()
    let asked = 0
    await p3.route('**/api/setup/console/**', (r) => { asked++; return r.abort() })
    await p3.goto(`/app-setup#c=${CLAIM}`)
    await expect(p3.getByTestId('app-setup-home')).toBeVisible()
    await expect.poll(() => new URL(p3.url()).hash).toBe('')
    expect(asked).toBe(0)
    await c3.close()
  })

  // QA 0202 (desktop 0.20.2): the page was English in a Korean app; a reload said "expired"; opening the team again
  // from the app sent a new claim into the page on screen, which kept showing (and then spent) the old, revoked one
  test("the app's language; a reload goes on with the claim; a newer claim from the app replaces the one on screen", async ({ page, browser }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    const NEWER = 'BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
    const ctx = await browser.newContext({ userAgent: MAC_CHROME, locale: 'en-US' })
    const p = await ctx.newPage()
    await fakeDesktop(p, { locale: 'ko' })
    const previews: string[] = []
    await p.route('**/api/setup/console/preview', async (r) => {
      const claim = (r.request().postDataJSON() as { claim: string }).claim
      previews.push(claim)
      // the first claim is revoked once the newer one exists
      if (claim === CLAIM && previews.includes(NEWER)) return r.fulfill({ status: 410, json: { error: { code: 'gone', message: 'x' } } })
      return r.fulfill({ status: 200, json: { ...PREVIEW, teamName: claim === NEWER ? 'Acme Two' : 'Acme Studio' } })
    })
    const setups: { claim: string; locale?: string }[] = []
    await p.route('**/api/setup/console', (r) => { setups.push(r.request().postDataJSON()); return r.fulfill({ status: 400, json: { error: { code: 'validation', message: 'x', fields: { 'body.password': 'too common' } } } }) })
    await p.goto(`/app-setup#c=${CLAIM}`)
    await expect.poll(() => new URL(p.url()).hash).toBe('')
    // a Korean app, nothing picked on this page: Korean, not the team default (English)
    await expect(p.locator('html')).toHaveAttribute('lang', 'ko')
    await expect(p.getByTestId('app-setup-password')).toBeVisible()
    await expect(p.getByText('Acme Studio', { exact: false }).first()).toBeVisible()
    // a reload: the same claim, still the welcome (not "expired")
    await p.reload()
    await expect(p.getByTestId('app-setup-password')).toBeVisible()
    expect(previews).toEqual([CLAIM, CLAIM])
    // the app opens the team again: only the fragment changes, the page is not loaded again
    await p.evaluate((c) => { location.hash = `c=${c}` }, NEWER)
    await expect(p.getByText('Acme Two', { exact: false }).first()).toBeVisible()
    await expect.poll(() => new URL(p.url()).hash).toBe('')
    expect(previews).toEqual([CLAIM, CLAIM, NEWER])
    await p.getByTestId('app-setup-password').fill('password1')
    await p.getByTestId('app-setup-continue').click()
    await expect.poll(() => setups.length).toBe(1)
    // the newer claim, and the language on screen for the team
    expect(setups[0]).toMatchObject({ claim: NEWER, locale: 'ko' })
    // a reload now goes on with the newer claim
    await p.reload()
    await expect(p.getByText('Acme Two', { exact: false }).first()).toBeVisible()
    expect(previews.at(-1)).toBe(NEWER)
    await ctx.close()
  })
})
