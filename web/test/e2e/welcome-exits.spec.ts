// Every way out of the welcome steps has a way back (components/onboarding/SetupReturn.tsx, lib/welcome.ts
// setupReturnState). The owner's report: the AI step's "OpenRouter 같은 다른 AI 서비스는 관리자 › AI 계정에서" opened
// Admin › AI accounts with no way back to the steps. Now that page shows one "← 시작 설정으로 돌아가기", which opens the
// steps on the AI step again; once AI answers it reads "설정 이어서 하기", and the steps go on past the AI step (done).
// The same on a phone, where the control goes back in the history (the steps' entry is under the page). The mock team
// server always answers AI, so GET /api/me/ai-access is answered here.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

/** Open `path` in this tab the way a link out of the steps does: a new history entry carrying the step it left
 * (lib/welcome.ts setupReturnState; react-router keeps a Link's state under `usr`). 팀 파일's "Open" needs the AI's
 * proposal, which the mock does not make, so the entry is made here. */
async function openFromStep(page: Page, path: string, step: string) {
  await page.evaluate(([to, setupStep]) => {
    const idx = ((window.history.state as { idx?: number } | null)?.idx ?? 0) + 1
    window.history.pushState({ usr: { setupStep }, key: `from-${setupStep}`, idx }, '', to)
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  }, [path, step] as const)
}

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

test('팀 파일\'s "Open" of the project it made: the project page leads back to 팀 파일', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const made = await page.request.post('/api/projects', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Renewal', scope: 'team', folderPath: 'renewal', instructions: '' } })
  // (its folder is not made here: the page's read of it is a 404 the test does not look at)
  const project = ((await made.json()) as { id: string }).id
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
  await openFromStep(page, `/projects/${project}`, 'files')
  await expect(page.getByTestId('project-topline')).toBeVisible()
  const back = page.getByTestId('setup-return')
  await expect(back).toHaveAttribute('data-state', 'back')
  await back.getByTestId('setup-return-button').click()
  await expect(page).toHaveURL(/\/welcome/)
  await expect(page.getByTestId('welcome-team-files')).toBeVisible()
})
