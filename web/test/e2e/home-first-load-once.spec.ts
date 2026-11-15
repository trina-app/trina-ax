// First load of Home: the AI access and the welcome steps' progress are each read once, not once per component that
// asks (store/aiAccess.ts and store/welcome.ts share a read on its way; QA TC-887).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ serviceWorkers: 'block' })

function track(page: Page) {
  const log: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/') && r.method() === 'GET') log.push(u.pathname)
  })
  return log
}

for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
  test(`Home at ${vp.w}: AI access and welcome progress are read once on the first load`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h })
    await reset(page)
    // a real server takes a moment: the second asker comes while the first read is still on its way
    await page.route(/\/api\/(me\/ai-access|onboarding\/welcome)$/, async (route) => { await new Promise((r) => setTimeout(r, 150)); await route.continue() })
    const log = track(page)
    await signIn(page)
    await page.waitForTimeout(800)
    log.length = 0
    await page.reload() // the owner's first load of Home with the session already there
    await page.waitForTimeout(1500)
    const n = (p: string) => log.filter((u) => u === p).length
    expect(n('/api/me/ai-access'), 'ai-access').toBe(1)
    expect(n('/api/onboarding/welcome'), 'welcome').toBe(1)
  })
}

test('opening the welcome steps at start reads AI access and the progress once', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.waitForTimeout(800)
  await page.route(/\/api\/(me\/ai-access|onboarding\/welcome)$/, async (route) => { await new Promise((r) => setTimeout(r, 150)); await route.continue() })
  const log = track(page)
  await page.goto('/welcome')
  await expect(page.locator('main')).toBeVisible()
  await page.waitForTimeout(1500)
  const n = (p: string) => log.filter((u) => u === p).length
  expect(n('/api/me/ai-access'), 'ai-access').toBe(1)
  expect(n('/api/onboarding/welcome'), 'welcome').toBe(1)
})
