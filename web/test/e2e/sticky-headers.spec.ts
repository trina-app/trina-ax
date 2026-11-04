// A page's title row stays at the top while the page scrolls (components/ui.tsx StickyHeader, PageHeader): MCP in
// Admin and Settings, Team skills, Projects and a project's page; Settings keeps its title and menu while only the page
// beside them scrolls. A title row gets its hairline once the page has scrolled, and the scrolling area keeps the row's
// height free for the keyboard, so a control that gets focus never hides under it.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en
const WIDE = { width: 1360, height: 560 }
const PHONE = { width: 390, height: 640 }

async function start(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
}

/** The area that scrolls `el`. */
const scroller = (el: Locator) => el.locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " overflow-y-auto ")][1]')

/** Scrolls the page under `header` to its end: the row is still at the area's top and in view. `line`: it shows its
 * hairline then (a title row; a full-width bar has its own line all along). */
async function staysPut(header: Locator, line = true) {
  await expect(header).toBeVisible()
  const box = scroller(header)
  expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight + 40)).toBe(true)
  if (line) await expect(header).not.toHaveAttribute('data-scrolled')
  await box.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect.poll(() => box.evaluate((el) => el.scrollTop)).toBeGreaterThan(40)
  await expect.poll(async () => Math.abs((await header.boundingBox())!.y - (await box.boundingBox())!.y)).toBeLessThanOrEqual(1)
  await expect(header).toBeInViewport()
  if (line) await expect(header).toHaveAttribute('data-scrolled', 'true')
  // the row's height is kept free at the top for the keyboard
  expect(await box.evaluate((el) => parseFloat(el.style.scrollPaddingTop))).toBeGreaterThanOrEqual((await header.boundingBox())!.height)
}

for (const [name, size] of [['wide', WIDE], ['phone', PHONE]] as const) {
  test(`MCP keeps its title row at the top in Admin and in Settings (${name})`, async ({ page }) => {
    await page.setViewportSize(size)
    await start(page)
    for (const path of ['/admin/integrations', '/settings/integrations']) {
      await page.goto(path)
      const header = page.getByTestId('connectors-header')
      await expect(header.getByRole('heading', { name: 'MCP' })).toBeVisible()
      await header.getByRole('tab', { name: t['integrations.tabDiscover'] }).click()
      await expect(page.getByTestId('connector-card').first()).toBeVisible()
      await staysPut(header)
      await expect(header.getByTestId('connector-search')).toBeInViewport()
      // a control that gets focus near the top scrolls into view below the row, not under it
      const first = page.getByTestId('connector-add').first()
      await first.evaluate((el) => (el as HTMLElement).focus())
      await expect(first).toBeFocused()
      await expect.poll(async () => (await first.boundingBox())!.y - ((await header.boundingBox())!.y + (await header.boundingBox())!.height)).toBeGreaterThanOrEqual(0)
    }
    // Settings: the title and the menu stay where they are; only the page beside the menu scrolls
    await expect(page.getByRole('heading', { level: 1, name: t['settings.title'] })).toBeInViewport()
    await expect(page.getByTestId('settings-menu')).toBeInViewport()
  })
}

test('Team skills keeps its title, tabs and search at the top while the list scrolls', async ({ page }) => {
  await start(page)
  for (const size of [{ width: 1360, height: 260 }, { width: 390, height: 420 }]) {
    await page.setViewportSize(size)
    await page.goto('/skills')
    const header = page.getByTestId('skills-header')
    await expect(header.getByTestId('skill-search')).toBeVisible()
    await staysPut(header)
    await expect(header.getByTestId('skill-search')).toBeInViewport()
  }
})

test("Projects and a project's page keep their top bar while the page scrolls", async ({ page }) => {
  await start(page)
  const post = (path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
  let id = ''
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const r = await post('/api/projects', { name: `Project ${n}`, scope: 'team', folderPath: `p${n}`, instructions: 'Short answers.' })
    expect(r.status()).toBe(201)
    id ||= ((await r.json()) as { id: string }).id
  }
  for (const size of [{ width: 1360, height: 300 }, { width: 390, height: 480 }]) {
    await page.setViewportSize(size)
    await page.goto('/projects')
    const bar = page.locator('[data-sticky-header]').filter({ has: page.getByRole('heading', { level: 1, name: t['projects.title'] }) })
    await expect(page.getByTestId('project-new')).toBeVisible()
    await staysPut(bar, false)
    await expect(page.getByTestId('project-new')).toBeInViewport()
    await page.goto(`/projects/${id}`)
    const top = page.getByTestId('project-topline')
    await expect(top.getByTestId('project-menu')).toBeVisible()
    await staysPut(top, false)
    await expect(top.getByTestId('project-menu')).toBeInViewport()
  }
})
