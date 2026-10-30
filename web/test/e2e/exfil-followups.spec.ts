// Follow-ups of the outbound-web fixes (docs/DECISIONS.md "Scheduled tasks nobody confirmed", "Allow a site for one
// conversation"): the address card's "allow this site in this conversation" choice, and "다시 확인" for a scheduled task
// made without its card — the same server card in Settings, the banner that says some wait, the admin's list.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
async function waitingTask(page: Page) {
  const r = await page.request.post('/__test/schedule-review', { data: {} })
  expect(r.ok()).toBeTruthy()
}

test('the address card: open once, allow this site in this conversation, or don\'t open; the random-looking part is marked', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await ask(page, 'siteask ask please')
  const card = page.getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-origin', 'server')
  await expect(card).toContainText('이 대화에서만 example.co.kr의 다른 주소도 묻지 않고 열어요')
  await expect(card.getByTestId('ask-detail-mark')).toHaveText('c2fsyxj5ltk4nzy1ndmy')
  await expect(card.getByRole('radio')).toHaveCount(3)
  await expect(card.getByLabel('열기', { exact: true })).toBeVisible()
  await expect(card.getByLabel('열지 않기')).toBeVisible()
  await card.getByLabel('이 대화에서 이 사이트 허용 (example.co.kr)').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('assistant-message').first()).toContainText('You chose "site"')
  expect(realErrors(errors)).toEqual([])
})

test('a task made without its card: the banner, "다시 확인" opens the same card, keeping it paused changes nothing, resuming turns it on', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await waitingTask(page)
  await page.reload()
  const banner = page.getByTestId('schedule-review-banner')
  await expect(banner).toContainText('확인 카드 없이 만들어진 예약 작업 1개를 멈춰 뒀어요')
  await banner.getByRole('link', { name: '예약 작업 보기' }).click()
  await expect(page).toHaveURL(/\/settings\/schedules$/)
  await expect(banner).toHaveCount(0)
  const item = page.getByTestId('schedule-item')
  await expect(item).toHaveAttribute('data-review', 'waiting')
  await expect(item).toContainText('다시 확인 필요')
  await expect(item.getByTestId('schedule-review-hint')).toContainText('확인 카드 없이 만들어진 예약 작업이라 멈춰 뒀어요')
  // no plain switch: only the card resumes it
  await expect(item.getByRole('button', { name: '켜기' })).toHaveCount(0)
  await item.getByTestId('schedule-review').click()
  const card = item.getByTestId('schedule-review-card').getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-origin', 'server')
  await expect(card).toContainText('제목: 아침 요약')
  await expect(card).toContainText('일정: 매일 09:00')
  const details = card.getByTestId('ask-detail')
  await expect(details).toHaveCount(2)
  await expect(details.first().getByTestId('ask-detail-text')).toContainText('users/olga/요약.md')
  await expect(details.nth(1).getByTestId('ask-detail-mark')).toHaveText('c2fsyxj5ltk4nzy1ndmy')
  // keep it paused: the card closes, nothing changed
  await card.getByLabel('계속 멈춰 두기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(card).toHaveCount(0)
  await expect(item).toHaveAttribute('data-review', 'waiting')
  // resume
  await item.getByTestId('schedule-review').click()
  const again = item.getByTestId('schedule-review-card').getByTestId('ask-card')
  await again.getByLabel('다시 켜기').check()
  await again.getByRole('button', { name: '답하기' }).click()
  await expect(page.getByText('예약 작업을 다시 켰어요.')).toBeVisible()
  await expect(item).not.toHaveAttribute('data-review', 'waiting')
  await expect(item.getByRole('button', { name: '끄기' })).toBeVisible()
  await page.goto('/')
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('schedule-review-banner')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('admins see tasks waiting for their owner: who and when, never the title or instruction', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await waitingTask(page)
  await page.goto('/admin/members')
  const list = page.getByTestId('admin-schedule-reviews')
  await expect(list.getByTestId('admin-schedule-review')).toHaveCount(1)
  await expect(list).toContainText('매일 09:00')
  await expect(list).toContainText('부터 멈춤')
  await expect(list).not.toContainText('아침 요약')
  await expect(list).not.toContainText('feeds.example.com')
  await expect(page.getByText('확인을 기다리는 예약 작업')).toBeVisible()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the schedule card in Settings has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await waitingTask(page)
    await page.goto('/settings/schedules')
    await page.getByTestId('schedule-review').click()
    await expect(page.getByTestId('schedule-review-card').getByTestId('ask-detail-mark').first()).toBeVisible()
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
    const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
  })
}
