// What the AI sees is said, not hidden (docs/DECISIONS.md "Skills: the whole list, the skill tool"): the Team skills
// page shows how many skills the AI's list has with a description and by name only (only when it is cut) and how
// many team rule files it follows; Settings > External services lists every tool of a big service, and says "100 of
// 150 tools" with "check again" for a list an older server cut (docs/DECISIONS.md "Connection tools: deferred, found and
// called").
import { expect, test, type Page } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole, adv } from './helpers'

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

test('External services: every tool of a big service is listed with its switch; a list an older server cut says "check again"', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page, OWNER)
  await page.goto('/settings/connectors')
  const add = async (name: string, url: string) => {
    await page.getByTestId('integration-add').click()
    await page.getByTestId('integration-name').fill(name)
    await page.getByTestId('integration-url').fill(url)
    await (await adv(page, 'integration-auth-none')).check()
    await page.getByTestId('integration-save').click()
    const r = row(page, name)
    await expect(r).toHaveAttribute('data-status', 'connected')
    return r
  }
  // 186 tools (like Higgsfield's MCP server): all of them, no "N of M"
  const big = await add('Big tools', 'https://many.tools.example/mcp')
  await big.getByTestId('integration-toggle').click()
  const toggle = big.getByTestId('integration-tools-toggle')
  await expect(toggle).toHaveText('도구 186개')
  await toggle.click()
  await expect(big.getByTestId('integration-tool')).toHaveCount(186)
  await expect(big.getByTestId('integration-tool-switch')).toHaveCount(186)
  await expect(big.getByTestId('integration-tools-capped')).toHaveCount(0)
  // the last one switches like the first
  const sent = page.waitForRequest((r) => /\/api\/integrations\/[^/]+\/tools$/.test(r.url()) && r.method() === 'POST')
  const last = big.getByTestId('integration-tool').last()
  await last.locator('label').click()
  expect((await sent).postDataJSON()).toEqual({ name: 'tool_185', enabled: false })
  await expect(last).toHaveAttribute('data-enabled', 'false')
  await expect(big.getByTestId('integration-tools-off')).toHaveText(' · 1개 꺼짐')
  // a list an older server cut at 100: said, with what to do; "check again" saves them all
  const old = await add('Old list', 'https://stale.tools.example/mcp')
  await old.getByTestId('integration-toggle').click()
  await expect(old.getByTestId('integration-tools-toggle')).toHaveText('도구 150개 중 100개')
  await old.getByTestId('integration-tools-toggle').click()
  await expect(old.getByTestId('integration-tools-capped')).toHaveText('이 서비스는 도구 150개를 제공하는데, 지난번 확인 때 100개만 저장됐어요. 다시 확인하면 전부 저장돼요.')
  await old.getByTestId('integration-refresh').click()
  await expect(old.getByTestId('integration-tools-toggle')).toHaveText('도구 150개')
  await expect(old.getByTestId('integration-tools-capped')).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})
