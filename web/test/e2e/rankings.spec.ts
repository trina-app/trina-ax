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

test('new-chat home shows the top team skills with uses and people (B-W7-7)', async ({ page }) => {
  await reset(page)
  const skill = (n: number, uses: number, users: number) => ({ path: `skills/s${n}/SKILL.md`, name: `skill-${n}`, description: `Skill ${n}`, uses, users })
  await page.route('**/api/skills/popular', r => r.fulfill({ json: { days: 30, items: [skill(1, 6, 3), skill(2, 4, 2), skill(3, 2, 1), skill(4, 1, 1)] } }))
  await signIn(page)
  const card = page.getByTestId('popular-skills')
  await expect(card).toContainText('자주 쓰는 스킬')
  await expect(card).toContainText('6회 · 3명')
  await expect(card.getByRole('button')).toHaveCount(3)
  await card.getByRole('button', { name: 'skill-1' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('/skill-1 ')
  await expect(page.getByTestId('assistant-message')).toHaveCount(0)
  await page.unroute('**/api/skills/popular')
  await page.reload()
  await expect(card).toHaveCount(0)
})
