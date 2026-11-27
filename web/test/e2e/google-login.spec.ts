// Sign in with Google (server/src/auth/google-login.ts; docs/AGENTS/plan/20261122-0454-google-login.md, part A1): the
// sign-in page offers it only when the server's Google client returns to this address; Settings › Security & devices
// shows the Google account, and Connect asks for the current password first; then Google (a made-up page here) comes
// back to the server, which connects the account or signs in with it and opens the page that says how it went. The
// mock's Google rules are POST /__test/google-login (web/test/mock/server.ts googleStart, googleReturn); the real
// server's checks (binding cookie, one use, id_token, sub only) are tests/unit/a-google-login.test.ts.
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const OLGA_GOOGLE = { sub: '100', email: 'olga@acme.test' }

async function googleLogin(page: Page, o: { client?: 'here' | 'elsewhere' | null; account?: { sub: string; email: string } }) {
  const r = await page.request.post('/__test/google-login', { data: o })
  expect(r.ok()).toBeTruthy()
}

/** Google's account picker, made up: "Continue" goes back to the return address with a code, "Cancel" with
 * error=access_denied, as Google does. Returns the Google addresses the page opened. */
async function fakeGoogle(page: Page) {
  const opened: URL[] = []
  await page.context().route('https://accounts.google.com/**', (r) => {
    const u = new URL(r.request().url())
    opened.push(u)
    const back = (q: Record<string, string>) => `${u.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: u.searchParams.get('state') ?? '', ...q })}`.replace(/&/g, '&amp;')
    return r.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Google</title><a id="pick" href="${back({ code: 'synthetic-code' })}">Continue</a> <a id="cancel" href="${back({ error: 'access_denied' })}">Cancel</a>` })
  })
  return opened
}

test('the sign-in page offers Sign in with Google only when the Google client returns to this address', async ({ page }) => {
  await reset(page, { teamLocale: 'en' })
  const errors = watchConsole(page)
  await page.goto('/login')
  await expect(page.getByTestId('login-submit')).toBeVisible()
  await expect(page.getByTestId('login-google')).toHaveCount(0)
  // a client registered for another address of the team: people here sign in with the password
  await googleLogin(page, { client: 'elsewhere' })
  await page.reload()
  await expect(page.getByTestId('login-submit')).toBeVisible()
  await expect(page.getByTestId('login-google')).toHaveCount(0)
  await googleLogin(page, { client: 'here' })
  await page.reload()
  await expect(page.getByTestId('login-google')).toHaveText(t['auth.googleSignIn'])
  await expect(page.getByText(t['auth.or'], { exact: true })).toBeVisible()
  // Google's colour "G", and Google on top: the button, "or", then the username field
  await expect(page.getByTestId('login-google').getByTestId('google-mark')).toBeVisible()
  const y = async (id: string) => (await page.getByTestId(id).boundingBox())!.y
  expect(await y('login-google')).toBeLessThan(await y('auth-or'))
  expect(await y('auth-or')).toBeLessThan(await y('login-username'))
  expect(realErrors(errors)).toEqual([])
})

test('Settings › Security & devices: the Google account, and Connect asks for the current password before Google', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'here' })
  const opened = await fakeGoogle(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/settings/security')
  await expect(page.getByRole('heading', { name: t['settings.google.title'] })).toBeVisible()
  await expect(page.getByTestId('security-google')).toContainText(t['settings.google.none'])
  await page.getByTestId('google-connect').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(t['settings.google.connectTitle'])
  await expect(dialog).toContainText(t['settings.google.connectBody'])
  // a wrong password stays in the dialog, and Google does not open
  await dialog.getByTestId('reauth-password').fill('not the password')
  await dialog.getByTestId('reauth-confirm').click()
  await expect(dialog).toContainText('The password is wrong')
  expect(opened).toHaveLength(0)
  await dialog.getByTestId('reauth-password').fill(OWNER.password)
  await dialog.getByTestId('reauth-confirm').click()
  await expect(page.locator('#pick')).toBeVisible()
  expect(opened).toHaveLength(1)
  expect(opened[0]!.searchParams.get('scope')).toBe('openid email profile')
  expect(opened[0]!.searchParams.get('redirect_uri')).toMatch(/\/api\/integrations\/google-drive\/callback$/)
  // the browser logs the wrong password's 403; nothing else
  expect(realErrors(errors).filter((e) => !/status of 403/.test(e))).toEqual([])
})

test('without a Google client here, Security & devices has no Google section', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'elsewhere' })
  await signIn(page)
  await page.goto('/settings/security')
  await expect(page.getByTestId('device-name').first()).toBeVisible()
  await expect(page.getByTestId('security-google')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: t['settings.google.title'] })).toHaveCount(0)
})

test('connect, then sign in with Google in a signed-out browser; next is kept; Disconnect', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'here', account: OLGA_GOOGLE })
  await fakeGoogle(page)
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/settings/security')
  await page.getByTestId('google-connect').click()
  await page.getByTestId('reauth-password').fill(OWNER.password)
  await page.getByTestId('reauth-confirm').click()
  await page.locator('#pick').click()
  // back in Settings: said once, and ?google= is taken off the address
  await expect(page.getByText(t['settings.google.result.connected'])).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/security$/)
  await expect(page.getByTestId('google-email')).toHaveText(OLGA_GOOGLE.email)
  await expect(page.getByTestId('security-google')).toContainText(t['settings.google.neverUsed'])

  // signed out (the session cookie gone), the sign-in page with ?next= signs in with Google and opens that page
  await page.context().clearCookies()
  await page.goto(`/login?next=${encodeURIComponent('/settings/security')}`)
  await page.getByTestId('login-google').click()
  await page.locator('#pick').click()
  await expect(page).toHaveURL(/\/settings\/security$/)
  await expect(page.getByTestId('google-email')).toHaveText(OLGA_GOOGLE.email)
  await expect(page.getByTestId('security-google')).toContainText(t['settings.google.lastUsed'].split('{date}')[0]!)

  await page.getByTestId('google-disconnect').click()
  await expect(page.getByRole('dialog')).toContainText(t['settings.google.disconnectBody'])
  await page.getByRole('dialog').getByRole('button', { name: t['settings.google.disconnect'] }).click()
  await expect(page.getByText(t['settings.google.disconnected'])).toBeVisible()
  await expect(page.getByTestId('security-google')).toContainText(t['settings.google.none'])
  expect(realErrors(errors)).toEqual([])
})

test('a Google account nobody connected signs nobody in, whatever its e-mail; a cancel at Google says so', async ({ page }) => {
  await reset(page, { teamLocale: 'en' })
  // the owner's own address on another Google account: never matched by e-mail
  await googleLogin(page, { client: 'here', account: { sub: '999', email: OLGA_GOOGLE.email } })
  await fakeGoogle(page)
  await page.goto('/login?next=%2Frooms')
  await page.getByTestId('login-google').click()
  await page.locator('#pick').click()
  await expect(page).toHaveURL(/\/login\?google=not_connected&next=%2Frooms$/)
  await expect(page.getByTestId('login-google-result')).toHaveText(t['auth.google.not_connected'])
  await expect(page.getByTestId('login-username')).toBeVisible()

  await page.getByTestId('login-google').click()
  await page.locator('#cancel').click()
  await expect(page.getByTestId('login-google-result')).toHaveText(t['auth.google.cancelled'])
})

test('a phone: Security & devices lists the Google account with Connect', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'here' })
  await signIn(page)
  await page.goto('/settings/security')
  await expect(page.getByTestId('security-google')).toContainText(t['settings.google.title'])
  await expect(page.getByTestId('google-connect')).toHaveText(t['settings.google.connect'])
  // the whole row is the button
  await page.getByTestId('google-connect').click()
  await expect(page.getByRole('dialog')).toContainText(t['settings.google.connectTitle'])
})
