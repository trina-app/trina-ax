// Every way out of the welcome steps has a way back (components/onboarding/SetupReturn.tsx, lib/welcome.ts
// setupReturnState). The owner's report: the AI step's "OpenRouter 같은 다른 AI 서비스는 관리자 › AI 계정에서" opened
// Admin › AI accounts with no way back to the steps. That line is gone now (fix/onboarding-after-setup), on the step and
// on Home's no-AI card; the way back from Admin stays for any page a step links to (tests/unit/setup-return.test.tsx). 팀 파일's "열기" of the project it made: the project page leads back, and the
// step shows its result again (the project made), not a new start. The mock team server always answers AI, so GET
// /api/me/ai-access is answered here.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

/** GET /api/me/ai-access as a team without AI until `ai.usable` is set */
async function aiAccess(page: Page) {
  const ai = { usable: false }
  await page.route('**/api/me/ai-access', (r) => r.fulfill({ json: { usable: ai.usable, action: 'connect_team', requested: false } }))
  return ai
}

for (const vp of [{ name: 'computer', size: { width: 1360, height: 860 } }, { name: 'phone', size: { width: 390, height: 844 } }]) {
  test(`the AI step has no way out to Admin › AI accounts any more; Home's no-AI card neither (${vp.name})`, async ({ page }) => {
    const errors = watchConsole(page)
    await page.setViewportSize(vp.size)
    await reset(page)
    await aiAccess(page)
    await signIn(page)
    await page.goto('/welcome')
    await expect(page.locator('[data-step="ai"]')).toBeVisible()
    await expect(page.getByTestId('welcome-ai-ways')).toBeVisible()
    await expect(page.getByTestId('welcome-ai-engines')).toHaveCount(0)
    await expect(page.locator('[data-step="ai"] a[href="/admin/providers"]')).toHaveCount(0)
    await page.goto('/')
    await expect(page.getByTestId('no-ai-card').getByTestId('welcome-ai-ways')).toBeVisible()
    await expect(page.getByTestId('no-ai-card').getByTestId('welcome-ai-engines')).toHaveCount(0)
    expect(realErrors(errors)).toEqual([])
  })
}

const doc = (name: string) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(`# ${name}\n`) })
const FILES = ['견적서_양식.md', '10월 회의록.md', 'A사 제안서.md', 'A사 견적.md'].map(doc)

for (const vp of [{ name: 'computer', size: { width: 1360, height: 860 } }, { name: 'phone', size: { width: 390, height: 844 } }]) {
  test(`팀 파일's "열기" of the project it made leads back to the step's result (${vp.name})`, async ({ page }) => {
    const errors = watchConsole(page)
    await page.setViewportSize(vp.size)
    await reset(page)
    await signIn(page)
    await page.request.post('/__test/organize', { data: { project: { name: 'A사 리뉴얼', match: 'A사' } } })
    await page.goto('/welcome')
    await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
    await page.getByTestId('skills-later').click()
    await expect(page.getByTestId('welcome-team-files')).toBeVisible()
    await page.getByTestId('welcome-team-files-input').setInputFiles(FILES)
    await page.getByTestId('organize-apply').click()
    await page.getByTestId('organize-project-yes').click()
    await expect(page.getByTestId('organize-project-done')).toContainText("'A사 리뉴얼' 프로젝트를 만들었어요")
    // the step's own link (OrganizeFiles.tsx): the project page, with the way back
    await page.getByTestId('organize-project-open').click()
    await expect(page).toHaveURL(/\/projects\//)
    const back = page.getByTestId('setup-return')
    await expect(back).toHaveAttribute('data-state', 'back')
    if (vp.name === 'phone') await expect(page.getByTestId('topbar-back')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await back.getByTestId('setup-return-button').click()
    // the step as it was: the result with the project made, not the start of the step
    await expect(page).toHaveURL(/\/welcome/)
    await expect(page.getByTestId('organize-project-done')).toContainText("'A사 리뉴얼' 프로젝트를 만들었어요")
    await expect(page.getByTestId('organize-result-title')).toBeVisible()
    await expect(page.getByTestId('welcome-team-files')).toHaveAttribute('data-screen', 'organize')
    expect(realErrors(errors)).toEqual([])
  })
}
