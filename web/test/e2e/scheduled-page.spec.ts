// Scheduled tasks in the sidebar (pages/Scheduled.tsx, like Claude's "Scheduled"): the sidebar item, the list of cards
// with search and "New task", a task's page (its top line and menu, the switch, the history, what it is), old Settings
// links that land there, the phone layout, and no serious accessibility problems in either theme.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function task(page: Page, data: Record<string, unknown> = {}) {
  expect((await page.request.post('/__test/schedule', { data })).ok()).toBeTruthy()
}
async function serious(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
}

test('the sidebar opens Scheduled tasks; the cards, search, and a task page with its menu', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await task(page)
  await task(page, { title: '월말 정산 알림', repeat: 'monthly', enabled: false })
  await signIn(page)
  await page.getByTestId('nav-scheduled').click()
  await expect(page).toHaveURL(/\/scheduled$/)
  await expect(page.getByTestId('nav-scheduled')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('예약 작업')
  const cards = page.getByTestId('schedule-item')
  await expect(cards).toHaveCount(2)
  // like Claude's card: the name, what it does, and "Paused · when"
  const paused = cards.filter({ hasText: '월말 정산 알림' })
  await expect(paused).toContainText('꺼짐 · ')
  await expect(paused).toContainText('주간요약.md')
  // search by name, then nothing found, then closed again
  await page.getByTestId('scheduled-search-open').click()
  await page.getByTestId('scheduled-search').fill('정산')
  await expect(cards).toHaveCount(1)
  await page.getByTestId('scheduled-search').fill('없는 작업')
  await expect(page.getByTestId('scheduled-no-match')).toContainText('없는 작업')
  await page.getByTestId('scheduled-search').press('Escape')
  await expect(cards).toHaveCount(2)
  // a task's page: where you are, and the rarely used things behind its name
  await cards.filter({ hasText: '주간 회의록 요약' }).click()
  await expect(page.getByTestId('scheduled-topline')).toContainText('예약 작업')
  const view = page.getByTestId('schedule-view')
  await expect(view.getByRole('heading', { level: 1 })).toHaveText('주간 회의록 요약')
  await expect(view.getByTestId('schedule-instructions')).toContainText('지난주 회의록')
  await expect(view.getByTestId('schedule-repeats')).toContainText('09:00')
  await expect(view.getByTestId('schedule-runs-with')).toContainText('프로젝트 없음')
  await page.getByTestId('schedule-menu').click()
  await expect(page.getByRole('menuitem')).toHaveText(['수정', '삭제'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  // back to the list from the top line
  await page.getByTestId('scheduled-topline').getByRole('link', { name: '예약 작업' }).click()
  await expect(page).toHaveURL(/\/scheduled$/)
  expect(realErrors(errors)).toEqual([])
})

test('old Settings links land on Scheduled tasks, and Settings no longer lists them', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/schedules')
  await expect(page).toHaveURL(/\/scheduled$/)
  await expect(page.getByTestId('scheduled-empty')).toHaveText('예약 작업이 없어요')
  await page.goto('/settings')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog').getByText('예약 작업', { exact: true })).toHaveCount(0)
})

test('"New task" › in a chat starts the sentence in the new-chat box; a missing task says so', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/scheduled')
  await page.getByTestId('new-task').click()
  await expect(page.getByRole('menuitem')).toHaveText(['채팅으로 설명하기', '템플릿으로 만들기'])
  await page.getByTestId('new-task-chat').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('composer-input')).toHaveValue('평일 오전 9시마다 ')
  await page.goto('/scheduled/not-a-task')
  await expect(page.getByText('이 예약 작업을 찾을 수 없어요.', { exact: false })).toBeVisible()
})

test('phone: the cards in one column, and on a task what it is comes before its runs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await task(page)
  await task(page, { title: '두 번째 작업' })
  await signIn(page)
  await page.goto('/scheduled')
  const cards = page.getByTestId('schedule-item')
  await expect(cards).toHaveCount(2)
  const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()]
  expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await cards.filter({ hasText: '두 번째 작업' }).click()
  const details = await page.getByTestId('schedule-instructions').boundingBox()
  const history = await page.getByTestId('schedule-history').boundingBox()
  expect(details!.y).toBeLessThan(history!.y)
})

test('wide: two columns of cards, and the history beside what the task is', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await reset(page)
  await task(page)
  await task(page, { title: '두 번째 작업' })
  await signIn(page)
  await page.goto('/scheduled')
  const cards = page.getByTestId('schedule-item')
  const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()]
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2)
  await cards.nth(0).click()
  const details = await page.getByTestId('schedule-instructions').boundingBox()
  const history = await page.getByTestId('schedule-history').boundingBox()
  expect(details!.x).toBeGreaterThan(history!.x + history!.width - 1)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`Scheduled tasks and a task page have no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await task(page)
    await task(page, { title: '월말 정산 알림', enabled: false })
    await signIn(page)
    await page.goto('/scheduled')
    await expect(page.getByTestId('schedule-item')).toHaveCount(2)
    expect(await serious(page)).toEqual([])
    await page.getByTestId('new-task').click()
    expect(await serious(page)).toEqual([])
    await page.keyboard.press('Escape')
    await page.getByTestId('schedule-item').first().click()
    await expect(page.getByTestId('schedule-view')).toBeVisible()
    expect(await serious(page)).toEqual([])
  })
}
