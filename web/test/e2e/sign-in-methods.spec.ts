// Admin › Sign-in methods (web/src/pages/admin/SignInMethods.tsx; docs/decisions/20261127-google-signin-selfhost.md):
// the Password row, the Google row with its switch and one status line (through the hosting service's sign-in service,
// the company's own Google app, or why not, with "How" for a server without a public web address), the optional
// domains and "Try it", which goes to Google (a made-up page here) and back to a page naming the account. The real
// server's rules (hd, the try flow, the broker) are tests/unit/a-google-login*.test.ts.
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const fill = (s: string) => s.replace('{product}', 'Trina AX')

async function googleLogin(page: Page, o: Record<string, unknown>) {
  const r = await page.request.post('/__test/google-login', { data: o })
  expect(r.ok()).toBeTruthy()
}

test('the page: Password, then Google with its switch, status line, domains and Try it; Team settings has no Google row', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'here', via: 'service' })
  const errors = watchConsole(page)
  await signIn(page)
  await page.goto('/admin/sign-in')
  await expect(page.getByTestId('sign-in-password')).toContainText(t['signIn.passwordDesc'])
  const google = page.getByTestId('sign-in-google')
  await expect(google).toHaveAttribute('data-on', 'true')
  await expect(page.getByTestId('sign-in-google-status')).toHaveText(fill(t['signIn.via.service']))
  // Password first, then Google
  const y = async (id: string) => (await page.getByTestId(id).boundingBox())!.y
  expect(await y('sign-in-password')).toBeLessThan(await y('sign-in-google'))
  // the menu has the page, under People
  await expect(page.getByTestId('admin-menu').getByRole('link', { name: t['admin.signIn'] })).toHaveAttribute('aria-current', 'page')
  // the switch saves as it is flipped
  await google.getByText(t['signIn.google'], { exact: true }).first().click()
  await expect(google).toHaveAttribute('data-on', 'false')
  expect((await (await page.request.get('/api/admin/settings')).json()).googleSignIn).toBe(false)
  await google.getByText(t['signIn.google'], { exact: true }).first().click()
  await expect(google).toHaveAttribute('data-on', 'true')
  // domains: a wrong one says so and saves nothing; a good list is saved lower case, each once
  const input = page.getByTestId('sign-in-google-domains-input')
  await input.fill('not a domain')
  await page.getByTestId('sign-in-google-domains-save').click()
  await expect(page.getByTestId('sign-in-google-domains-hint')).toHaveText(t['signIn.domainsBad'].replace('{value}', 'not'))
  await input.fill('@Acme.com, acme.com b.acme.com')
  await page.getByTestId('sign-in-google-domains-save').click()
  await expect(input).toHaveValue('acme.com, b.acme.com')
  expect((await (await page.request.get('/api/admin/settings')).json()).googleSignInDomains).toEqual(['acme.com', 'b.acme.com'])
  // Team settings no longer has the Google row, nor its "Set up on the Google Drive page"
  await page.goto('/admin/settings')
  await expect(page.getByTestId('team-settings-ai')).toBeVisible()
  await expect(page.getByTestId('team-google-sign-in')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('Try it: Google, then a page that names the account; Back returns to the page', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'here', via: 'own', account: { sub: '500', email: 'olga@acme.com', hd: 'acme.com' } })
  await page.context().route('https://accounts.google.com/**', (r) => {
    const u = new URL(r.request().url())
    const back = `${u.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: u.searchParams.get('state') ?? '', code: 'synthetic-code' })}`.replace(/&/g, '&amp;')
    return r.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Google</title><a id="pick" href="${back}">Continue</a>` })
  })
  await signIn(page)
  await page.goto('/admin/sign-in')
  await expect(page.getByTestId('sign-in-google-status')).toHaveText(t['signIn.via.own'])
  await page.getByTestId('sign-in-google-try').click()
  await page.locator('#pick').click()
  await expect(page.getByRole('status')).toContainText('olga@acme.com')
  await page.getByTestId('google-try-back').click()
  await expect(page.getByTestId('sign-in-google')).toBeVisible()
})

test('no Google client: the status says why, "How" for a server without a public web address, no domains or Try it', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: null, reason: 'no_address' })
  await signIn(page)
  await page.goto('/admin/sign-in')
  await expect(page.getByTestId('sign-in-google')).toHaveAttribute('data-client', 'none')
  await expect(page.getByTestId('sign-in-google-status')).toContainText(t['signIn.reason.no_address'])
  await expect(page.getByTestId('sign-in-google-how')).toHaveAttribute('href', /sign-in-with-google/)
  await expect(page.getByTestId('sign-in-google-domains')).toHaveCount(0)
  await expect(page.getByTestId('sign-in-google-try')).toHaveCount(0)
  await googleLogin(page, { reason: 'unreachable' })
  await page.reload()
  await expect(page.getByTestId('sign-in-google-status')).toHaveText(fill(t['signIn.reason.unreachable']))
})

test('a phone: the Admin list has Sign-in methods, which opens the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'here', via: 'service' })
  await signIn(page)
  await page.goto('/admin')
  await page.getByRole('link', { name: t['admin.signIn'] }).click()
  await expect(page.getByTestId('sign-in-google')).toBeVisible()
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['admin.signIn'])
})
