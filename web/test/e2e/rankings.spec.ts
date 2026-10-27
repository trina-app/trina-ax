import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

test('own repeated questions fill the composer without sending; empty history has no card', async ({ page }) => {
  await reset(page)
  let calls = 0
  page.on('request', r => { if (r.method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname)) calls++ })
  await page.route('**/api/questions/frequent', r => r.fulfill({ json: { days: 30, sampled: true, items: [
    { question: '내 주간 보고서를 정리해 줘', count: 3, lastUsedAt: '2026-10-20T00:00:00.000Z' },
  ] } }))
  await signIn(page)
  const card = page.getByTestId('frequent-questions')
  await expect(card).toContainText('내 대화')
  await expect(card).toContainText('최근 대화 일부')
  await card.getByRole('button').click()
  await expect(page.getByTestId('composer-input')).toHaveValue('내 주간 보고서를 정리해 줘')
  expect(calls).toBe(0)
  await page.unroute('**/api/questions/frequent')
  await page.reload()
  await expect(card).toHaveCount(0)
})

test('accessible skill ranking links to its slash command without triggering a turn', async ({ page }) => {
  await reset(page)
  await page.route('**/api/skills/popular', r => r.fulfill({ json: { days: 30, items: [
    { path: 'skills/weekly-report/SKILL.md', name: 'weekly-report', description: 'Weekly report', uses: 4, users: 2 },
  ] } }))
  await signIn(page)
  await page.goto('/skills')
  const card = page.getByTestId('popular-skills')
  await expect(card).toContainText('4회 · 2명')
  await card.getByRole('link', { name: 'weekly-report' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('/weekly-report ')
  await expect(page.getByTestId('assistant-message')).toHaveCount(0)
})
