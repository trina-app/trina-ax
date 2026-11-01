// What the AI sees is said, not hidden (docs/DECISIONS.md "Skills: the whole list, the skill tool"): the Team skills
// page shows how many skills the AI's list has with a description and by name only (only when it is cut) and how
// many team rule files it follows; Settings > External services shows "100 of 150 tools" for a service that offers
// more than the server keeps.
import { expect, test, type Page } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'

const row = (page: Page, name: string) => page.getByTestId('integration-row').filter({ has: page.getByText(name, { exact: true }) })

test('Team skills: the AI list counts show only when something is left out', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  await page.goto('/skills')
  // the page has loaded its overview (the tabs show), and the whole list fits: no note
  await expect(page.getByRole('tablist')).toBeVisible()
  await expect(page.getByTestId('skill-list-note')).toHaveCount(0)
  expect((await page.request.post('/__test/skill-list', { data: { skills: 120, described: 64, nameOnly: 56, unlisted: 0, cut: true, rules: 14, rulesFollowed: 10 } })).ok()).toBeTruthy()
  await page.reload()
  const note = page.getByTestId('skill-list-note')
  await expect(note.getByTestId('skill-list-counts')).toHaveText('스킬 120개 · AI 목록에 설명까지 64개 · 이름만 56개')
  await expect(note.getByTestId('skill-rules-count')).toHaveText('팀 규칙: 규칙 파일 14개 중 파일 이름순으로 앞의 10개만 AI가 따라요.')
  expect(realErrors(errors)).toEqual([])
})

test('External services: a service with more tools than the AI can use says "100 of 150"', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  await page.goto('/settings/integrations')
  await page.getByTestId('integration-add').click()
  await page.getByTestId('integration-name').fill('Big tools')
  await page.getByTestId('integration-url').fill('https://many.tools.example/mcp')
  await page.getByTestId('integration-auth-none').check()
  await page.getByTestId('integration-save').click()
  const big = row(page, 'Big tools')
  await expect(big).toHaveAttribute('data-status', 'connected')
  const toggle = big.getByTestId('integration-tools-toggle')
  await expect(toggle).toHaveText('도구 150개 중 100개')
  await toggle.click()
  await expect(big.getByTestId('integration-tool')).toHaveCount(100)
  await expect(big.getByTestId('integration-tools-capped')).toHaveText('이 서비스는 도구 150개를 제공하는데, AI는 앞의 100개만 쓸 수 있어요.')
  expect(realErrors(errors)).toEqual([])
})
