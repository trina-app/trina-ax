import { expect, test } from '@playwright/test'
import { OWNER, reset, signIn, watchConsole } from './helpers'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'

/** the sidebar's new AI chat ("Ask Trina" / "트리나에게 묻기"; the core edition says its product's name) */
const askAi = (l: 'en' | 'ko') => DICTS[l]['sidebar.askAi'].replace('{name}', PRODUCT_NAMED_AFTER_AI ? DICTS[l]['rooms.aiName'] : PRODUCT.shortName)

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
    // two groups: the team, then the owner's own account (one password field with a show switch, no second field)
    await expect(page.getByRole('group', { name: '팀', exact: true })).toBeVisible()
    const account = page.getByRole('group', { name: '내 계정 · 팀장' })
    await expect(account.getByLabel('비밀번호 확인')).toHaveCount(0)
    await expect(page.getByTestId('setup-section-team').getByLabel('팀 이름')).toBeVisible()
    await page.getByLabel('설치 토큰').fill('setup-token-0123456789')
    await page.getByTestId('setup-team').fill('Acme Korea')
    await account.getByLabel('내 이름').fill('Kim Owner')
    await account.getByLabel('아이디').fill('kim')
    await account.getByLabel('비밀번호', { exact: true }).fill('a long password 1')
    await expect(page.getByTestId('setup-password')).toHaveAttribute('type', 'password')
    await account.getByRole('button', { name: '비밀번호 보기' }).click()
    await expect(page.getByTestId('setup-password')).toHaveAttribute('type', 'text')
    await page.getByRole('button', { name: '팀 만들고 시작하기' }).click()
    // the new team's owner goes to the welcome steps first (pages/Welcome.tsx); the sidebar's setup row then offers to
    // continue them on every other page (docs/DECISIONS.md "W5")
    await expect(page).toHaveURL(/\/welcome$/)
    // five steps (도구 연결 and the invite counted), and nothing above the first (no team question: every team gets its
    // start when it is left); no setup row on the steps themselves
    await expect(page.getByTestId('welcome-progress')).toContainText('1/5 회사 소개')
    await expect(page.getByTestId('welcome-progress')).toContainText('4/5 도구 연결')
    await expect(page.getByTestId('welcome-progress')).toContainText('5/5 팀원 초대')
    await expect(page.getByTestId('welcome-pack-line')).toHaveCount(0)
    await expect(page.getByTestId('setup-row')).toHaveCount(0)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Kim Owner님/ })).toBeVisible()
    // a computer: the sidebar's row stands for the steps (Home has no row of its own there)
    await expect(page.getByTestId('setup-row-link')).toContainText('설정 이어서 하기')
    await expect(page.getByTestId('setup-row-count')).toHaveText('· 0/5')
    await expect(page.getByTestId('welcome-resume')).toHaveCount(0)
    // the steps are the owner's checklist while unfinished: Admin › Home's own checklist hides
    await expect(page.getByTestId('owner-checklist')).toHaveCount(0)
    await page.goto('/admin')
    await expect(page.getByTestId('owner-checklist')).toHaveCount(0)
    await expect(page.getByTestId('owner-setup')).toHaveCount(0)
    // ✕ hides the row (undo in its toast); Admin › Home's "시작 설정 다시 보기" brings it back
    await page.getByTestId('setup-row-hide').click()
    await expect(page.getByTestId('setup-row')).toHaveCount(0)
    await page.getByTestId('owner-setup-show').click()
    await expect(page.getByTestId('setup-row-link')).toBeVisible()
    await expect(page.getByTestId('owner-setup')).toHaveCount(0)
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
    await page.getByLabel('Your name').fill('Kim Owner')
    await page.getByLabel('Username').fill('kim')
    await page.getByLabel('Password', { exact: true }).fill('a long password 1')
    await page.getByRole('button', { name: 'Create team and start' }).click()
    await expect(page).toHaveURL(/\/welcome$/)
    await expect(page.getByTestId('welcome-progress')).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'How can I help you, Kim Owner?' })).toBeVisible()
    // the sidebar under the Settings dialog speaks English too
  await expect(page.getByTestId('new-chat')).toContainText(askAi('en'))
  })
})

// coming back resumes the welcome steps (docs/DECISIONS.md "W4"): a landing on Home, once per tab session, never a link
// elsewhere, never for anyone but the owner
test('the owner who left the steps lands on them when signing in again (a phone too); 나중에 하기 stays Home; a link elsewhere is kept', async ({ page, browser }) => {
  await reset(page, { setup: true })
  await page.goto('/')
  await page.getByLabel('설치 토큰').fill('setup-token-0123456789')
  await page.getByTestId('setup-team').fill('Acme')
  await page.getByTestId('setup-name').fill('Kim Owner')
  await page.getByTestId('setup-username').fill('kim')
  await page.getByTestId('setup-password').fill('a long password 1')
  await page.getByTestId('setup-submit').click()
  await expect(page).toHaveURL(/\/welcome$/)
  // the first visit starts the progress on the server
  await expect(page.getByTestId('welcome-progress')).toContainText('1/5 회사 소개')
  // the same tab: Home stays Home (the steps were on screen here), the sidebar's setup row leads back
  await page.goto('/')
  await expect(page.getByTestId('setup-row-link')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('setup-row-link')).toBeVisible()
  await expect(page).not.toHaveURL(/\/welcome/)
  const signInAs = async (p: typeof page, path = '/') => {
    await p.goto(path)
    await p.getByTestId('login-username').fill('kim')
    await p.getByTestId('login-password').fill('a long password 1')
    await p.getByTestId('login-submit').click()
  }
  // a new session on a computer: signing in lands on the steps where they stopped
  const desk = await browser.newContext({ locale: 'ko-KR' })
  const p2 = await desk.newPage()
  await signInAs(p2)
  await expect(p2).toHaveURL(/\/welcome$/)
  await expect(p2.getByTestId('welcome-progress')).toContainText('1/5 회사 소개')
  // opening Home again in that tab: Home, with the setup row
  await p2.goto('/')
  await expect(p2.getByTestId('setup-row-link')).toBeVisible()
  await expect(p2).not.toHaveURL(/\/welcome/)
  // the row leads back to the step
  await p2.getByTestId('setup-row-link').click()
  await expect(p2).toHaveURL(/\/welcome$/)
  await expect(p2.getByTestId('welcome-progress')).toContainText('1/5 회사 소개')
  await desk.close()
  // a phone's sign-in lands on the steps too (not the 대화 list)
  const phone = await browser.newContext({ locale: 'ko-KR', viewport: { width: 390, height: 844 } })
  const p3 = await phone.newPage()
  await signInAs(p3)
  await expect(p3).toHaveURL(/\/welcome$/)
  await phone.close()
  // a link to somewhere else is kept: signed out on /files, signing in goes there
  const link = await browser.newContext({ locale: 'ko-KR' })
  const p4 = await link.newPage()
  await signInAs(p4, '/files')
  await expect(p4).toHaveURL(/\/files/)
  await p4.waitForTimeout(500)
  await expect(p4).not.toHaveURL(/\/welcome/)
  await link.close()
})

test.describe('first-run setup in a browser in Jakarta', () => {
  test.use({ locale: 'en-US', timezoneId: 'Asia/Jakarta' })
  test('the team\'s time zone starts as the browser\'s', async ({ page }) => {
    await reset(page, { setup: true, teamLocale: 'en' })
    await page.goto('/')
    await page.getByLabel('Setup token').fill('setup-token-0123456789')
    await page.getByTestId('setup-team').fill('Acme')
    await page.getByLabel('Your name').fill('Kim Owner')
    await page.getByLabel('Username').fill('kim')
    await page.getByLabel('Password', { exact: true }).fill('a long password 1')
    await page.getByRole('button', { name: 'Create team and start' }).click()
    await expect(page).toHaveURL(/\/welcome$/)
    await expect(page.getByTestId('welcome-progress')).toBeVisible()
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
  // the sidebar under the Settings dialog speaks English too
  await expect(page.getByTestId('new-chat')).toContainText(askAi('en'))
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
  // the sidebar under the Settings dialog speaks English too
  await expect(page.getByTestId('new-chat')).toContainText(askAi('en'))
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

test('a link opened with a temporary password: after the new password, the page it asked for (not Home)', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, mustChange: 'bob' })
  // a link from a chat app that needs signing in (a Slack "link your account" link works the same way)
  await page.goto('/scheduled')
  await expect(page).toHaveURL(/\/login\?next=%2Fscheduled$/)
  await page.getByTestId('login-username').fill('bob')
  await page.getByTestId('login-password').fill('bob password 1')
  await page.getByTestId('login-submit').click()
  await expect(page).toHaveURL(/\/password\?next=%2Fscheduled$/)
  // signed in, still to change it: an address opened now goes along too; one that holds a token never does
  await page.goto('/invite/abcdefghijklmnop')
  await expect(page).toHaveURL(/\/password$/)
  await page.goto('/scheduled')
  await expect(page).toHaveURL(/\/password\?next=%2Fscheduled$/)
  await page.getByTestId('password-new').fill('a brand new password 2')
  await page.getByTestId('password-new2').fill('a brand new password 2')
  await page.getByTestId('password-submit').click()
  await expect(page).toHaveURL(/\/scheduled$/)
})

test('an error on the sign-in page stays after a language switch; signing out shows the team default again', async ({ page }) => {
  // olga has her own language (Korean); the team default is English
  await reset(page, { teamLocale: 'en' })
  await page.goto('/login')
  await page.getByTestId('login-username').fill(OWNER.username)
  await page.getByTestId('login-password').fill('nope')
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.')
  // the server's sentence can't be redrawn in Korean: it stays as it was said instead of vanishing
  await page.getByTestId('auth-locale').selectOption('ko')
  await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.')
  // back to English for this browser, then sign in: olga's own Korean wins
  await page.getByTestId('auth-locale').selectOption('en')
  await page.getByTestId('login-password').fill(OWNER.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('button', { name: askAi('ko') })).toBeVisible()
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
  // Settings is a dialog over the page: close it to reach the account menu
  await page.keyboard.press('Escape')
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
