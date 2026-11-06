// Dev environment sites (docs/DECISIONS.md "Dev environment: sites a person allows"): the chat's site card when a
// command needs a site that is not allowed (allow once / always allow / don't allow), and Settings > Dev environment
// sites: the person's own list with Remove, and her Full internet switch, which asks first with the warning. With the
// team's No network the section says so and shows nothing to allow. A server without the srt runner has no section.
// DEV_ENV_SHOTS=<folder> saves screenshots of each step there.
import AxeBuilder from '@axe-core/playwright'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset as resetTo, signIn, watchConsole } from './helpers'

const shot = async (page: Page, name: string) => {
  const dir = process.env.DEV_ENV_SHOTS
  // after the switch's and the dialog's transitions
  if (dir) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(dir, `${name}.png`) }) }
}
const noSerious = async (page: Page, sel: string) => {
  const axe = await new AxeBuilder({ page }).include(sel).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
}

for (const lang of ['en', 'ko'] as const) {
  test.describe(lang, () => {
    const en = lang === 'en'
    const tag = lang
    const reset = (page: Page) => resetTo(page, en ? { teamLocale: 'en', usersFollowTeam: true } : {})

    test('the site card: Always allow puts the site on her own list', async ({ page }) => {
      await reset(page)
      const errors = watchConsole(page)
      await page.request.post('/__test/dev-env', { data: { srt: true } })
      await signIn(page)
      await page.getByTestId('composer-input').fill('devenvsite ask')
      await page.getByTestId('send').click()
      const card = page.getByTestId('dev-env-site-card')
      await expect(card).toBeVisible()
      await expect(card).toContainText('api.openweathermap.org')
      await expect(card.getByTestId('dev-env-site-command')).toContainText('curl -s https://api.openweathermap.org')
      if (en) {
        await expect(card).toContainText('The AI tried to reach api.openweathermap.org. Allow it?')
        await expect(card.getByTestId('dev-env-site-once')).toHaveText('Allow once')
        await expect(card.getByTestId('dev-env-site-always')).toHaveText('Always allow')
        await expect(card.getByTestId('dev-env-site-deny')).toHaveText("Don't allow")
      }
      await noSerious(page, '[data-testid="dev-env-site-card"]')
      await card.scrollIntoViewIfNeeded()
      await shot(page, `${tag}-1-chat-card`)
      const answer = page.waitForRequest((r) => r.url().includes('/answer') && r.method() === 'POST')
      await card.getByTestId('dev-env-site-always').click()
      expect((await answer).postDataJSON()).toMatchObject({ kind: 'dev_env_site', decision: 'always' })
      await expect(card).toHaveCount(0)

      await page.goto('/settings/dev-env-sites')
      const s = page.getByTestId('dev-env-sites')
      await expect(s.getByTestId('dev-env-site')).toHaveCount(1)
      await expect(s.getByTestId('dev-env-site')).toContainText('api.openweathermap.org')
      await expect(s.getByTestId('dev-env-full-switch')).not.toBeChecked()
      await noSerious(page, '[data-testid="dev-env-sites"]')
      await shot(page, `${tag}-2-settings-list`)
      expect(realErrors(errors)).toEqual([])
    })

    test('Full internet asks first with the warning; Remove takes a site off', async ({ page }) => {
      await reset(page)
      await page.request.post('/__test/dev-env', { data: { srt: true, sites: ['api.openweathermap.org', '*.example-cdn.net'] } })
      await signIn(page)
      await page.goto('/settings/dev-env-sites')
      const s = page.getByTestId('dev-env-sites')
      await expect(s.getByTestId('dev-env-site')).toHaveCount(2)
      // the switch asks first; Cancel leaves it off
      await s.locator('label', { has: page.getByTestId('dev-env-full-switch') }).click()
      const warning = page.getByTestId('dev-env-full-warning')
      await expect(warning).toBeVisible()
      if (en) await expect(warning).toContainText('The AI can send files you can read to any site.')
      await shot(page, `${tag}-3-full-internet-warning`)
      await page.getByRole('button', { name: en ? 'Cancel' : '취소' }).click()
      await expect(s.getByTestId('dev-env-full-switch')).not.toBeChecked()
      // the second time: turn on
      await s.locator('label', { has: page.getByTestId('dev-env-full-switch') }).click()
      const put = page.waitForRequest((r) => r.url().endsWith('/api/dev-env/full-internet') && r.method() === 'PUT')
      await page.getByRole('button', { name: en ? 'Turn on' : '켜기' }).click()
      expect((await put).postDataJSON()).toEqual({ on: true, acceptWarning: 1 })
      await expect(s.getByTestId('dev-env-full-switch')).toBeChecked()
      await expect(s.getByTestId('dev-env-full-on')).toBeVisible()
      await shot(page, `${tag}-4-full-internet-on`)
      // off needs no confirm
      const off = page.waitForRequest((r) => r.url().endsWith('/api/dev-env/full-internet') && r.method() === 'PUT')
      await s.locator('label', { has: page.getByTestId('dev-env-full-switch') }).click()
      expect((await off).postDataJSON()).toEqual({ on: false })
      await expect(s.getByTestId('dev-env-full-on')).toHaveCount(0)
      // Remove asks, then the site is gone
      await s.getByTestId('dev-env-site-remove').first().click()
      await page.getByRole('button', { name: en ? 'Remove' : '삭제', exact: true }).click()
      await expect(s.getByTestId('dev-env-site')).toHaveCount(1)
      await expect(s.getByTestId('dev-env-site')).toContainText('*.example-cdn.net')
    })

    test('No network: nothing to allow, no Full internet switch', async ({ page }) => {
      await reset(page)
      await page.request.post('/__test/dev-env', { data: { srt: true, network: 'offline', sites: ['api.openweathermap.org'] } })
      await signIn(page)
      await page.goto('/settings/dev-env-sites')
      const s = page.getByTestId('dev-env-sites')
      await expect(s.getByTestId('dev-env-sites-no-network')).toBeVisible()
      await expect(s.getByTestId('dev-env-site')).toHaveCount(0)
      await expect(s.getByTestId('dev-env-full')).toHaveCount(0)
      await shot(page, `${tag}-5-no-network`)
    })
  })
}

test('a server without the srt dev environment has no section', async ({ page }) => {
  await resetTo(page)
  await signIn(page)
  await page.goto('/settings/profile')
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect(page.locator('a[href="/settings/dev-env-sites"]')).toHaveCount(0)
})
