// A scheduled task's run history and its runs folded in 트리나's 최근 기록 (pages/Scheduled.tsx "Runs",
// components/nav/TaskRunsRow.tsx; docs/DECISIONS.md "Scheduled runs fold in Recent"): the task page lists every run,
// newest first, 10 then "더 보기", each opening its own chat, a failed one with its reason; 최근 기록 has one row per task
// instead of one per run, semibold while a run is unread, and opening that run clears it; Search still finds a run.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { navChatList, showChats } from './nav'

async function task(page: Page, data: Record<string, unknown> = {}) {
  expect((await page.request.post('/__test/schedule', { data })).ok()).toBeTruthy()
}

test('the task page lists its runs: newest first, 10 then more, a failed one says why, each opens its chat', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await task(page, { title: '아침 요약', runs: 12, failEvery: 5 })
  await signIn(page)
  await page.goto('/scheduled')
  await page.getByTestId('schedule-item').filter({ hasText: '아침 요약' }).click()
  const history = page.getByTestId('schedule-history')
  await expect(history.getByRole('heading', { level: 2 })).toHaveText('실행 기록')
  const rows = history.getByTestId('schedule-run-link')
  await expect(rows).toHaveCount(10)
  // the newest first, and it failed (every fifth from the newest): its reason in one line, its time it took
  await expect(rows.first()).toHaveAttribute('data-outcome', 'error')
  await expect(rows.first()).toContainText('실패')
  await expect(rows.first()).toContainText('AI가 지금 답하지 못했어요')
  // what to do next: right under that newest row, above the second
  const step = history.getByTestId('schedule-next-step')
  await expect(step).toHaveCount(1)
  const [first, next, second] = [await rows.first().boundingBox(), await step.boundingBox(), await rows.nth(1).boundingBox()]
  expect(next!.y).toBeGreaterThanOrEqual(first!.y + first!.height - 1)
  expect(next!.y + next!.height).toBeLessThanOrEqual(second!.y + 1)
  await expect(rows.nth(1)).toHaveAttribute('data-outcome', 'done')
  await expect(rows.nth(1)).toContainText('성공')
  await expect(rows.nth(1)).toContainText('열기')
  // "더 보기" starts where the rows' dots start
  const more = await history.getByTestId('schedule-runs-more').boundingBox()
  const dot = await rows.first().locator('span[aria-hidden]').first().boundingBox()
  expect(Math.abs(more!.x - dot!.x)).toBeLessThanOrEqual(1)
  await history.getByTestId('schedule-runs-more').click()
  await expect(rows).toHaveCount(12)
  await expect(history.getByTestId('schedule-runs-more')).toHaveCount(0)
  // a run opens its own chat
  const href = await rows.nth(3).getAttribute('href')
  await rows.nth(3).click()
  await expect(page).toHaveURL(new RegExp(`${href}$`))
  expect(realErrors(errors)).toEqual([])
})

test('"Run now" shows as a live row at the top, then as a finished run', async ({ page }) => {
  await reset(page)
  await task(page, { title: '주간 보고', runs: 2, runMs: 1500 })
  await signIn(page)
  await page.goto('/scheduled')
  await page.getByTestId('schedule-item').filter({ hasText: '주간 보고' }).click()
  const rows = page.getByTestId('schedule-history').getByTestId('schedule-run-link')
  await expect(rows).toHaveCount(2)
  await page.getByTestId('schedule-run-now').click()
  await expect(rows.first()).toHaveAttribute('data-outcome', 'running')
  await expect(rows.first()).toContainText('실행 중')
  await expect(rows).toHaveCount(3)
  await expect(rows.first()).toHaveAttribute('data-outcome', 'done', { timeout: 10_000 })
  await expect(rows).toHaveCount(3)
})

for (const phone of [false, true]) {
  test(`${phone ? 'phone drawer' : '최근 기록'}: one row per task, semibold while a run is unread; opening that run clears it`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 })
    await reset(page)
    await task(page, { title: '아침 요약', runs: 4, failEvery: 4, unread: true })
    await task(page, { title: '월말 정산', runs: 3 })
    await signIn(page)
    await showChats(page)
    const list = navChatList(page)
    const folded = list.getByTestId('task-runs-row')
    await expect(folded).toHaveCount(2)
    // the run chats themselves are not rows of their own
    await expect(list.locator('a[href^="/c/"]').filter({ hasText: '아침 요약 · ' })).toHaveCount(0)
    const morning = folded.filter({ hasText: '아침 요약' })
    await expect(morning).toHaveAttribute('data-unread', '')
    // its newest run failed: the red dot
    await expect(morning).toHaveAttribute('data-outcome', 'failed')
    await expect(morning.getByTestId('task-runs-mark')).toBeVisible()
    await expect(folded.filter({ hasText: '월말 정산' })).not.toHaveAttribute('data-unread', '')
    // the row opens the task page; the newest run opens its chat, which marks it seen
    await morning.click()
    await expect(page).toHaveURL(/\/scheduled\/[^/]+$/)
    const seen = page.waitForResponse((r) => /\/api\/chats\/[^/]+\/seen$/.test(r.url()) && r.ok())
    await page.getByTestId('schedule-history').getByTestId('schedule-run-link').first().click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
    await seen
    // back to the start (not on the chat: there it has no marker anyway), and the list again
    await page.goto('/')
    await showChats(page)
    await expect(navChatList(page).getByTestId('task-runs-row').filter({ hasText: '아침 요약' })).not.toHaveAttribute('data-unread', '')
  })
}

test('Search still finds a run chat by its name', async ({ page }) => {
  await reset(page)
  await task(page, { title: '아침 요약', runs: 2 })
  await signIn(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('dialog').getByRole('combobox').or(page.getByRole('dialog').getByRole('textbox')).first().fill('아침 요약')
  await expect(page.getByRole('dialog').getByRole('option').filter({ hasText: '아침 요약 · ' }).first()).toBeVisible()
})
