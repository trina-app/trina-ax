import { expect, test } from '@playwright/test'
import { OWNER, reset, signIn, watchConsole } from './helpers'

// first-run setup starts in the browser's language when none was picked (89e32d5, the office's own Mac): these two
// run in an English browser
test.describe('first-run setup in an English browser', () => {
  test.use({ locale: 'en-US' })

  test('first-run setup is in English; the owner picks the team language and follows it', async ({ page }) => {
    // a fresh install: no team default stored yet and an English browser, so English
    await reset(page, { setup: true, teamLocale: 'en' })
    await page.goto('/')
    await expect(page).toHaveURL(/\/setup/)
    await expect(page.getByRole('heading', { name: 'Create your team' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByTestId('setup-locale')).toHaveValue('en')
    // the team language is the language on screen: picking Korean switches the page at once
    await page.getByTestId('setup-locale').selectOption('ko')
    await expect(page.getByRole('heading', { name: '팀 만들기' })).toBeVisible()
    await page.getByLabel('설치 토큰').fill('setup-token-0123456789')
    await page.getByTestId('setup-team').fill('Acme Korea')
    await page.getByLabel('이름', { exact: true }).fill('Kim Owner')
    await page.getByLabel('아이디').fill('kim')
    await page.getByLabel('비밀번호', { exact: true }).fill('a long password 1')
    await page.getByLabel('비밀번호 확인').fill('a long password 1')
    await page.getByRole('button', { name: '팀 만들고 시작하기' }).click()
    await expect(page.getByRole('heading', { name: /Kim Owner님/ })).toBeVisible()
    await expect(page.getByTestId('owner-checklist')).toBeVisible()
    // the starting folder rules come with every team: "set folder permissions" is still to do
    await expect(page.getByTestId('owner-checklist').getByRole('link', { name: '할 일 폴더 권한 정하기' })).toBeVisible()
    // the owner has no language of their own: "team default (한국어)" is the chosen one
    await page.goto('/settings/profile')
    await expect(page.getByTestId('locale-team')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('locale-team')).toContainText('팀 기본값 (한국어)')
  })

  test('first-run setup left in English makes an English team', async ({ page }) => {
    await reset(page, { setup: true, teamLocale: 'en' })
    await page.goto('/')
    await page.getByLabel('Setup token').fill('setup-token-0123456789')
    await page.getByTestId('setup-team').fill('Acme')
    await page.getByLabel('Name', { exact: true }).fill('Kim Owner')
    await page.getByLabel('Username').fill('kim')
    await page.getByLabel('Password', { exact: true }).fill('a long password 1')
    await page.getByLabel('Confirm password').fill('a long password 1')
    await page.getByRole('button', { name: 'Create team and start' }).click()
    await expect(page.getByRole('heading', { name: 'How can I help you, Kim Owner?' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
  })
})

test.describe('first-run setup in a browser in Jakarta', () => {
  test.use({ locale: 'en-US', timezoneId: 'Asia/Jakarta' })
  test('the team\'s time zone starts as the browser\'s', async ({ page }) => {
    await reset(page, { setup: true, teamLocale: 'en' })
    await page.goto('/')
    await page.getByLabel('Setup token').fill('setup-token-0123456789')
    await page.getByTestId('setup-team').fill('Acme')
    await page.getByLabel('Name', { exact: true }).fill('Kim Owner')
    await page.getByLabel('Username').fill('kim')
    await page.getByLabel('Password', { exact: true }).fill('a long password 1')
    await page.getByLabel('Confirm password').fill('a long password 1')
    await page.getByRole('button', { name: 'Create team and start' }).click()
    await expect(page.getByRole('heading', { name: 'How can I help you, Kim Owner?' })).toBeVisible()
    await page.goto('/admin/settings')
    await expect(page.getByTestId('team-time-zone')).toHaveValue('Asia/Jakarta')
  })
})

test('wrong password shows the error; sign out returns to the sign-in page', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await page.goto('/files')
  await expect(page).toHaveURL(/\/login\?next=%2Ffiles/)
  await page.getByTestId('login-username').fill(OWNER.username)
  await page.getByTestId('login-password').fill('nope')
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('alert')).toContainText('비밀번호')
  await page.getByTestId('login-password').fill(OWNER.password)
  await page.getByTestId('login-submit').click()
  // back to where the person wanted to go
  await expect(page).toHaveURL(/\/files/)
  await page.getByTestId('account-menu').click()
  await page.getByTestId('logout').click()
  await expect(page).toHaveURL(/\/login/)
  expect(errors.filter((e) => !/401|status of 4\d\d/.test(e))).toEqual([])
})

test('an invite link creates an account', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  await page.getByTestId('invite-create').click()
  const link = await page.getByTestId('secret-value').innerText()
  expect(link).toMatch(/\/invite\/inv[0-9a-f]+$/)
  const other = await browser.newContext()
  const p2 = await other.newPage()
  await p2.goto(link)
  await expect(p2.getByRole('heading', { name: 'Acme 팀에 참여하기' })).toBeVisible()
  await p2.getByTestId('invite-name').fill('New Person')
  // the username rule is checked while typing (a space, "!"), not by a browser bubble after the button
  await p2.getByTestId('invite-username').fill('new bie!')
  await expect(p2.getByTestId('invite-username')).toHaveAttribute('aria-invalid', 'true')
  await expect(p2.getByRole('alert')).toContainText('영문·숫자와')
  await p2.getByTestId('invite-username').fill('newbie')
  await expect(p2.getByTestId('invite-username')).not.toHaveAttribute('aria-invalid', 'true')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-password2').fill('another password 1')
  await p2.getByTestId('invite-submit').click()
  await expect(p2.getByRole('heading', { name: /New Person님/ })).toBeVisible()
  // the used link is now invalid
  await p2.context().clearCookies()
  await p2.goto(link)
  await expect(p2.getByText('만료됐거나 이미 사용됐어요')).toBeVisible()
  await other.close()
})

test('language switch to English and Indonesian', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/profile')
  await page.getByTestId('locale-en').click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
  await page.getByTestId('locale-id').click()
  await expect(page.getByRole('heading', { name: 'Pengaturan' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'id')
})

test('the sign-in page shows the team default, a pick on it is kept in this browser and wins until sign-in', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByTestId('auth-locale')).toHaveValue('en')
  // each language is named in its own language
  await expect(page.getByTestId('auth-locale').locator('option')).toHaveText(['English', '한국어', 'Bahasa Indonesia', '日本語', 'Español'])
  await page.getByTestId('auth-locale').selectOption('id')
  await expect(page.getByRole('heading', { name: 'Masuk' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Masuk' })).toBeVisible()
  // a server message before sign-in follows the page, not the browser
  await page.getByTestId('login-username').fill(OWNER.username)
  await page.getByTestId('login-password').fill('nope')
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('alert')).toContainText('kata sandi salah')
  // signed in, the person's language decides: olga has none, so the team default (English)
  await page.getByTestId('login-password').fill(OWNER.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
})

test('personal setting: team default, an own language, back to the team default; an admin change reaches followers', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/settings/profile')
  await expect(page.getByTestId('locale-team')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('locale-team')).toHaveText('Team default (English)')
  await page.getByTestId('locale-ko').click()
  await expect(page.getByRole('heading', { name: '설정' })).toBeVisible()
  await expect(page.getByTestId('locale-ko')).toHaveAttribute('aria-checked', 'true')
  await page.reload()
  await expect(page.getByRole('heading', { name: '설정' })).toBeVisible()
  await page.getByTestId('locale-team').click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  // the admin sets the team default to Indonesian: olga follows it at once
  await page.goto('/admin/settings')
  await page.getByTestId('team-default-locale').selectOption('id')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'id')
  await page.goto('/settings/profile')
  await expect(page.getByTestId('locale-team')).toHaveText('Bawaan tim (Bahasa Indonesia)')
})

test('a language picked before sign-in becomes the account’s own, also through the forced password change', async ({ page }) => {
  // bob follows the English team default and signs in with a temporary password
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, mustChange: 'bob' })
  await page.goto('/login')
  await page.getByTestId('auth-locale').selectOption('ko')
  await page.getByTestId('login-username').fill('bob')
  await page.getByTestId('login-password').fill('bob password 1')
  await page.getByTestId('login-submit').click()
  // the next screen keeps the pick (the account can only be changed once the password is)
  await expect(page).toHaveURL(/\/password/)
  await expect(page.getByRole('heading', { name: '비밀번호 바꾸기' })).toBeVisible()
  await expect(page.getByTestId('auth-locale')).toHaveValue('ko')
  // right after signing in with the temporary password only the new one is asked (not the temporary one again)
  await expect(page.getByLabel('임시 비밀번호')).toHaveCount(0)
  await expect(page.getByTestId('password-current')).toHaveCount(0)
  await expect(page.getByText('앞으로 쓸 새 비밀번호를 정해 주세요')).toBeVisible()
  await page.getByLabel('새 비밀번호').fill('a brand new password 2')
  await page.getByLabel('비밀번호 확인').fill('a brand new password 2')
  await page.getByRole('button', { name: '비밀번호 바꾸기' }).click()
  await expect(page.getByRole('heading', { name: 'Bob님, 무엇을 도와드릴까요?' })).toBeVisible()
  // saved to the account: it survives a reload and shows as bob's own choice
  await page.goto('/settings/profile')
  await expect(page.getByTestId('locale-ko')).toHaveAttribute('aria-checked', 'true')
})

test('an error on the sign-in page follows a language switch; signing out shows the team default again', async ({ page }) => {
  // olga has her own language (Korean); the team default is English
  await reset(page, { teamLocale: 'en' })
  await page.goto('/login')
  await page.getByTestId('login-username').fill(OWNER.username)
  await page.getByTestId('login-password').fill('nope')
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.')
  // the server's sentence can't be redrawn in Korean: it goes instead of staying in English
  await page.getByTestId('auth-locale').selectOption('ko')
  await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  // back to English for this browser, then sign in: olga's own Korean wins
  await page.getByTestId('auth-locale').selectOption('en')
  await page.getByTestId('login-password').fill(OWNER.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('button', { name: '새 채팅' })).toBeVisible()
  // signed out, the sign-in page is in this browser's pick (English), not olga's language
  await page.getByTestId('account-menu').click()
  await page.getByTestId('logout').click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('open windows of people who follow the team switch when an admin changes the team default', async ({ page, context }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const other = await context.newPage()
  await other.goto('/settings/profile')
  await expect(other.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.goto('/admin/settings')
  await page.getByTestId('team-default-locale').selectOption('ko')
  await page.getByRole('button', { name: 'Save' }).click()
  // the other window was not reloaded
  await expect(other.getByRole('heading', { name: '설정' })).toBeVisible()
  await expect(other.getByTestId('locale-team')).toHaveText('팀 기본값 (한국어)')
})

// The app shell is available (as with Electron's cached reload), but account lookup cannot reach the server.
for (const locale of ['ko', 'en', 'id'] as const) {
  test(`${locale}: reload and retry keep the account language when the team API is unreachable`, async ({ page }) => {
    await reset(page, { teamLocale: locale === 'ko' ? 'en' : locale, usersFollowTeam: locale !== 'ko' })
    await signIn(page)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    expect(await page.evaluate(() => localStorage.getItem('mycel.locale'))).toBeNull()
    await page.route('**/api/me', route => route.abort('internetdisconnected'))
    await page.reload()
    const text = {
      ko: { error: '팀 서버에 연결할 수 없어요', retry: '다시 시도' },
      en: { error: "Can't reach the team server", retry: 'Try again' },
      id: { error: 'Server tim tidak bisa dihubungi', retry: 'Coba lagi' },
    }[locale]
    await expect(page.getByText(text.error, { exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await page.getByRole('button', { name: text.retry, exact: true }).click()
    await expect(page.getByText(text.error, { exact: true })).toBeVisible()
    await page.unroute('**/api/me')
    await page.getByRole('button', { name: text.retry, exact: true }).click()
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
  })
}

test('recovery does not replace an old login pick or pass a previous account language to another person', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await page.goto('/login')
  await page.getByTestId('auth-locale').selectOption('id')
  // An old pick is not adopted as an account preference.
  await page.reload()
  await signIn(page)
  await page.goto('/settings/profile')
  await page.getByTestId('locale-ko').click()
  await expect(page.getByTestId('locale-ko')).toHaveAttribute('aria-checked', 'true')
  await page.route('**/api/me', route => route.abort('internetdisconnected'))
  await page.reload()
  await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('mycel.locale'))).toBe('id')
  await page.unroute('**/api/me')
  await page.getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(page.getByTestId('locale-ko')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('logout').click()
  await expect(page.getByRole('heading', { name: 'Masuk' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('mycel.recentLocale'))).toBeNull()
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.goto('/settings/profile')
  await expect(page.getByTestId('locale-team')).toHaveAttribute('aria-checked', 'true')
})

test('recovery language is isolated by team origin', async ({ page, context, baseURL }) => {
  await reset(page, { teamLocale: 'en' })
  await signIn(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  const otherOrigin = new URL(baseURL!)
  otherOrigin.hostname = 'localhost'
  const other = await context.newPage()
  await other.goto(otherOrigin.href)
  await expect(other.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(await other.evaluate(() => localStorage.getItem('mycel.recentLocale'))).toBeNull()
  await other.route('**/api/me', route => route.abort('internetdisconnected'))
  await other.reload()
  await expect(other.getByText("Can't reach the team server", { exact: true })).toBeVisible()
  await page.route('**/api/me', route => route.abort('internetdisconnected'))
  await page.reload()
  await expect(page.getByText('팀 서버에 연결할 수 없어요', { exact: true })).toBeVisible()
})

test('blocked storage falls back safely on an unavailable account lookup', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get: () => { throw new DOMException('Blocked', 'SecurityError') } })
  })
  await reset(page)
  await signIn(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await page.route('**/api/me', route => route.abort('internetdisconnected'))
  await page.reload()
  await expect(page.getByText("Can't reach the team server", { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await page.unroute('**/api/me')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
})
