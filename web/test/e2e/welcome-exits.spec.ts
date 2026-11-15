// Every way out of the welcome steps has a way back (components/onboarding/SetupReturn.tsx, lib/welcome.ts
// setupReturnState). The owner's report: the AI step's "OpenRouter 같은 다른 AI 서비스는 관리자 › AI 계정에서" opened
// Admin › AI accounts with no way back to the steps. Now that page shows one "← 시작 설정으로 돌아가기", which opens the
// steps on the AI step again; once AI answers it reads "설정 이어서 하기", and the steps go on past the AI step (done).
// The same on a phone, where the control goes back in the history (the steps' entry is under the page) and is the page's
// only back (the bar has no ‹ beside it). 팀 파일's "열기" of the project it made: the project page leads back, and the
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
  test(`the AI step's "other AI services" line comes back to the steps (${vp.name})`, async ({ page }) => {
    const errors = watchConsole(page)
    await page.setViewportSize(vp.size)
    await reset(page)
    const ai = await aiAccess(page)
    await signIn(page)
    await page.goto('/welcome')
    await expect(page.locator('[data-step="ai"]')).toBeVisible()
    // out: Admin's AI accounts, with the one way back at its top
    await page.getByTestId('welcome-ai-engines').click()
    await expect(page).toHaveURL(/\/admin\/providers$/)
    const back = page.getByTestId('setup-return')
    await expect(back).toHaveAttribute('data-state', 'back')
    await expect(back.getByTestId('setup-return-button')).toHaveText('시작 설정으로 돌아가기')
    // one back: a phone's bar has no ‹ of its own while the way back shows
    await expect(page.getByTestId('admin-back')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // back: the steps, on the AI step again
    await back.getByTestId('setup-return-button').click()
    await expect(page).toHaveURL(/\/welcome/)
    await expect(page.locator('[data-step="ai"]')).toBeVisible()
    // out again; an account added there (here: the AI check answers now): "설정 이어서 하기"
    await page.getByTestId('welcome-ai-engines').click()
    await expect(page.getByTestId('setup-return')).toHaveAttribute('data-state', 'back')
    ai.usable = true
    // back in this window after the sign-in's tab: the page asks again
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const next = page.getByTestId('setup-return')
    await expect(next).toHaveAttribute('data-state', 'continue')
    await expect(next.getByTestId('setup-return-button')).toHaveText('설정 이어서 하기')
    await next.getByTestId('setup-return-button').click()
    // the steps go on past the AI step, which is done
    await expect(page.locator('[data-step="profile"]')).toBeVisible()
    if (vp.name === 'computer') await expect(page.getByTestId('welcome-progress')).toContainText('1/6 AI 연결')
    expect(realErrors(errors)).toEqual([])
  })
}

test('from Home\'s no-AI card the same line opens Admin without the way back (it was not the steps)', async ({ page }) => {
  await reset(page)
  await aiAccess(page)
  await signIn(page)
  await page.goto('/')
  await page.getByTestId('no-ai-card').getByTestId('welcome-ai-engines').click()
  await expect(page).toHaveURL(/\/admin\/providers$/)
  await expect(page.getByTestId('engines-header')).toBeVisible()
  await expect(page.getByTestId('setup-return')).toHaveCount(0)
})


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
