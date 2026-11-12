// The new navigation's switch in the mock (docs/AGENTS/plan/20261112-1839-nav-rail.md §5.1): off after every reset, as
// on a real server, so every other suite runs today's layout; `navRail()` turns it on and Me says so. Until the rail
// comes (phase P1) nothing on screen changes with it on.
import { expect, test, type Page } from '@playwright/test'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const me = async (page: Page) => ((await (await page.request.get('/api/me')).json()) as { server: { navRail?: true } }).server

test('off by default; on after the switch; off again after a reset; today\'s sidebar either way', async ({ page }) => {
  await reset(page)
  await signIn(page)
  expect((await me(page)).navRail).toBeUndefined()
  await navRail(page)
  expect((await me(page)).navRail).toBe(true)
  await page.reload()
  await expect(page.getByRole('navigation', { name: t['sidebar.label'] })).toBeVisible()
  await expect(page.getByTestId('rail-ai')).toHaveCount(0)
  await navRail(page, false)
  expect((await me(page)).navRail).toBeUndefined()
  await navRail(page)
  await reset(page)
  await signIn(page)
  expect((await me(page)).navRail).toBeUndefined()
})
