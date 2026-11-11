// Admin › Team settings › File list (pages/admin/FileList.tsx; server/src/file-list/): one switch on the section and a
// short status (counts, the last and next run, whose team AI account the runs use, why it cannot run), Run now, off
// with a question first. Light and dark, a computer (1440) and a phone (390): nothing scrolls sideways, the status reads
// as lines, the switch and Run now stay reachable, no serious accessibility problem.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en

async function open(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/settings#file-list')
  await expect(page.getByTestId('file-list-status')).toBeVisible()
}

async function audit(page: Page, where: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))))
  const r = await new AxeBuilder({ page }).include('[data-testid="file-list"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('the status, Run now, and off after a question', async ({ page }) => {
  const errors = watchConsole(page)
  await open(page)
  const section = page.getByTestId('file-list')
  await expect(section.getByRole('heading', { level: 2 })).toHaveText(t['fileList.title'])
  await expect(page.getByTestId('file-list-counts')).toHaveText('1,240 files listed · 18 waiting to be read')
  await expect(page.getByTestId('file-list-uses')).toHaveText('Uses Claude Haiku on the team AI account “Team Claude”, signed in by Dana. Each night\'s run counts against its limit.')
  const sw = page.getByRole('checkbox', { name: t['fileList.title'] })
  await expect(sw).toBeChecked()
  // Run now: a run goes, then it is done (the mock ends it at the next status read)
  await page.getByTestId('file-list-run').click()
  await expect(page.getByTestId('file-list-running')).toBeVisible()
  await expect(page.getByTestId('file-list-run')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('file-list-counts')).toHaveText('1,258 files listed')
  // off asks first; cancelling keeps it on
  await sw.click({ force: true })
  await expect(page.getByTestId('dialog-confirm')).toHaveText(t['fileList.offConfirm'])
  await page.keyboard.press('Escape')
  await expect(sw).toBeChecked()
  await sw.click({ force: true })
  await page.getByTestId('dialog-confirm').click()
  await expect(sw).not.toBeChecked()
  await expect(page.getByTestId('file-list-off')).toHaveText(t['fileList.off'])
  await expect(page.getByTestId('file-list-run')).toHaveCount(0)
  // and on again
  await sw.click({ force: true })
  await expect(sw).toBeChecked()
  await expect(page.getByTestId('file-list-run')).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('why it cannot run: no team AI account, and the host turned it off', async ({ page }) => {
  await open(page)
  await page.request.post('/__test/file-list', { data: { problem: 'no_ai', signIn: null } })
  await page.reload()
  await expect(page.getByTestId('file-list-problem')).toHaveText(t['fileList.problem.no_ai'])
  await expect(page.getByTestId('file-list-run')).toBeDisabled()
  await page.request.post('/__test/file-list', { data: { problem: 'forced_off', forcedOff: true } })
  await page.reload()
  await expect(page.getByTestId('file-list-forced')).toHaveText(t['fileList.problem.forced_off'])
  await expect(page.getByRole('checkbox', { name: t['fileList.title'] })).toBeDisabled()
  await expect(page.getByTestId('file-list-run')).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`${scheme}, ${size.width} wide: readable lines, nothing sideways, reachable controls, no serious accessibility problem`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize(size)
      await open(page)
      const section = page.getByTestId('file-list')
      await section.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
      // the switch sits beside the heading; Run now and the switch are inside the screen
      const heading = await section.getByRole('heading', { level: 2 }).boundingBox()
      const knob = await section.locator('#file-list-enabled + span').boundingBox()
      expect(Math.abs(knob!.y - heading!.y)).toBeLessThan(24)
      expect(knob!.x + knob!.width).toBeLessThanOrEqual(size.width)
      const run = await page.getByTestId('file-list-run').boundingBox()
      expect(run!.x + run!.width).toBeLessThanOrEqual(size.width)
      // each status line is one item of the list, at the small body size (14 px on a computer, 15 on a phone)
      const lines = page.getByTestId('file-list-status').locator('li')
      await expect(lines).toHaveCount(3)
      expect(parseFloat(await lines.first().evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14)
      await audit(page, `file list (${scheme}, ${size.width})`)
      await section.screenshot({ path: test.info().outputPath(`file-list-${scheme}-${size.width}.png`) })
    })
  }
}
