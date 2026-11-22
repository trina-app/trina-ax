// Sign up with Google (server/src/auth/google-signup.ts; docs/AGENTS/plan/20261122-0756-google-signup.md): the setup page
// offers Start with Google, the invite and team link pages Join with Google, only where the server says so
// (googleSignUp). The setup page checks only the team's part before Google; a join page only the name and the username.
// Google's return (a made-up Google page here) signs in, or comes back to the page with ?google=<result>: the invite
// page through /invite (the token is never in that address), with what was typed kept, so a taken username can be
// changed and tried again. The mock's Google rules are POST /__test/google-login (web/test/mock/server.ts googleStart,
// googleReturn, googleSignUp); the server's own checks are tests/unit/a-google-signup.test.ts.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const SETUP_TOKEN = 'setup-token-0123456789'

async function googleLogin(page: Page, o: { client?: 'here' | 'elsewhere' | null; account?: { sub: string; email: string; name?: string } }) {
  const r = await page.request.post('/__test/google-login', { data: o })
  expect(r.ok()).toBeTruthy()
}

/** Google's account picker, made up: "Continue" goes back to the return address with a code, "Cancel" with
 * error=access_denied. Returns the Google addresses the page opened. */
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

test('setup: Start with Google needs only the team, then makes the owner and opens the next step', async ({ page }) => {
  await reset(page, { setup: true, teamLocale: 'en' })
  await googleLogin(page, { client: 'here', account: { sub: '900', email: 'kim.owner@acme.test', name: 'Kim Owner' } })
  const opened = await fakeGoogle(page)
  const errors = watchConsole(page)
  await page.goto(`/setup#token=${SETUP_TOKEN}`)
  // the team language picked here (this browser is Korean): kept for this browser, also after Google's return
  await page.getByTestId('setup-locale').selectOption('en')
  await expect(page.getByTestId('setup-google')).toHaveText(t['setup.google'])
  await expect(page.getByText(t['setup.googleHint'])).toBeVisible()
  // the team name first; the owner's own fields are not asked for
  await page.getByTestId('setup-google').click()
  await expect(page.getByTestId('setup-section-team')).toContainText(t['auth.required'])
  expect(opened).toHaveLength(0)
  await page.getByTestId('setup-team').fill('Acme')
  // cancelled at Google: back on the setup page, which says so and still has the token
  await page.getByTestId('setup-google').click()
  await page.locator('#cancel').click()
  await expect(page).toHaveURL(/\/setup\?google=cancelled$/)
  await expect(page.getByTestId('setup-google-result')).toHaveText(t['auth.google.cancelled'])
  await page.getByTestId('setup-team').fill('Acme')
  await page.getByTestId('setup-google').click()
  expect(opened.at(-1)!.searchParams.get('scope')).toBe('openid email profile')
  await page.locator('#pick').click()
  // a Mac or Windows browser (Playwright's Desktop Chrome says Windows) is first offered the desktop app
  await expect(page).toHaveURL(/\/open-app$/)
  await page.getByTestId('open-app-browser').click()
  await expect(page).toHaveURL(/\/welcome$/)
  const me = await (await page.request.get('/api/me')).json()
  expect(me.user).toMatchObject({ username: 'kim.owner', name: 'Kim Owner', role: 'owner' })
  expect(realErrors(errors)).toEqual([])
})

test('setup: no Google client here, no Start with Google', async ({ page }) => {
  await reset(page, { setup: true, teamLocale: 'en' })
  await googleLogin(page, { client: 'elsewhere' })
  await page.goto(`/setup#token=${SETUP_TOKEN}`)
  await expect(page.getByTestId('setup-submit')).toBeVisible()
  await expect(page.getByTestId('setup-google')).toHaveCount(0)
})

test('an invite: Join with Google with the name and username; a username taken meanwhile comes back to change it', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'here', account: { sub: '901', email: 'nico@acme.test' } })
  await signIn(page)
  const made = await page.request.post('/api/admin/invites', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'member', groupIds: [] } })
  expect(made.ok()).toBe(true)
  const { token } = (await made.json()) as { token: string }
  const other = await browser.newContext({ locale: 'en-US' })
  const p2 = await other.newPage()
  const opened = await fakeGoogle(p2)
  const errors = watchConsole(p2)
  await p2.goto(`/invite/${token}`)
  await expect(p2.getByTestId('join-google')).toHaveText(t['invite.google'])
  // the name and the username first; no password
  await p2.getByTestId('join-google').click()
  await expect(p2.getByTestId('join-form')).toContainText(t['auth.required'])
  expect(opened).toHaveLength(0)
  await p2.getByTestId('invite-name').fill('Nico')
  await p2.getByTestId('invite-username').fill('nico')
  await p2.getByTestId('join-google').click()
  await expect(p2.locator('#pick')).toBeVisible()
  // someone takes "nico" while this person is at Google
  const taken = await page.request.post('/api/admin/users', { headers: { [CSRF_HEADER]: '1' }, data: { username: 'nico', name: 'Other Nico', role: 'member', groupIds: [] } })
  expect(taken.ok()).toBe(true)
  await p2.locator('#pick').click()
  // back on the same invite (never its token in Google's return address), saying so, with what was typed
  await expect(p2).toHaveURL(new RegExp(`/invite/${token}\\?google=username_taken$`))
  await expect(p2.getByTestId('join-google-result')).toHaveText(t['auth.google.username_taken'])
  await expect(p2.getByTestId('invite-name')).toHaveValue('Nico')
  await expect(p2.getByTestId('invite-username')).toHaveValue('nico')
  await p2.getByTestId('invite-username').fill('nico.g')
  await p2.getByTestId('join-google').click()
  await p2.locator('#pick').click()
  await expect(p2).toHaveURL(/\/$/)
  const me = await (await p2.request.get('/api/me')).json()
  expect(me.user).toMatchObject({ username: 'nico.g', name: 'Nico', role: 'member' })
  expect(realErrors(errors)).toEqual([])
  await other.close()
})

test('the team link: Join with Google lands on Home', async ({ page, browser }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await googleLogin(page, { client: 'here', account: { sub: '902', email: 'rosa@acme.test' } })
  await signIn(page)
  const made = await page.request.post('/api/admin/team-link', { headers: { [CSRF_HEADER]: '1' }, data: {} })
  expect(made.ok()).toBe(true)
  const { url } = ((await made.json()) as { link: { url: string } }).link
  const other = await browser.newContext({ locale: 'en-US' })
  const p2 = await other.newPage()
  await fakeGoogle(p2)
  await p2.goto(url)
  await p2.getByTestId('invite-name').fill('Rosa')
  await p2.getByTestId('invite-username').fill('rosa')
  // cancelled: back on /join, which still has the link, with what was typed
  await p2.getByTestId('join-google').click()
  await p2.locator('#cancel').click()
  await expect(p2).toHaveURL(/\/join\?google=cancelled$/)
  await expect(p2.getByTestId('join-google-result')).toHaveText(t['auth.google.cancelled'])
  await expect(p2.getByTestId('invite-username')).toHaveValue('rosa')
  await p2.getByTestId('join-google').click()
  await p2.locator('#pick').click()
  await expect(p2).toHaveURL(/\/$/)
  const me = await (await p2.request.get('/api/me')).json()
  expect(me.user).toMatchObject({ username: 'rosa', role: 'member' })
  await other.close()
})
