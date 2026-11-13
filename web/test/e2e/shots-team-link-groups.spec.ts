// Screenshots of the team link's groups (QA TC-458), 1440 and 390 wide, light and dark, for reviewing by eye: the
// Invite links row with "Joins: …", and the team link popup with "Change groups" open. Only when TEAM_LINK_GROUPS_SHOTS
// names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const dir = process.env.TEAM_LINK_GROUPS_SHOTS
test.skip(!dir, 'TEAM_LINK_GROUPS_SHOTS is not set')

async function setUp(page: Page) {
  await reset(page)
  await signIn(page)
  const h = { [CSRF_HEADER]: '1' }
  const leads = (await (await page.request.post('/api/admin/groups', { headers: h, data: { name: 'Leads' } })).json()) as { id: string }
  await page.request.post('/api/admin/groups', { headers: h, data: { name: 'Sales' } })
  await page.request.post('/api/admin/team-link', { headers: h, data: { groupIds: [leads.id] } })
}

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`team link groups screenshots (${vp.name}, ${scheme})`, async ({ page }) => {
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await setUp(page)
      await page.goto('/admin/members')
      const row = page.getByTestId('team-link-row')
      await expect(row).toBeVisible()
      await row.scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/a-row-${vp.name}-${scheme}.png`, fullPage: true })
      await row.getByTestId('member-more').click()
      await page.getByTestId('team-link-row-open').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('team-link-groups')).toBeVisible()
      await dialog.getByTestId('team-link-groups').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/b-popup-${vp.name}-${scheme}.png` })
      await dialog.getByTestId('team-link-groups-change').click()
      await dialog.getByTestId('team-link-groups-edit').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/c-change-groups-${vp.name}-${scheme}.png` })
    })
  }
}
