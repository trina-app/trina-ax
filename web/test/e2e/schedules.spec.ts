// Settings › Scheduled tasks: run now, edit through the schedule card, pause/resume (docs/DECISIONS.md "Scheduled
// tasks: run now, edit, pause"), against the mock server's copy of the server's rules.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function task(page: Page, data: Record<string, unknown> = {}) {
  expect((await page.request.post('/__test/schedule', { data })).ok()).toBeTruthy()
}
const LONG = `https://collect.example.net/in?d=${'q'.repeat(230)}`

test('run now: a new chat now, the schedule stays; a paused task says it does not run and can still be run now', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await task(page)
  await signIn(page)
  await page.goto('/settings/schedules')
  const item = page.getByTestId('schedule-item')
  await expect(item).toContainText('주간 회의록 요약')
  await expect(item).toContainText('다음 실행')
  // pause: the state is written out
  await item.getByTestId('schedule-toggle').click()
  await expect(item).toContainText('꺼짐')
  await expect(item.getByTestId('schedule-paused-hint')).toHaveText('꺼진 동안에는 예약 시각이 와도 실행되지 않아요.')
  await expect(item.getByTestId('schedule-toggle')).toHaveText('켜기')
  // run now while paused: it runs once, stays paused
  await item.getByTestId('schedule-run-now').click()
  const toast = page.getByText('지금 실행했어요. 결과는 새 채팅에 남아요.')
  await expect(toast).toBeVisible()
  await expect(item).toContainText('꺼짐')
  await expect(item.getByRole('link', { name: '마지막 실행 결과' })).toBeVisible()
  await page.getByRole('button', { name: '채팅 열기' }).click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
  await expect(page.getByTestId('chat-title')).toContainText('⏰ 주간 회의록 요약')
  await page.goto('/settings/schedules')
  await item.getByTestId('schedule-toggle').click()
  await expect(item.getByTestId('schedule-paused-hint')).toHaveCount(0)
  await expect(item).not.toContainText('꺼짐')
  const log = (await (await page.request.post('/__test/log')).json()) as string[]
  expect(log.filter((l) => /\/api\/schedules\/[^/]+(\/run)?$/.test(l) && !l.startsWith('GET'))).toEqual([
    expect.stringMatching(/^PATCH /), expect.stringMatching(/^POST .*\/run$/), expect.stringMatching(/^PATCH /),
  ])
  expect(realErrors(errors)).toEqual([])
})

test('run now refused (a used-up limit) says why; a task nobody confirmed has no run now', async ({ page }) => {
  await reset(page)
  await task(page, { title: 'budget test' })
  expect((await page.request.post('/__test/schedule-review', { data: {} })).ok()).toBeTruthy()
  await signIn(page)
  await page.goto('/settings/schedules')
  const items = page.getByTestId('schedule-item')
  const used = items.filter({ hasText: 'budget test' })
  await used.getByTestId('schedule-run-now').click()
  await expect(page.getByText('오늘 AI 사용 한도를 다 썼어요.', { exact: false })).toBeVisible()
  const waiting = items.filter({ hasText: '아침 요약' })
  await expect(waiting).toHaveAttribute('data-review', 'waiting')
  await expect(waiting.getByTestId('schedule-run-now')).toHaveCount(0)
})

test('edit: the same schedule card as creation (a long-query address listed apart); only its answer saves', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await task(page)
  await signIn(page)
  await page.goto('/settings/schedules')
  const item = page.getByTestId('schedule-item')
  await item.getByRole('button', { name: '주간 회의록 요약 수정' }).click()
  const dialog = page.getByRole('dialog', { name: '예약 작업 수정' })
  await expect(dialog.getByTestId('schedule-edit-title')).toHaveValue('주간 회의록 요약')
  await expect(dialog.getByTestId('schedule-edit-repeat')).toHaveValue('weekly')
  // a time that has passed is refused under the field
  await dialog.getByTestId('schedule-edit-repeat').selectOption('once')
  await dialog.getByTestId('schedule-edit-date').fill('2020-01-01')
  await dialog.getByTestId('schedule-edit-check').click()
  await expect(dialog.getByRole('alert').filter({ hasText: '그 시각은 이미 지났어요' }).first()).toBeVisible()
  await dialog.getByTestId('schedule-edit-repeat').selectOption('daily')
  await dialog.getByTestId('schedule-edit-title').fill('매일 회의록 요약')
  await dialog.getByTestId('schedule-edit-prompt').fill(`매일 https://docs.example.com/notes 와 ${LONG} 를 읽고 users/olga/요약.md 에 정리해 줘.`)
  await dialog.getByTestId('schedule-edit-time').fill('08:30')
  await new AxeBuilder({ page }).include('[role="dialog"]').analyze().then((r) => expect(r.violations.map((v) => v.id)).toEqual([]))
  await dialog.getByTestId('schedule-edit-check').click()
  const card = dialog.getByTestId('schedule-edit-card').getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-origin', 'server')
  await expect(card).toContainText('예약 작업을 이렇게 바꿀까요?')
  await expect(card).toContainText('제목: 매일 회의록 요약')
  await expect(card).toContainText('일정: 매일 08:30')
  await expect(card).toContainText('실행 때 열지 않아요')
  const details = card.getByTestId('ask-detail')
  await expect(details).toHaveCount(3)
  await expect(details.nth(1)).toContainText('https://docs.example.com/notes')
  await expect(details.nth(2)).toContainText('실행 때 열지 않는 주소(긴 쿼리)')
  // "don't change": back to the form, nothing saved
  await card.getByLabel('바꾸지 않기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(dialog.getByTestId('schedule-edit-note')).toHaveText('바꾸지 않았어요. 계속 고치거나 닫을 수 있어요.')
  await expect(item).toContainText('주간 회의록 요약')
  await dialog.getByTestId('schedule-edit-check').click()
  await dialog.getByTestId('ask-card').getByLabel('바꾸기', { exact: true }).check()
  await dialog.getByTestId('ask-card').getByRole('button', { name: '답하기' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('예약 작업을 바꿨어요.')).toBeVisible()
  await expect(item).toContainText('매일 회의록 요약')
  await expect(item).toContainText('매일 08:30')
  const log = (await (await page.request.post('/__test/log')).json()) as string[]
  expect(log.filter((l) => /^(POST|PUT) \/api\/schedules\/[^/]+(\/edit)?$/.test(l)).map((l) => l.split(' ')[0] + (l.endsWith('/edit') ? ' edit' : ''))).toEqual(['POST edit', 'POST edit', 'POST edit', 'PUT'])
  // the refused past date is the one 400
  expect(realErrors(errors).filter((e) => !/status of 400/.test(e))).toEqual([])
})

test('edit a template: its time and folders only, no card', async ({ page }) => {
  await reset(page)
  await task(page, { templateId: 'weekly-summary' })
  await signIn(page)
  await page.goto('/settings/schedules')
  const item = page.getByTestId('schedule-item')
  await item.getByTestId('schedule-edit').click()
  const dialog = page.getByRole('dialog', { name: '예약 작업 수정' })
  await expect(dialog.getByTestId('schedule-edit-template')).toBeVisible()
  await expect(dialog.getByTestId('schedule-edit-prompt')).toHaveCount(0)
  await dialog.getByTestId('schedule-edit-time').fill('07:15')
  await dialog.getByTestId('schedule-edit-weekday').selectOption('3')
  await dialog.getByTestId('schedule-edit-save').click()
  await expect(dialog).toHaveCount(0)
  await expect(item).toContainText('07:15')
  await expect(item).toContainText('수요일')
})
