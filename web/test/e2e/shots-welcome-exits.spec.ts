// Screenshots of the way back from a page the welcome steps link to (components/onboarding/SetupReturn.tsx), 1440 and
// 390 wide, light and dark, for reviewing by eye: the AI step, Admin › AI accounts opened from it ("← Back to getting
// started"), and the same once AI answers ("Continue setup"); a project opened from 팀 파일. Only when WELCOME_EXITS_SHOTS names a folder to write
// them to. Nothing is asserted about the control, so the same file shoots a build from before it.
import { expect, test } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const dir = process.env.WELCOME_EXITS_SHOTS
test.skip(!dir, 'WELCOME_EXITS_SHOTS is not set')
test.use({ locale: 'en-US' })

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`welcome exits screenshots (${vp.name}, ${scheme})`, async ({ page }) => {
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      const ai = { usable: false }
      await page.route('**/api/me/ai-access', (r) => r.fulfill({ json: { usable: ai.usable, action: 'connect_team', requested: false } }))
      await signIn(page)
      const shot = (name: string) => page.screenshot({ path: `${dir}/${name}-${vp.name}-${scheme}.png` })
      await page.goto('/welcome')
      await expect(page.getByTestId('welcome-ai-engines')).toBeVisible()
      await page.waitForTimeout(300)
      await shot('ai-step')
      await page.getByTestId('welcome-ai-engines').click()
      await expect(page).toHaveURL(/\/admin\/providers/)
      await expect(page.getByTestId('engine-list')).toBeVisible()
      await page.waitForTimeout(500)
      await shot('providers-from-steps')
      ai.usable = true
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForTimeout(800)
      await shot('providers-ai-connected')
      // 팀 파일's "Open" of the project it made (the entry made as that link makes it: the mock makes no AI proposal)
      const made = await page.request.post('/api/projects', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Renewal', scope: 'team', folderPath: 'renewal', instructions: '' } })
      const id = ((await made.json()) as { id: string }).id
      await page.evaluate((to) => {
        const idx = ((window.history.state as { idx?: number } | null)?.idx ?? 0) + 1
        window.history.pushState({ usr: { setupStep: 'files' }, key: 'from-files', idx }, '', to)
        window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
      }, `/projects/${id}`)
      await page.waitForTimeout(800)
      await shot('project-from-files')
    })
  }
}
