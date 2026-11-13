// The new navigation's switch in the mock (docs/DECISIONS.md "navRail"): on after every reset since P6, as on a real
// server, so a computer shows the rail; `navRail(page, false)` is the operator's kill switch: Me says nothing and the
// old sidebar comes back until P7 removes it.
import { expect, test, type Page } from '@playwright/test'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const me = async (page: Page) => ((await (await page.request.get('/api/me')).json()) as { server: { navRail?: true } }).server

test('on by default; off with the switch; on again after a reset; the rail only while on', async ({ page }) => {
  await reset(page)
  await signIn(page)
  expect((await me(page)).navRail).toBe(true)
  await page.reload()
  await expect(page.getByTestId('rail-ai')).toBeVisible()
  await expect(page.getByRole('navigation', { name: t['sidebar.label'] })).toHaveCount(0)
  await navRail(page, false)
  await page.reload()
  await expect(page.getByRole('navigation', { name: t['sidebar.label'] })).toBeVisible()
  await expect(page.getByTestId('rail-ai')).toHaveCount(0)
  expect((await me(page)).navRail).toBeUndefined()
  await reset(page)
  await signIn(page)
  expect((await me(page)).navRail).toBe(true)
})
