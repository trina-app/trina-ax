// Screen states a non-technical team meets (tab 5 "상태별 화면"): the DEV banner, a member's first screen, a link to a
// folder they cannot see, an old settings link, and a chat whose AI waits for an answer while they are elsewhere.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }

test('a server in DEV mode says so on every screen, and the banner cannot be closed', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const banner = page.getByTestId('dev-banner')
  await expect(banner).toContainText('개발 모드: OS 격리 없음')
  await expect(banner.getByRole('button')).toHaveCount(0)
  for (const p of ['/files', '/admin/members', '/settings']) {
    await page.goto(p)
    await expect(banner).toBeVisible()
  }
})

test("a member's first screen shows their own folder, not the users/ folder that only leads to it", async ({ page }) => {
  await reset(page)
  await signIn(page, BOB)
  const card = page.getByTestId('first-time-folders')
  await expect(card).toContainText('내 폴더')
  await expect(card.getByRole('listitem').filter({ hasText: /^users/ })).toHaveCount(0)
  await expect(card.getByRole('listitem').filter({ hasText: '내 폴더' })).toHaveAttribute('title', 'users/bob')
  await expect(card.getByRole('listitem').filter({ hasText: '내 폴더' })).toContainText('쓰기 가능')
  // no example asks about "users"
  for (const text of await page.getByTestId('example').allInnerTexts()) expect(text).not.toMatch(/(^|\s)users 폴더/)
})

test('a link to a folder that does not exist (or is hidden) says so once and opens the nearest visible folder', async ({ page }) => {
  await reset(page)
  await signIn(page, BOB)
  await page.goto('/files?path=' + encodeURIComponent('nope/a/b'))
  await expect(page.getByText('폴더를 찾을 수 없거나 볼 권한이 없어요.')).toHaveCount(1)
  await expect(page.getByText('권한이 바뀌었어요')).toHaveCount(0)
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.getByTestId('file-table')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByText('폴더를 찾을 수 없거나 볼 권한이 없어요.')).toHaveCount(1)
})

test('an unknown settings tab opens the profile instead of an empty page', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/devices')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: '프로필' })).toBeVisible()
})

async function hide(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

test('a chat whose AI waits for an answer is marked in the sidebar, and a hidden tab counts it in its title', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('please ask me something')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('ask-card')).toBeVisible()
  const row = page.getByRole('navigation').getByRole('listitem').filter({ has: page.getByTestId('needs-answer') })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('답변 필요')
  await hide(page, true)
  await expect(page).toHaveTitle(/^\(1\) /)
  await hide(page, false)
  await expect(page).toHaveTitle(/^[^(]/)
  // answered: the mark goes away
  const card = page.getByTestId('ask-card')
  await card.getByLabel('4분기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(page.getByTestId('needs-answer')).toHaveCount(0)
})

test('an answer that finishes while the tab is hidden shows "(1)" in the title until the tab is seen', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('slow answer please, slow slow slow slow slow slow slow slow slow slow')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'streaming')
  await hide(page, true)
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await expect(page).toHaveTitle(/^\(1\) /)
  await hide(page, false)
  await expect(page).toHaveTitle(/^[^(]/)
})

test('when an admin takes a folder away, the open files screen says so in words and moves to a folder still visible', async ({ page }) => {
  await reset(page)
  await signIn(page, BOB)
  await page.goto('/files?path=marketing')
  await expect(page.getByTestId('file-row').first()).toBeVisible()
  await page.request.post('/__test/revoke', { data: { path: 'marketing' } })
  // a sentence, not the bare folder list the server sends as data
  await expect(page.getByText('폴더 권한이 바뀌었어요: marketing')).toBeVisible()
  await expect(page.getByText('이 폴더에 대한 권한이 바뀌었어요.', { exact: false })).toBeVisible()
  await expect(page).toHaveURL(/\/files$/)
})

test('a password reset by an admin stays visible in the person\'s security settings', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/members')
  await page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' }).getByRole('button', { name: '비밀번호 재설정' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '비밀번호 재설정' }).click()
  await expect(page.getByTestId('secret-value')).toHaveText('reset-password-9')
  const other = await browser.newContext()
  const p2 = await other.newPage()
  await p2.goto('/login')
  await p2.getByTestId('login-username').fill('bob')
  await p2.getByTestId('login-password').fill('reset-password-9')
  await p2.getByTestId('login-submit').click()
  await p2.getByLabel('임시 비밀번호').fill('reset-password-9')
  await p2.getByLabel('새 비밀번호').fill('bob new password 2')
  await p2.getByLabel('비밀번호 확인').fill('bob new password 2')
  await p2.getByRole('button', { name: '비밀번호 바꾸기' }).click()
  await expect(p2.getByTestId('composer-input')).toBeVisible()
  await p2.goto('/settings/security')
  await expect(p2.getByTestId('last-reset')).toContainText('Olga님이')
  await expect(p2.getByTestId('last-reset')).toContainText('팀장에게 알려 주세요')
  await other.close()
})
