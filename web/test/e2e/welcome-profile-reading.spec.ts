// 회사 소개 while it reads (components/onboarding/ProfileStep.tsx; owner 2026-11-20): nothing to press while the AI works
// (no "Do this later" under it); past 90 seconds one quiet "Don't wait, go on" that puts the step off and lets the reading
// go on (opening the step again picks up its draft). Before and after the reading the step keeps its controls.
// Screenshots at 1440 and 390, light and dark, when PROFILE_READING_SHOTS names a folder.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const dir = process.env.PROFILE_READING_SHOTS

for (const width of [1440, 390] as const) for (const scheme of ['light', 'dark'] as const) {
  test(`the reading has no "later"; past 90 s one quiet way on · ${width} · ${scheme}`, async ({ page }) => {
    const shot = async (p: Page, name: string) => { if (dir) await p.screenshot({ path: `${dir}/${width}-${scheme}-${name}.png`, fullPage: true }) }
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    // the reading never ends here: the server's answer stays "running", a page and the images on the way
    await page.route('**/api/onboarding/profile/draft/*', (r) => r.request().method() === 'GET'
      ? r.fulfill({ json: { status: 'running', website: 'https://acme.example/', draft: null, error: null, writing: true, steps: [{ url: 'https://acme.example/', status: 'ok', title: 'Acme' }], assets: { images: 2, logo: true, colors: [] } } })
      : r.fallback())
    await page.goto('/welcome')
    const step = page.getByTestId('welcome-profile')
    // before: the website form keeps its controls, "Do this later" among them
    await expect(step.getByRole('button', { name: 'Do this later' })).toBeVisible()
    await page.getByLabel('Website address').fill('acme.example')
    await page.getByRole('button', { name: 'Read the website' }).click()
    const reading = page.getByTestId('profile-step-reading')
    await expect(reading).toBeVisible()
    // while it works: nothing to press, no "Do this later"
    await expect(reading.getByRole('button')).toHaveCount(0)
    await expect(step.getByRole('button', { name: 'Do this later' })).toHaveCount(0)
    await expect(page.getByTestId('profile-step-reading-exit')).toHaveCount(0)
    await shot(page, '1-reading')
    // 90 s on (the reading's start is kept with it for a reload): the one quiet way on
    await page.evaluate(() => {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)!
        if (!k.startsWith('mycel.profileDraft.')) continue
        const v = JSON.parse(sessionStorage.getItem(k)!)
        v.phase.at = Date.now() - 91_000
        sessionStorage.setItem(k, JSON.stringify(v))
      }
    })
    await page.reload()
    const exit = page.getByTestId('profile-step-skip-waiting')
    await expect(exit).toHaveText("Don't wait, go on")
    await expect(page.getByTestId('profile-step-reading-exit')).toContainText('It keeps reading.')
    await expect(reading.getByRole('button')).toHaveCount(1)
    await shot(page, '2-reading-past-90s')
    // the press puts the step off and goes on to the next one
    await exit.click()
    await expect(page.getByTestId('welcome-progress')).toBeVisible()
    await expect(reading).toHaveCount(0)
    const progress = (await (await page.request.get('/api/onboarding/welcome')).json()).progress
    expect(progress.steps.profile).toBe('skipped')
  })
}
